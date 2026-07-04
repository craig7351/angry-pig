import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'
import * as CANNON from 'cannon-es'
import { initAudio, sfx, music } from './sfx.js'

// ============================================================
//  第一人稱 3D 投擲遊戲（three.js 渲染 + cannon-es 3D 物理）
//  滑鼠環顧瞄準 → 按住蓄力 → 放開朝視線丟球 → 砸垮堡壘打爆所有豬
// ============================================================

const START_AMMO = 8
const CHARGE_TIME = 1.0            // 滿力所需秒數
const SPEED_MIN = 16, SPEED_MAX = 40
const EYE = new THREE.Vector3(0, 1.8, 9)   // 玩家眼睛位置（固定）
const PIG_GROUND_Y = 0.9                    // 豬中心低於此高度 → 視為落地死亡
// 開場運鏡：高空環繞關卡一圈 → 俯衝進第一人稱視角
const INTRO_DUR = 8.0
const ORBIT_CENTER = new THREE.Vector3(0, 3, -9)  // 環繞中心（關卡中央）
const ORBIT_R = 18, ORBIT_H = 13                  // 環繞半徑與高度

// ---- three ----
const canvas = document.getElementById('game')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
{
  const c = document.createElement('canvas'); c.width = 2; c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#6db8e8'); g.addColorStop(0.65, '#bfe3f5'); g.addColorStop(1, '#e8f4d8')
  ctx.fillStyle = g; ctx.fillRect(0, 0, 2, 256)
  scene.background = new THREE.CanvasTexture(c)
}
scene.fog = new THREE.Fog(0xbfe3f5, 30, 90)

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300)
camera.rotation.order = 'YXZ'
camera.position.copy(EYE)

scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6b3a, 1.0))
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2)
sun.position.set(-10, 20, 6)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 })
scene.add(sun)
scene.add(new THREE.AmbientLight(0xffffff, 0.3))

// 草地
{
  const grass = new THREE.Mesh(
    new THREE.BoxGeometry(120, 1, 120),
    new THREE.MeshStandardMaterial({ color: 0x7cae4a, roughness: 1 })
  )
  grass.position.y = -0.5
  grass.receiveShadow = true
  scene.add(grass)
}

// ---- cannon 世界 ----
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
world.broadphase = new CANNON.SAPBroadphase(world)
world.allowSleep = true
world.solver.iterations = 12

const matGround = new CANNON.Material('ground')
const matBox = new CANNON.Material('box')
const matBall = new CANNON.Material('ball')
world.addContactMaterial(new CANNON.ContactMaterial(matBox, matGround, { friction: 0.5, restitution: 0.1 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBox, matBox, { friction: 0.5, restitution: 0.05 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matBox, { friction: 0.3, restitution: 0.3 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matGround, { friction: 0.3, restitution: 0.4 }))

// 地面剛體（豬碰到它就算死）
const groundBody = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Plane() })
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
world.addBody(groundBody)

// ---- 資產 ----
const loader = new GLTFLoader()
const ASSETS = {
  crate: 'assets/Crate.gltf',
  cardboard: 'assets/CardboardBoxes_1.gltf',
  barrel: 'assets/ExplodingBarrel.gltf',
  pig: 'assets/Pig.gltf',
  sheep: 'assets/Sheep.gltf',
  chicken: 'assets/Chicken.gltf',
  cat: 'assets/Cat.gltf',
  dog: 'assets/Dog.gltf',
  raccoon: 'assets/Raccoon.gltf',
  wolf: 'assets/Wolf.gltf',
  horse: 'assets/Horse.gltf',
  chick: 'assets/Chick.gltf',
  plank: 'assets/WoodPlanks.gltf',
  brick: 'assets/BrickWall_2.gltf',
  container: 'assets/Container_Small.gltf',
  sack: 'assets/SackTrench.gltf',
  gastank: 'assets/GasTank.gltf',
}
const protos = {}
const animClips = {}   // 各動物的動畫片段
async function loadAll() {
  await Promise.all(Object.entries(ASSETS).map(async ([k, url]) => {
    const gltf = await loader.loadAsync(url)
    protos[k] = gltf.scene
    if (isAnimal(k)) animClips[k] = gltf.animations || []
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  }))
}
function measure(obj) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3(); box.getSize(size)
  const center = new THREE.Vector3(); box.getCenter(center)
  return { size, center }
}

