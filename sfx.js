// 音效與背景音樂：多數為 Web Audio 即時合成；動物死亡另用外部 die.mp3
import dieUrl from './die.mp3'
let ctx = null, master = null, noiseBuf = null, musicGain = null
let dieBuf = null   // 解碼後的死亡音效 AudioBuffer
let lastDie = 0     // 上次播放死亡音的時間（去疊音）

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  ctx = new AC()
  master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination)
  musicGain = ctx.createGain(); musicGain.gain.value = 0.14; musicGain.connect(ctx.destination)  // 音樂壓在音效之下
  const len = Math.floor(ctx.sampleRate * 1.0)
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  loadDie()
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
//  背景音樂：I–V–vi–IV 進行的循環（貝斯 + 琶音），前瞻排程
// ============================================================
// C 大調各音（Hz）
const A = 440, semitone = Math.pow(2, 1 / 12)
const hz = (n) => A * Math.pow(semitone, n)   // n = 相對 A4 的半音數
// 四小節和弦：C  G  Am  F（各給根音與三個和弦音）
const PROG = [
  { root: hz(-21), notes: [hz(-9), hz(-5), hz(0), hz(-5)] },   // C: C3 / C4 E4 G4 E4
  { root: hz(-14), notes: [hz(-2), hz(2), hz(5), hz(2)] },     // G: G3 / G4 B4 D5 B4
  { root: hz(-12), notes: [hz(0), hz(3), hz(7), hz(3)] },      // Am: A3 / C5 D#? -> A C E : hz(0)=C5,hz(3)=D#5.. 用 A4 C5 E5
  { root: hz(-17), notes: [hz(-4), hz(0), hz(3), hz(0)] },     // F: F3 / F4 A4 C5 A4
]
const BPM = 108, SPB = 2, secPerStep = 60 / BPM / SPB   // 八分音符
let musicOn = false, schedTimer = null, nextTime = 0, stepIdx = 0

function mNote(freq, time, dur, type, gain) {
  if (!ctx || !freq) return
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, time)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, time)
  g.gain.exponentialRampToValueAtTime(gain, time + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur)
  o.connect(g).connect(musicGain); o.start(time); o.stop(time + dur + 0.02)
}
function scheduleStep(time) {
  const bar = Math.floor(stepIdx / 8) % 4
  const s = stepIdx % 8
  const chord = PROG[bar]
  if (s % 4 === 0) mNote(chord.root, time, 0.42, 'triangle', 0.5)          // 貝斯（每半小節）
  mNote(chord.notes[s % chord.notes.length], time, secPerStep * 0.9, 'sine', 0.32)  // 琶音
  if (s === 0) mNote(chord.notes[2] * 2, time, secPerStep * 1.6, 'triangle', 0.14)  // 高音點綴
}
function scheduler() {
  if (!ctx) return
  while (nextTime < ctx.currentTime + 0.12) {
    scheduleStep(nextTime)
    nextTime += secPerStep
    stepIdx = (stepIdx + 1) % 32   // 4 小節 × 8 步循環
  }
}
export const music = {
  start() {
    if (!ctx || musicOn) return
    musicOn = true; stepIdx = 0; nextTime = ctx.currentTime + 0.1
    schedTimer = setInterval(scheduler, 25)
  },
  stop() {
    musicOn = false
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null }
  },
  get playing() { return musicOn },
}
