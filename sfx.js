// 音效與背景音樂：多數為 Web Audio 即時合成；動物死亡另用外部 die.mp3
import dieUrl from './die.mp3'
import musicUrl from './music.mp3'
let ctx = null, master = null, noiseBuf = null, musicGain = null
let dieBuf = null   // 解碼後的死亡音效 AudioBuffer
let lastDie = 0     // 上次播放死亡音的時間（去疊音）
let sfxVol = 1.0, musVol = 0.14   // 目前 gain（設定選單可調；ctx 尚未建立時先存著，initAudio 再套用）

// 設定音量：傳入 0~1 的滑桿比例
//   音效 → gain 0~2（比例 ×2，讓預設 0.5 對應 gain 1.0，比舊版大聲一倍，並保留到 2.0 的餘裕）
//   音樂 → gain 0~0.3（壓在音效之下，避免蓋過音效）
export function setSfxVolume(frac) { sfxVol = Math.max(0, Math.min(1, frac)) * 2; if (master) master.gain.value = sfxVol }
export function setMusicVolume(frac) { musVol = Math.max(0, Math.min(1, frac)) * 0.3; if (musicGain) musicGain.gain.value = musVol }

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  ctx = new AC()
  master = ctx.createGain(); master.gain.value = sfxVol; master.connect(ctx.destination)
  musicGain = ctx.createGain(); musicGain.gain.value = musVol; musicGain.connect(ctx.destination)  // 音樂壓在音效之下
  const len = Math.floor(ctx.sampleRate * 1.0)
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  loadDie()
  loadMusic()
}

// 載入並解碼 die.mp3（只做一次）；失敗時 sfx.die 會退回合成音
async function loadDie() {
  if (dieBuf || !ctx) return
  try {
    const res = await fetch(dieUrl)
    dieBuf = await ctx.decodeAudioData(await res.arrayBuffer())
  } catch (e) { console.warn('die.mp3 載入失敗，改用合成死亡音', e) }
}

const t0 = () => ctx.currentTime

// 單一振盪器音（可頻率滑音）
function blip({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, sweep = null, delay = 0 }) {
  if (!ctx) return
  const t = t0() + delay
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t)
  if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.03)
}

// 雜訊（可過濾 + 頻率滑音）—— 用來做撞擊/爆炸/風聲
function noise({ dur = 0.3, gain = 0.3, type = 'lowpass', freq = 1000, sweep = null, delay = 0 }) {
  if (!ctx) return
  const t = t0() + delay
  const src = ctx.createBufferSource(); src.buffer = noiseBuf
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t)
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(master); src.start(t); src.stop(t + dur + 0.03)
}