const TYPE = {
  crate:     { targetH: 1.2, mass: 1.2, mat: matBox },
  cardboard: { targetH: 1.1, mass: 0.4, mat: matBox },
  barrel:    { targetH: 1.4, mass: 1.0, mat: matBox, sphere: true, explosive: 4.0 },
  // 動物目標（皆為骨架 + Idle 動畫，被撞下箱子落地即消滅）
  pig:       { targetH: 1.10, mass: 0.8, mat: matBox, animal: true },
  sheep:     { targetH: 1.15, mass: 0.9, mat: matBox, animal: true },
  chicken:   { targetH: 0.80, mass: 0.5, mat: matBox, animal: true },
  cat:       { targetH: 0.90, mass: 0.6, mat: matBox, animal: true },
  dog:       { targetH: 1.00, mass: 0.8, mat: matBox, animal: true },
  raccoon:   { targetH: 1.00, mass: 0.7, mat: matBox, animal: true },
  wolf:      { targetH: 1.25, mass: 1.0, mat: matBox, animal: true },
  horse:     { targetH: 1.70, mass: 1.4, mat: matBox, animal: true },
  chick:     { targetH: 0.55, mass: 0.35, mat: matBox, animal: true },
  // 新建材（用 scale 保留原始比例）
  plank:     { scale: 1.35, mass: 0.5, mat: matBox, faceRotateY: Math.PI / 2 }, // 木樑，橫躺
  brick:     { scale: 1.30, mass: 1.6, mat: matBox },                            // 磚牆段
  container: { scale: 1.05, mass: 6.0, mat: matBox },                            // 貨櫃，重底座
  sack:      { scale: 0.90, mass: 3.5, mat: matBox },                            // 沙包掩體
  gastank:   { scale: 1.25, mass: 1.2, mat: matBox, explosive: 5.5 },            // 瓦斯桶，大爆炸
}

const isAnimal = (type) => !!(TYPE[type] && TYPE[type].animal)
// 目標動物輪替池：讓每關自動出現多種動物
const ANIMAL_POOL = ['pig', 'sheep', 'chicken', 'cat', 'dog', 'raccoon', 'wolf', 'chick', 'horse']
let animIdx = 0
function nextAnimal() { return ANIMAL_POOL[animIdx++ % ANIMAL_POOL.length] }

// 正規化模型：套朝向→量測 footprint→置中；回傳 wrap 與半尺寸
function makeVisual(type) {
  const cfg = TYPE[type]
  const proto = protos[type]
  const inst = isAnimal(type) ? skeletonClone(proto) : proto.clone(true)
  const raw = measure(proto)
  const scale = cfg.scale != null ? cfg.scale : cfg.targetH / (raw.size.y || 1)
  const holder = new THREE.Group()
  holder.add(inst); holder.scale.setScalar(scale)
  if (cfg.faceRotateY) holder.rotation.y = cfg.faceRotateY
  const box = new THREE.Box3().setFromObject(holder)
  const size = new THREE.Vector3(); box.getSize(size)
  const center = new THREE.Vector3(); box.getCenter(center)
  holder.position.sub(center)
  const wrap = new THREE.Group(); wrap.add(holder)
  return { wrap, hx: size.x / 2, hy: size.y / 2, hz: size.z / 2 }
}

const entities = []   // { body, group, type, hp, mixer?, dead?, popping? }

// 放置一個物體，x/z 為中心水平座標，bottomY 為底部高度；回傳頂部 Y
function addBody(type, x, z, bottomY) {
  const cfg = TYPE[type]
  const { wrap, hx, hy, hz } = makeVisual(type)
  const cy = bottomY + hy
  let shape
  if (cfg.sphere) shape = new CANNON.Sphere(Math.max(hx, hz))
  else shape = new CANNON.Box(new CANNON.Vec3(hx, hy, hz))
  const body = new CANNON.Body({ mass: cfg.mass, material: cfg.mat, shape })
  body.position.set(x, cy, z)
  body.allowSleep = true; body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.6
  world.addBody(body)
  scene.add(wrap)
  const ent = { body, group: wrap, type, hp: isAnimal(type) ? 100 : (cfg.explosive ? 45 : 1e9) }
  if (isAnimal(type) && animClips[type] && animClips[type].length) {
    ent.mixer = new THREE.AnimationMixer(wrap)
    const clips = animClips[type]
    const idle = clips.find((c) => /idle/i.test(c.name)) || clips[0]
    ent.mixer.clipAction(idle).play()
  }
  body._ent = ent
  // 爆裂物（桶 / 瓦斯桶）：受到夠強的撞擊就引爆（豬的死亡改由落地高度判定）
  if (cfg.explosive) {
    body.addEventListener('collide', (e) => {
      if (ent.dead || !game || !game.armed) return   // 開場沉降期間免疫，避免被掉落積木誤引爆
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
      if (v > 6) { ent.hp -= v * 6; if (ent.hp <= 0) { ent.dead = true; ent.popping = 0; explode(body.position, cfg.explosive); game.score += 500 } }
    })
  }
  entities.push(ent)
  return cy + hy
}

function killAnimal(e) {
  if (e.dead) return
  e.dead = true; e.popping = 0
  game.score += 5000; game.pigs--
  sfx.pop()
  refreshHUD()
}

// 爆炸桶
const flashes = []
function explode(pos, R = 4) {
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9 }))
  flash.position.copy(pos); scene.add(flash); flashes.push({ mesh: flash, t: 0 })
  sfx.explode()
  for (const e of entities) {
    if (e.dead) continue
    const d = e.body.position.distanceTo(pos)
    if (d > R || d < 0.01) continue
    const f = 1 - d / R
    const dir = e.body.position.vsub(pos); dir.normalize()
    e.body.wakeUp()
    e.body.applyImpulse(new CANNON.Vec3(dir.x * f * 14 * e.body.mass, (dir.y * f + f) * 10 * e.body.mass, dir.z * f * 14 * e.body.mass), new CANNON.Vec3(0, 0, 0))
    // 爆炸只負責把豬炸飛，落地後才判定死亡
  }
}

// ---- 砲彈 ----
const balls = []
let lastThud = 0
function playThud(v) {
  const t = performance.now()
  if (t - lastThud > 55) { lastThud = t; sfx.thud(v) }
}
function throwBall(power) {
  const dir = new THREE.Vector3()
  camera.getWorldDirection(dir)
  const start = camera.position.clone().addScaledVector(dir, 1.2)
  const r = 0.35
  const group = new THREE.Group()
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.35 }))
  m.castShadow = true; group.add(m)
  scene.add(group)
  const body = new CANNON.Body({ mass: 3, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(start.x, start.y, start.z)
  const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed)
  world.addBody(body)
  const ent = { body, group, type: 'ball', hp: 1e9, born: 0 }
  body._ent = ent
  // 球只負責用物理把豬撞下箱子；豬是否死亡改由「碰到地板」判定
  body.addEventListener('collide', (e) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
    if (v > 2.5) playThud(v)
  })
  balls.push(ent)
  entities.push(ent)
}

// ---- 瞄準拋物線預測 ----
const trajDots = []
{
  const geo = new THREE.SphereGeometry(0.08, 8, 6)
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false })
  for (let i = 0; i < 30; i++) { const d = new THREE.Mesh(geo, mat); d.visible = false; d.renderOrder = 999; scene.add(d); trajDots.push(d) }
}
function showTrajectory(power) {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir)
  const p = camera.position.clone().addScaledVector(dir, 1.2)
  const v = dir.clone().multiplyScalar(SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power)
  const g = -9.82, dt = 1 / 30
  let di = 0
  for (let s = 0; s < 30 * 3 && di < trajDots.length; s++) {
    v.y += g * dt; p.addScaledVector(v, dt)
    if (p.y < 0) break
    if (s % 3 === 0) {
      const d = trajDots[di++]
      d.position.copy(p); d.visible = true
      d.scale.setScalar(1 - di / trajDots.length * 0.6)
    }
  }
  for (; di < trajDots.length; di++) trajDots[di].visible = false
}
function hideTrajectory() { for (const d of trajDots) d.visible = false }