export const sfx = {
  throw() { noise({ dur: 0.26, gain: 0.22, type: 'bandpass', freq: 900, sweep: 280 }) },
  thud(v = 1) {
    const g = Math.min(0.5, 0.1 + v * 0.02)
    blip({ freq: 130, type: 'sine', dur: 0.12, gain: g, sweep: 65 })
    noise({ dur: 0.05, gain: g * 0.4, type: 'lowpass', freq: 400 })
  },
  // 積木碰撞：木箱＝清脆木頭敲擊；soft（紙箱/沙包）＝悶一點的低頻
  wood(v = 1, soft = false) {
    const g = Math.min(0.34, 0.06 + v * 0.02)
    if (soft) {
      blip({ freq: 150, type: 'sine', dur: 0.09, gain: g * 0.9, sweep: 80 })
      noise({ dur: 0.07, gain: g * 0.5, type: 'lowpass', freq: 500 })
    } else {
      blip({ freq: 240, type: 'square', dur: 0.06, gain: g * 0.5, sweep: 130 })
      noise({ dur: 0.06, gain: g, type: 'bandpass', freq: 1500, sweep: 700 })
    }
  },
  pop() {
    blip({ freq: 520, type: 'triangle', dur: 0.12, gain: 0.35, sweep: 950 })
    noise({ dur: 0.08, gain: 0.18, type: 'highpass', freq: 1200 })
  },
  // 一分多：分裂瞬間的清脆電光散射
  split() {
    blip({ freq: 520, type: 'triangle', dur: 0.14, gain: 0.3, sweep: 1200 })
    blip({ freq: 780, type: 'sine', dur: 0.1, gain: 0.18, sweep: 1500, delay: 0.02 })
    noise({ dur: 0.12, gain: 0.25, type: 'bandpass', freq: 2200, sweep: 900 })
  },
  // 連殺 Combo：音階隨連擊數往上疊，越多越高亢
  combo(n = 2) {
    const f = Math.min(1400, 440 * Math.pow(1.09, n))   // 每多一段升約一個半音、封頂
    blip({ freq: f, type: 'triangle', dur: 0.16, gain: 0.32, sweep: f * 1.5 })
    blip({ freq: f * 1.5, type: 'sine', dur: 0.1, gain: 0.14, delay: 0.02 })
  },
  // 連鎖閃電：高頻爆裂
  zap() {
    blip({ freq: 1600, type: 'sawtooth', dur: 0.16, gain: 0.28, sweep: 300 })
    noise({ dur: 0.18, gain: 0.32, type: 'highpass', freq: 3000, sweep: 1200 })
  },
  // 彈跳彈：Q 彈
  boing() {
    blip({ freq: 300, type: 'sine', dur: 0.18, gain: 0.3, sweep: 900 })
    blip({ freq: 900, type: 'sine', dur: 0.12, gain: 0.15, sweep: 260, delay: 0.06 })
  },
  // 召喚豬：厚重巨獸吼叫（發射瞬間）
  summon() {
    blip({ freq: 240, type: 'sawtooth', dur: 0.65, gain: 0.5, sweep: 55 })
    blip({ freq: 120, type: 'square', dur: 0.55, gain: 0.35, sweep: 40 })
    noise({ dur: 0.5, gain: 0.4, type: 'lowpass', freq: 900, sweep: 180 })
  },
  // 召喚豬衝刺撞擊：悶重低音（撞到東西時）
  stomp(v = 1) {
    const g = Math.min(0.55, 0.25 + v * 0.02)
    blip({ freq: 90, type: 'sine', dur: 0.16, gain: g, sweep: 38 })
    noise({ dur: 0.1, gain: g * 0.5, type: 'lowpass', freq: 300 })
  },
  // 動物死亡：播放 die.mp3（尚未載入完成則退回合成 pop）
  die() {
    if (!ctx) return
    if (!dieBuf) { this.pop(); return }
    const now = t0()
    if (now - lastDie < 0.05) return   // 同一瞬間多隻死亡只播一次，避免疊音爆音
    lastDie = now
    const src = ctx.createBufferSource(); src.buffer = dieBuf
    const g = ctx.createGain(); g.gain.value = 0.9
    src.connect(g).connect(master); src.start(now)
  },
  explode() {
    noise({ dur: 0.5, gain: 0.5, type: 'lowpass', freq: 1800, sweep: 110 })
    blip({ freq: 80, type: 'sine', dur: 0.45, gain: 0.5, sweep: 38 })
  },
  win() {
    const notes = [523, 659, 784, 1047]
    notes.forEach((f, i) => blip({ freq: f, type: 'triangle', dur: 0.32, gain: 0.28, delay: i * 0.11 }))
  },
  star(i) {
    const f = [0, 700, 900, 1200][i] || 900
    blip({ freq: f, type: 'sine', dur: 0.45, gain: 0.34 })
    blip({ freq: f * 2, type: 'sine', dur: 0.3, gain: 0.12 })
  },
  lose() {
    const notes = [440, 330, 220]
    notes.forEach((f, i) => blip({ freq: f, type: 'sawtooth', dur: 0.32, gain: 0.22, delay: i * 0.14 }))
  },
}

// ============================================================
//  背景音樂：外部 mp3 循環播放（透過 musicGain → 音量滑桿可調）
// ============================================================
let musicBuf = null, musicSrc = null, musicOn = false

async function loadMusic() {
  if (musicBuf || !ctx) return
  try {
    const res = await fetch(musicUrl)
    musicBuf = await ctx.decodeAudioData(await res.arrayBuffer())
    if (musicOn) startMusicSource()   // 若在解碼期間已按下播放，解好即接上
  } catch (e) { console.warn('背景音樂載入失敗', e) }
}
function startMusicSource() {
  if (!ctx || !musicBuf || musicSrc) return
  musicSrc = ctx.createBufferSource()
  musicSrc.buffer = musicBuf; musicSrc.loop = true
  musicSrc.connect(musicGain); musicSrc.start()
}
export const music = {
  start() {
    if (!ctx || musicOn) return
    musicOn = true
    if (musicBuf) startMusicSource(); else loadMusic()   // 尚未解碼 → 先觸發載入，好了會自動接上
  },
  stop() {
    musicOn = false
    if (musicSrc) { try { musicSrc.stop() } catch {} musicSrc.disconnect(); musicSrc = null }
  },
  get playing() { return musicOn },
}