// ============================================================
//  關卡
// ============================================================
let game
let currentLevel = 0
// 各關最佳星數（存 localStorage，重開也記得）
const STARS_KEY = 'fps3d_stars_v2'
function loadStars() { try { const a = JSON.parse(localStorage.getItem(STARS_KEY)); return Array.isArray(a) ? a : [] } catch { return [] } }
function saveStars() { try { localStorage.setItem(STARS_KEY, JSON.stringify(levelStars)) } catch {} }
const levelStars = loadStars()
const hud = {
  score: document.getElementById('score'), ammo: document.getElementById('ammo'),
  pigs: document.getElementById('pigs'), power: document.getElementById('power-fill'),
  level: document.getElementById('level'),
  msg: document.getElementById('msg'), msgTitle: document.getElementById('msg-title'),
  msgText: document.getElementById('msg-text'), stars: document.getElementById('stars'),
  next: document.getElementById('next'),
}
function refreshHUD() {
  if (!game) return
  hud.score.textContent = game.score
  hud.ammo.textContent = '🔴'.repeat(Math.max(0, game.ammo))
  hud.pigs.textContent = '🐾 ' + Math.max(0, game.pigs)
  hud.level.textContent = `關卡 ${currentLevel + 1}／${LEVELS.length}`
}

function clearWorld() {
  for (const e of entities) { world.removeBody(e.body); scene.remove(e.group) }
  entities.length = 0; balls.length = 0
  flashes.forEach((f) => scene.remove(f.mesh)); flashes.length = 0
}

// 從 base 高度往上疊 n 個某型積木，回傳頂部高度
function stack(type, x, z, n, base = 0) {
  let top = base
  for (let i = 0; i < n; i++) top = addBody(type, x, z, top)
  return top
}
const column = (x, z, n, base = 0) => stack('crate', x, z, n, base)          // 木箱柱
const pigColumn = (x, z, n) => addBody(nextAnimal(), x, z, column(x, z, n))  // 動物站柱頂（自動輪替種類）
const barrelColumn = (x, z, n) => addBody('barrel', x, z, column(x, z, n))   // 桶放柱頂
// 在多根相鄰柱子上架一根樑，回傳樑頂高度（可再站豬）
function beam(type, x, z, colXs, n) {
  let colTop = 0
  for (const cx of colXs) colTop = Math.max(colTop, column(cx, z, n))
  return addBody(type, x, z, colTop)
}

// ---- 關卡定義（10 關，難度與建築複雜度遞增）----
const LEVELS = [
  {
    name: '暖身', ammo: 6, build() {
      pigColumn(-3, -8, 2); pigColumn(0, -8, 2); pigColumn(3, -8, 2)
    }
  },
  {
    name: '堡壘', ammo: 7, build() {
      pigColumn(-3.2, -8, 3); pigColumn(3.2, -8, 3)
      pigColumn(-1.6, -11, 2); pigColumn(1.6, -11, 2); pigColumn(0, -13, 3)
      for (const x of [-3, 0, 3]) addBody('brick', x, -6.5, 0)   // 磚牆掩護（間距 3，磚寬 ~2.9 不重疊）
      barrelColumn(0, -9.5, 4)                                    // 中央爆炸塔
    }
  },
  {
    name: '木樑', ammo: 8, build() {
      // 豬站實心木箱柱；木樑橫放在前方當矮掩體（不再讓豬站在薄樑上）
      pigColumn(-3, -9, 2); pigColumn(0, -9, 3); pigColumn(3, -9, 2)
      pigColumn(-1.5, -12, 2); pigColumn(1.5, -12, 2)
      for (const x of [-2, 0, 2]) addBody('plank', x, -6.5, 0)   // 前排橫放木樑
      barrelColumn(0, -14, 3)
    }
  },
  {
    name: '紙牆', ammo: 7, build() {
      pigColumn(-2.6, -9, 3); pigColumn(2.6, -9, 3); pigColumn(0, -11, 4)
      for (const x of [-2.6, 0, 2.6]) stack('cardboard', x, -6.5, 2)  // 紙箱牆
      barrelColumn(0, -8.5, 2)
    }
  },
  {
    name: '磚壘', ammo: 8, build() {
      stack('brick', -2, -9, 3); stack('brick', 2, -9, 3)   // 兩道磚牆
      pigColumn(-2, -11, 2); pigColumn(2, -11, 2); pigColumn(0, -12, 3); pigColumn(0, -14, 2)
      addBody('gastank', 0, -7, 0)                            // 前方瓦斯桶（放前方，不與磚牆重疊）
    }
  },
  {
    name: '金字塔', ammo: 8, build() {
      const xs = [-2.4, -1.2, 0, 1.2, 2.4], hs = [1, 2, 3, 2, 1]
      const t = xs.map((x, i) => column(x, -9, hs[i]))
      addBody(nextAnimal(), -2.4, -9, t[0]); addBody(nextAnimal(), 2.4, -9, t[4])
      addBody(nextAnimal(), -1.2, -9, t[1]); addBody(nextAnimal(), 1.2, -9, t[3])
      addBody('barrel', 0, -9, t[2])
    }
  },
  {
    name: '雙塔', ammo: 9, build() {
      pigColumn(-4, -9, 5); pigColumn(4, -9, 5)
      pigColumn(0, -8, 3); pigColumn(-2, -12, 2); pigColumn(2, -12, 2); pigColumn(0, -14, 2)
      for (const x of [-3, -1, 1, 3]) column(x, -6, 2)
      barrelColumn(-2, -10, 3); barrelColumn(2, -10, 3)
    }
  },
  {
    name: '貨櫃堡', ammo: 10, build() {
      const L = addBody('container', -2.6, -10, 0)          // 貨櫃重底座
      const R = addBody('container', 2.6, -10, 0)
      addBody(nextAnimal(), -2.6, -10, column(-2.6, -10, 1, L))    // 櫃頂加木箱 + 豬
      addBody(nextAnimal(), 2.6, -10, column(2.6, -10, 1, R))
      addBody(nextAnimal(), 0, -10, column(0, -10, 3))             // 中央木箱塔 + 豬
      pigColumn(-1.5, -13, 2); pigColumn(1.5, -13, 2)       // 後排
      for (const x of [-3, 0, 3]) addBody('sack', x, -6.5, 0)  // 沙包掩體（間距 3，不重疊）
      addBody('gastank', -4.8, -9, 0)                       // 側翼瓦斯桶
      addBody(nextAnimal(), 4.5, -9, column(4.5, -9, 2))
    }
  },
  {
    name: '沙包陣地', ammo: 11, build() {
      for (const x of [-3, 0, 3]) addBody('sack', x, -6, 0)     // 前線沙包
      stack('brick', -2, -9, 3); stack('brick', 2, -9, 3)      // 第二道磚牆
      pigColumn(-3, -11, 2); pigColumn(0, -11, 3); pigColumn(3, -11, 2)
      pigColumn(-1.5, -13, 2); pigColumn(1.5, -13, 2); pigColumn(0, -15, 2)
      barrelColumn(0, -9, 2); addBody('gastank', -4.2, -9, 0); addBody('gastank', 4.2, -9, 0)  // 瓦斯桶移到磚牆外側
    }
  },
  {
    name: '終局要塞', ammo: 13, build() {
      // 貨櫃底座 + 櫃頂豬
      const L = addBody('container', -3.5, -11, 0)
      const R = addBody('container', 3.5, -11, 0)
      addBody(nextAnimal(), -3.5, -11, column(-3.5, -11, 1, L))
      addBody(nextAnimal(), 3.5, -11, column(3.5, -11, 1, R))
      // 中央堡台：三柱等高，炸桶夾在中央柱頂（穩，不會滾落誤爆）
      const xs = [-1.5, 0, 1.5], hs = [3, 3, 3]
      const t = xs.map((x, i) => column(x, -13, hs[i]))
      addBody(nextAnimal(), -1.5, -13, t[0]); addBody('barrel', 0, -13, t[1]); addBody(nextAnimal(), 1.5, -13, t[2])
      // 前排豬（站實心木箱柱，穩；外移避開瓦斯桶）
      pigColumn(-2.9, -9, 2); pigColumn(2.9, -9, 2)
      // 前線沙包 + 橫放木樑 + 雙瓦斯桶
      for (const x of [-3, 0, 3]) addBody('sack', x, -6.5, 0)
      for (const x of [-1.5, 1.5]) addBody('plank', x, -7.8, 0)
      addBody('gastank', -1.5, -9, 0); addBody('gastank', 1.5, -9, 0)
      // 縱深後排
      pigColumn(-1, -16, 3); pigColumn(1, -16, 3)
    }
  },
]

function resetGame(idx) {
  currentLevel = Math.max(0, Math.min(LEVELS.length - 1, idx))
  clearWorld()
  const L = LEVELS[currentLevel]
  game = { score: 0, ammo: L.ammo, ammoStart: L.ammo, pigs: 0, over: false, cooldown: 0, emptyT: 0, startT: 0, armed: false, intro: true, introT: 0 }
  hud.msg.classList.add('hidden')
  animIdx = currentLevel * 3                    // 每關從不同動物起輪替，增加跨關變化（可重現）
  L.build()
  game.pigs = entities.filter((e) => isAnimal(e.type)).length
  refreshHUD()
  updateIntroCamera(0)   // 擺到環繞起點
}

// 依「剩餘彈藥比例」給 1~3 星：省越多球評價越高
function calcStars() {
  const ratio = game.ammo / game.ammoStart
  return ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1
}

function win() {
  if (game.over) return
  game.over = true
  game.score += game.ammo * 1000
  const stars = calcStars()
  levelStars[currentLevel] = Math.max(levelStars[currentLevel] || 0, stars)
  saveStars()
  const last = currentLevel >= LEVELS.length - 1
  hud.msgTitle.textContent = last ? '🏆 全破！' : '🎉 過關！'
  hud.msgText.textContent = `得分 ${game.score}（剩餘彈藥 +${game.ammo * 1000}）`
  // 星星：先全部顯示為空，再依序點亮 + 音效
  hud.stars.innerHTML = ''
  const els = []
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('span'); s.className = 'star'; s.textContent = '★'
    hud.stars.appendChild(s); els.push(s)
  }
  sfx.win()
  for (let i = 0; i < stars; i++) {
    setTimeout(() => { els[i].classList.add('on'); sfx.star(i + 1) }, 450 + i * 380)
  }
  hud.next.style.display = last ? 'none' : ''
  hud.msg.classList.remove('hidden')
  refreshHUD(); exitLock()
}
function lose() {
  if (game.over) return
  game.over = true
  hud.msgTitle.textContent = '💥 彈藥用盡'
  hud.msgText.textContent = `還剩 ${game.pigs} 隻動物。得分 ${game.score}`
  hud.stars.innerHTML = ''
  hud.next.style.display = 'none'
  sfx.lose()
  hud.msg.classList.remove('hidden'); exitLock()
}

// ---- 關卡選擇畫面 ----
function levelUnlocked(i) { return i === 0 || (levelStars[i - 1] || 0) >= 1 }

function buildLevelSelect() {
  const list = document.getElementById('level-list')
  list.innerHTML = ''
  LEVELS.forEach((L, i) => {
    const unlocked = levelUnlocked(i)
    const got = levelStars[i] || 0
    const btn = document.createElement('button')
    btn.className = 'level-card' + (unlocked ? '' : ' locked')
    let stars = ''
    for (let s = 0; s < 3; s++) stars += `<span class="cs${s < got ? ' on' : ''}">★</span>`
    btn.innerHTML =
      `<div class="lv-num">${unlocked ? (i + 1) : '🔒'}</div>` +
      `<div class="lv-name">${L.name}</div>` +
      `<div class="lv-stars">${stars}</div>`
    if (unlocked) btn.addEventListener('click', () => startLevel(i))
    else btn.disabled = true
    list.appendChild(btn)
  })
}

function showMenu() {
  exitLock()
  hud.msg.classList.add('hidden')
  buildLevelSelect()
  updateMusicBtn()
  overlay.classList.remove('hidden')
}

function startLevel(idx) {
  initAudio()
  if (musicEnabled) music.start()
  resetGame(idx)
  overlay.classList.add('hidden')
  hud.msg.classList.add('hidden')
  canvas.requestPointerLock()
}

// ---- 背景音樂開關（記憶偏好）----
let musicEnabled = localStorage.getItem('fps3d_music') !== 'off'
function updateMusicBtn() {
  const b = document.getElementById('music-toggle')
  if (b) b.textContent = musicEnabled ? '🔊 音樂：開' : '🔇 音樂：關'
}
function toggleMusic() {
  musicEnabled = !musicEnabled
  localStorage.setItem('fps3d_music', musicEnabled ? 'on' : 'off')
  if (musicEnabled) { initAudio(); music.start() } else music.stop()
  updateMusicBtn()
}

// ============================================================
//  第一人稱控制（指標鎖定）
// ============================================================
let locked = false, yaw = 0, pitch = -0.05
let charging = false, chargeT = 0
const overlay = document.getElementById('overlay')
const SENS = 0.0022

function exitLock() { if (document.pointerLockElement) document.exitPointerLock() }
document.getElementById('retry').addEventListener('click', () => startLevel(currentLevel))
document.getElementById('next').addEventListener('click', () => startLevel(currentLevel + 1))
for (const id of ['to-menu', 'to-menu2']) {
  const el = document.getElementById(id)
  if (el) el.addEventListener('click', showMenu)
}
document.getElementById('music-toggle').addEventListener('click', toggleMusic)
document.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') toggleMusic() })

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas
  if (!locked) {
    charging = false; hideTrajectory(); hud.power.style.width = '0%'
    // 遊戲進行中放開滑鼠（Esc）→ 回到選單；勝負畫面則維持 msg
    if (!game || !game.over) showMenu()
  } else {
    overlay.classList.add('hidden')
  }
})
document.addEventListener('mousemove', (e) => {
  if (!locked || (game && game.intro)) return
  yaw -= e.movementX * SENS
  pitch -= e.movementY * SENS
  pitch = Math.max(-1.45, Math.min(1.0, pitch))
  camera.rotation.y = yaw; camera.rotation.x = pitch
})
canvas.addEventListener('mousedown', (e) => {
  if (!locked || game.over || e.button !== 0) return
  if (game.intro) { endIntro(); return }   // 開場運鏡中點一下 → 直接跳過
  if (game.ammo <= 0 || game.cooldown > 0) return
  charging = true; chargeT = 0
})
window.addEventListener('mouseup', (e) => {
  if (!charging || e.button !== 0) return
  const power = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
  charging = false; hideTrajectory(); hud.power.style.width = '0%'
  throwBall(power)
  sfx.throw()
  game.ammo--; game.cooldown = 0.45; refreshHUD()
})

// ---- 開場運鏡 ----
function fpsForward() {
  return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}
const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
function updateIntroCamera(kRaw) {
  const k = Math.max(0, Math.min(1, kRaw))
  if (k < 0.7) {
    // 環繞一圈，結束於正前方高處（a: π/2 → π/2 + 2π）
    const a = Math.PI / 2 + (k / 0.7) * Math.PI * 2
    camera.position.set(ORBIT_CENTER.x + Math.cos(a) * ORBIT_R, ORBIT_H, ORBIT_CENTER.z + Math.sin(a) * ORBIT_R)
    camera.lookAt(ORBIT_CENTER)
  } else {
    // 從正前方高處俯衝到玩家視角（起點與環繞終點相接，無跳動）
    const e = smoothstep((k - 0.7) / 0.3)
    const frontHigh = new THREE.Vector3(ORBIT_CENTER.x, ORBIT_H, ORBIT_CENTER.z + ORBIT_R)
    camera.position.lerpVectors(frontHigh, EYE, e)
    const look = new THREE.Vector3().lerpVectors(ORBIT_CENTER, EYE.clone().add(fpsForward()), e)
    camera.lookAt(look)
  }
}
function endIntro() {
  if (!game || !game.intro) return
  game.intro = false
  game.startT = 0; game.armed = false      // 落地判定的緩衝從這一刻起算
  camera.position.copy(EYE)
  camera.rotation.set(pitch, yaw, 0)
}

// ============================================================
//  主迴圈
// ============================================================
const clock = new THREE.Clock()
let acc = 0
const FIXED = 1 / 60

function loop() {
  requestAnimationFrame(loop)
  const dt = Math.min(clock.getDelta(), 0.05)

  if (game && !game.over) {
    // 物理固定步進（開場與遊戲中都跑，讓堆疊自然穩定）
    acc += dt
    let n = 0
    while (acc >= FIXED && n < 5) { world.step(FIXED); acc -= FIXED; n++ }

    if (game.intro) {
      // 開場運鏡：高空俯瞰 → 降到第一人稱
      game.introT += dt
      updateIntroCamera(game.introT / INTRO_DUR)
      if (game.introT >= INTRO_DUR) endIntro()
    } else {
      if (game.cooldown > 0) game.cooldown -= dt
      if (charging) {
        chargeT += dt
        const power = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
        hud.power.style.width = (power * 100) + '%'
        showTrajectory(power)
      }
      // 起始緩衝：等堆疊穩定後才開始判定豬落地（避免開場晃動誤殺）
      game.startT += dt
      if (!game.armed && game.startT > 1.5) game.armed = true
      // 豬落地判定：中心高度掉到接近地面就算死
      if (game.armed) {
        for (const e of entities) {
          if (isAnimal(e.type) && !e.dead && e.body.position.y < PIG_GROUND_Y) killAnimal(e)
        }
      }
      // 彈藥用盡且場面靜止 → 判負
      if (game.ammo <= 0 && game.pigs > 0) {
        game.emptyT += dt
        if (game.emptyT > 4) lose()
      }
    }
  }

  // 同步 + 動畫 + 清理
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]
    e.group.position.copy(e.body.position)
    e.group.quaternion.copy(e.body.quaternion)
    if (e.mixer) e.mixer.update(dt)
    if (e.type === 'ball') {
      e.born += dt
      if (e.born > 7 || e.body.position.y < -8) { world.removeBody(e.body); scene.remove(e.group); entities.splice(i, 1); const bi = balls.indexOf(e); if (bi >= 0) balls.splice(bi, 1) }
    }
    if (e.dead && e.popping !== undefined) {
      e.popping += dt
      const k = Math.max(0, 1 - e.popping / 0.35)
      e.group.scale.setScalar(k)
      if (k <= 0.001 && !e.removed) { e.removed = true; world.removeBody(e.body); scene.remove(e.group); entities.splice(i, 1) }
    }
  }
  if (game && !game.over && game.pigs <= 0) win()

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]; f.t += dt
    f.mesh.scale.setScalar(1 + f.t * 16); f.mesh.material.opacity = Math.max(0, 0.9 - f.t * 2.5)
    if (f.t > 0.4) { scene.remove(f.mesh); flashes.splice(i, 1) }
  }

  renderer.render(scene, camera)
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h; camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)

loadAll().then(() => {
  resize()
  camera.rotation.set(pitch, yaw, 0)
  buildLevelSelect()
  showMenu()
  loop()
  document.getElementById('loading').remove()
}).catch((err) => { document.getElementById('loading').textContent = '載入失敗：' + err; console.error(err) })
