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
const WIN_DELAY = 3.0              // 打完最後一隻後延遲跳過關畫面的秒數（讓玩家看清最後得分）
const CHARGE_TIME = 1.0            // 滿力所需秒數
const SPEED_MIN = 16, SPEED_MAX = 40
const EYE = new THREE.Vector3(0, 1.8, 9)   // 玩家眼睛位置（固定）
const GROUND_MARGIN = 0.4                   // 動物中心低於「自身半高 + 此緩衝」→ 視為落地死亡（依每隻大小判定，馬也準）
// 開場運鏡：高空環繞關卡一圈 → 俯衝進第一人稱視角
const INTRO_DUR = 8.0
const ORBIT_CENTER = new THREE.Vector3(0, 3, -9)  // 環繞中心（關卡中央）
const ORBIT_R = 18, ORBIT_H = 13                  // 環繞半徑與高度

// 觸控裝置（手機/平板）：降低解析度與陰影負擔，減少發熱耗電
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
if (IS_TOUCH) document.body.classList.add('touch')

// ---- three ----
const canvas = document.getElementById('game')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH })   // 手機關 MSAA（配合降 DPR 省電）
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
// 卡通鮮豔氛圍：ACES 色調映射 + 略微提亮曝光，讓草地天空更有層次
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.08

const scene = new THREE.Scene()
{
  // 鮮豔卡通天空：飽和藍 → 淺藍 → 地平線暖白
  const c = document.createElement('canvas'); c.width = 2; c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#3f9fe6'); g.addColorStop(0.55, '#8fd0f2'); g.addColorStop(1, '#e9f6d6')
  ctx.fillStyle = g; ctx.fillRect(0, 0, 2, 256)
  const skyTex = new THREE.CanvasTexture(c)
  skyTex.colorSpace = THREE.SRGBColorSpace
  scene.background = skyTex
}
scene.fog = new THREE.Fog(0xcfeaf5, 45, 150)

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400)
camera.rotation.order = 'YXZ'
camera.position.copy(EYE)

scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x6b7a3a, 0.95))
const sun = new THREE.DirectionalLight(0xfff0d0, 2.7)
sun.position.set(-12, 22, 8)
sun.castShadow = true
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048)
sun.shadow.bias = -0.0004
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 })
scene.add(sun)
scene.add(new THREE.AmbientLight(0xffffff, 0.32))

// ============================================================
//  環境（草地 / 泥土戰場 / 遠山 / 雲 / 樹 / 場地圍欄）
//  全部一次性加進 scene，clearWorld 不會清掉，跨關保留
// ============================================================
const clouds = []   // { mesh, speed }，主迴圈裡緩慢飄移

// 程序草地貼圖：飽和綠 + 割草條紋 + 細噪點（卡通鮮豔）
function makeGrassTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#57b53a'; ctx.fillRect(0, 0, s, s)
  // 割草條紋（明暗交替的直向色帶）
  const stripes = 4, sw = s / stripes
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? '#63c043' : '#4fa833'
    ctx.fillRect(i * sw, 0, sw, s)
  }
  // 細噪點：亮綠與暗綠小點增加質感
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * s, y = Math.random() * s
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(120,200,80,0.35)' : 'rgba(40,110,30,0.30)'
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(48, 48)
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return tex
}

// 程序泥土貼圖：中央實心、邊緣羽化透明，鋪在堡壘下方當戰場
function makeDirtTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.18, s / 2, s / 2, s * 0.5)
  g.addColorStop(0, 'rgba(150,110,70,1)'); g.addColorStop(0.7, 'rgba(135,98,60,0.95)')
  g.addColorStop(1, 'rgba(120,90,55,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s)
  // 碎石與土色斑點
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * s * 0.46
    const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(90,64,40,0.5)' : 'rgba(180,150,110,0.45)'
    const d = 1 + Math.random() * 2.5; ctx.fillRect(x, y, d, d)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// 把裝飾模型（fence/barrier/cone）縮到目標高度後複製一份靜態放進場景
function placeProp(type, x, z, rotY = 0, targetH = 1.6) {
  const proto = protos[type]; if (!proto) return null
  const m = measure(proto)
  const scale = targetH / (m.size.y || 1)
  const obj = proto.clone(true)
  obj.scale.setScalar(scale)
  // 以底部貼地：抵銷原點偏移
  obj.position.set(x - m.center.x * scale, -(m.center.y - m.size.y / 2) * scale, z - m.center.z * scale)
  obj.rotation.y = rotY
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  scene.add(obj)
  return { size: m.size.clone().multiplyScalar(scale) }
}

// 沿一條邊（a→b）用 fence 段落鋪滿；自動偵測模型走向並對齊邊方向
function fenceLine(ax, az, bx, bz) {
  const proto = protos.fence; if (!proto) return
  const m = measure(proto); const targetH = 1.7
  const scale = targetH / (m.size.y || 1)
  const runIsX = m.size.x >= m.size.z
  const runLen = (runIsX ? m.size.x : m.size.z) * scale * 0.98
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
  const ux = dx / len, uz = dz / len
  const rotY = runIsX ? Math.atan2(-uz, ux) : Math.atan2(ux, uz)
  const n = Math.max(1, Math.floor(len / runLen))
  for (let i = 0; i < n; i++) {
    const t = runLen * (i + 0.5)
    placeProp('fence', ax + ux * t, az + uz * t, rotY, targetH)
  }
}

function buildEnvironment() {
  // --- 大草地平面 ---
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1, metalness: 0 })
  )
  grass.rotation.x = -Math.PI / 2
  grass.receiveShadow = true
  scene.add(grass)

  // --- 堡壘下方泥土戰場 ---
  const dirt = new THREE.Mesh(
    new THREE.CircleGeometry(9.5, 48),
    new THREE.MeshStandardMaterial({ map: makeDirtTexture(), roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
  )
  dirt.rotation.x = -Math.PI / 2
  dirt.position.set(0, 0.02, -10.5)
  dirt.receiveShadow = true
  scene.add(dirt)

  // --- 遠景低多邊形山丘（環繞地平線，融入霧氣）---
  const hillGeo = new THREE.IcosahedronGeometry(1, 0)
  const hillGreens = [0x4e9e38, 0x5aac42, 0x459132, 0x66b84c]
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (i % 2) * 0.3
    const dist = 68 + (i % 4) * 14
    const r = 16 + (i % 3) * 8
    const mat = new THREE.MeshStandardMaterial({ color: hillGreens[i % 4], roughness: 1, flatShading: true })
    const hill = new THREE.Mesh(hillGeo, mat)
    hill.scale.set(r, r * (0.45 + (i % 3) * 0.12), r)
    hill.position.set(Math.cos(a) * dist, -r * 0.55, -8 + Math.sin(a) * dist)
    scene.add(hill)
  }

  // --- 蓬鬆雲朵（多顆白球群，主迴圈裡飄移）---
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, fog: true })
  const puffGeo = new THREE.SphereGeometry(1, 10, 8)
  for (let i = 0; i < 8; i++) {
    const g = new THREE.Group()
    const puffs = 4 + (i % 3)
    for (let p = 0; p < puffs; p++) {
      const s = 2.6 + Math.random() * 3
      const puff = new THREE.Mesh(puffGeo, cloudMat)
      puff.scale.set(s, s * 0.7, s)
      puff.position.set((p - puffs / 2) * 3 + Math.random() * 2, Math.random() * 1.5, Math.random() * 2)
      g.add(puff)
    }
    g.position.set(-120 + Math.random() * 240, 38 + Math.random() * 22, -30 - Math.random() * 90)
    scene.add(g)
    clouds.push({ mesh: g, speed: 0.6 + Math.random() * 0.9 })
  }

  // --- 卡通樹（InstancedMesh，撒在打擊區外圍當背景）---
  const spots = []
  for (let i = 0; i < 60 && spots.length < 44; i++) {
    const a = Math.random() * Math.PI * 2, d = 16 + Math.random() * 34
    const x = Math.cos(a) * d, z = -6 + Math.sin(a) * d
    if (x > -13 && x < 13 && z > -21 && z < 9) continue   // 避開打擊區與玩家視線
    spots.push({ x, z, s: 0.8 + Math.random() * 1.1, rot: Math.random() * Math.PI })
  }
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.24, 1.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x6e4a2a, roughness: 1 }), spots.length)
  const leafMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.1, 0),
    new THREE.MeshStandardMaterial({ color: 0x4fa838, roughness: 1, flatShading: true }), spots.length)
  trunkMesh.castShadow = leafMesh.castShadow = true
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion()
  spots.forEach((t, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot)
    mtx.compose(new THREE.Vector3(t.x, 0.7 * t.s, t.z), q, new THREE.Vector3(t.s, t.s, t.s))
    trunkMesh.setMatrixAt(i, mtx)
    mtx.compose(new THREE.Vector3(t.x, (1.4 + 0.7) * t.s, t.z), q, new THREE.Vector3(t.s * 1.05, t.s * 1.15, t.s * 1.05))
    leafMesh.setMatrixAt(i, mtx)
  })
  trunkMesh.instanceMatrix.needsUpdate = leafMesh.instanceMatrix.needsUpdate = true
  trunkMesh.frustumCulled = leafMesh.frustumCulled = false
  scene.add(trunkMesh, leafMesh)

  // --- 場地圍欄（左 / 右 / 後三面，正面留給玩家）+ 交通錐點綴 ---
  fenceLine(-12, 7, -12, -19)
  fenceLine(12, 7, 12, -19)
  fenceLine(-12, -19, 12, -19)
  placeProp('barrier', -11.5, 6.5, 0, 1.0)
  placeProp('barrier', 11.5, 6.5, 0, 1.0)
  for (const [cx, cz] of [[-8, 6.5], [-4, 7.2], [4, 7.2], [8, 6.5]]) placeProp('cone', cx, cz, Math.random() * Math.PI, 0.7)
}

// 主迴圈呼叫：雲朵緩慢橫向飄移，超出範圍就繞回
function updateEnv(dt) {
  for (const c of clouds) {
    c.mesh.position.x += c.speed * dt
    if (c.mesh.position.x > 130) c.mesh.position.x = -130
  }
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
  crate: 'assets/Crate.glb',
  hardbox: 'assets/Crate.glb',
  summonpig: 'assets/Pig.glb',   // 死鬥召喚道具：巨大豬（重用 Pig 模型）
  bombprop: 'assets/Prop_Bomb.glb',   // 炸彈外觀
  cardboard: 'assets/CardboardBoxes_1.glb',
  barrel: 'assets/ExplodingBarrel.glb',
  pig: 'assets/Pig.glb',
  sheep: 'assets/Sheep.glb',
  chicken: 'assets/Chicken.glb',
  cat: 'assets/Cat.glb',
  dog: 'assets/Dog.glb',
  raccoon: 'assets/Raccoon.glb',
  wolf: 'assets/Wolf.glb',
  horse: 'assets/Horse.glb',
  chick: 'assets/Chick.glb',
  plank: 'assets/WoodPlanks.glb',
  brick: 'assets/BrickWall_2.glb',
  container: 'assets/Container_Small.glb',
  sack: 'assets/SackTrench.glb',
  gastank: 'assets/GasTank.glb',
  // 純裝飾（不參與物理，用來佈置場地邊界與四周）
  fence: 'assets/MetalFence.glb',
  barrier: 'assets/Barrier_Single.glb',
  cone: 'assets/TrafficCone.glb',
}
const protos = {}
const animClips = {}   // 各動物的動畫片段
async function loadAll() {
  await Promise.all(Object.entries(ASSETS).map(async ([k, url]) => {
    const gltf = await loader.loadAsync(url)
    protos[k] = gltf.scene
    if (isAnimal(k) || k === 'summonpig') animClips[k] = gltf.animations || []
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
  hardbox:   { targetH: 1.2, mass: 3.4, mat: matBox, tint: 0x8fa6c4 },  // 硬箱：質量大，被球撞幾乎不動、動物更難被震下
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
  summonpig: { scale: 3.2, mass: 30, mat: matBox, skinned: true },               // 死鬥召喚：巨大豬（非目標）
}

const isAnimal = (type) => !!(TYPE[type] && TYPE[type].animal)
// 目標動物輪替池：讓每關自動出現多種動物
const ANIMAL_POOL = ['pig', 'sheep', 'chicken', 'cat', 'dog', 'raccoon', 'wolf', 'chick', 'horse']
let animIdx = 0
function nextAnimal() { return ANIMAL_POOL[animIdx++ % ANIMAL_POOL.length] }

// 取某動物的待機動畫片段（與 addBody 播放時的選法一致）
function idleClip(type) {
  const cs = animClips[type]
  if (!cs || !cs.length) return null
  return cs.find((c) => /idle/i.test(c.name)) || cs[0]
}

// 量測「蒙皮動畫後的真實包圍盒」：Box3.setFromObject 抓不到骨骼變形，
// 故沿 idle 動畫採樣多個時刻，逐頂點套用骨骼變換取聯集，讓腳貼齊而非浮空。
function measureAnimatedBounds(holder, clip) {
  const meshes = []
  holder.traverse((o) => { if (o.isSkinnedMesh && o.geometry?.attributes?.position) meshes.push(o) })
  // 沒有蒙皮網格或不支援逐骨變換 → 退回一般量測
  if (!meshes.length || typeof meshes[0].applyBoneTransform !== 'function') {
    return new THREE.Box3().setFromObject(holder)
  }
  const mixer = new THREE.AnimationMixer(holder)
  if (clip) mixer.clipAction(clip).play()
  const box = new THREE.Box3(), v = new THREE.Vector3()
  const dur = (clip && clip.duration) || 0
  const N = clip ? 6 : 1
  let prev = 0
  for (let s = 0; s < N; s++) {
    const t = N > 1 ? (s / (N - 1)) * dur : 0
    mixer.update(t - prev); prev = t
    holder.updateMatrixWorld(true)
    for (const m of meshes) {
      const pos = m.geometry.attributes.position
      const stride = pos.count > 3000 ? 3 : 1   // 高面數模型抽樣，控制成本
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i)
        m.applyBoneTransform(i, v)
        v.applyMatrix4(m.matrixWorld)
        box.expandByPoint(v)
      }
    }
  }
  mixer.stopAllAction()
  return box
}

// 正規化模型：套朝向→量測 footprint→置中；回傳 wrap 與半尺寸
function makeVisual(type) {
  const cfg = TYPE[type]
  const proto = protos[type]
  const inst = (isAnimal(type) || cfg.skinned) ? skeletonClone(proto) : proto.clone(true)
  // 色調（如硬箱）：複製材質後乘上 tint，讓外觀與一般木箱區別
  if (cfg.tint) inst.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color = new THREE.Color(cfg.tint) } })
  const raw = measure(proto)
  const scale = cfg.scale != null ? cfg.scale : cfg.targetH / (raw.size.y || 1)
  const holder = new THREE.Group()
  holder.add(inst); holder.scale.setScalar(scale)
  if (cfg.faceRotateY) holder.rotation.y = cfg.faceRotateY
  // 動物用「動畫後真實包圍盒」貼齊；其餘用一般包圍盒
  const box = isAnimal(type)
    ? measureAnimatedBounds(holder, idleClip(type))
    : new THREE.Box3().setFromObject(holder)
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
  if (isAnimal(type)) {
    // 記錄起始位置與飛行最高點，供加分與飛行特效使用
    ent.startY = cy; ent.maxY = cy; ent.spawnX = x; ent.spawnZ = z; ent.hy = hy
    ent.launched = false; ent.calmT = 0; ent.msH = 0; ent.msD = 0   // 飛行狀態與里程碑進度
  }
  const idle = isAnimal(type) ? idleClip(type) : null
  if (idle) {
    ent.mixer = new THREE.AnimationMixer(wrap)
    ent.mixer.clipAction(idle).play()
  }
  body._ent = ent
  // 爆裂物（桶 / 瓦斯桶）：受到夠強的撞擊就引爆（豬的死亡改由落地高度判定）
  if (cfg.explosive) {
    body.addEventListener('collide', (e) => {
      if (ent.dead || !game || !game.armed) return   // 開場沉降期間免疫，避免被掉落積木誤引爆
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
      if (v > 6) { ent.hp -= v * 6; if (ent.hp <= 0) { ent.dead = true; ent.popping = 0; explode(body.position, cfg.explosive); addScore(500) } }
    })
  } else if (!isAnimal(type)) {
    // 積木（木箱／紙箱／硬箱／磚／樑…）：掉落與碰撞時的木頭撞擊聲（開場沉降期間靜音、全域節流）
    const soft = type === 'cardboard' || type === 'sack'
    body.addEventListener('collide', (e) => {
      if (!game || !game.armed) return
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
      if (v > 2.6) playClack(v, soft)
    })
  }
  entities.push(ent)
  return cy + hy
}

// ============================================================
//  加分機制 + 飛行特效（飛越高越遠得分越多，過程即時演出）
// ============================================================
const SCORE_BASE = 1000, SCORE_PER_HEIGHT = 400, SCORE_PER_DIST = 200
const bonusFor = (height, dist) =>
  Math.round((SCORE_BASE + Math.max(0, height) * SCORE_PER_HEIGHT + Math.max(0, dist) * SCORE_PER_DIST) / 50) * 50
function addScore(v) { game.score += v }
// 金幣（僅死鬥）：跟分數/飛行 bonus 脫鉤，只從「擊殺數 + 每波清空」發放，避免通膨
const COIN_PER_KILL = 50
function addCoins(v) { if (game.endless && !game.happy) game.coins = (game.coins || 0) + v }

// 里程碑門檻（飛行中突破就爆字）
const MS_HEIGHT = [{ v: 2.0, t: '騰空！' }, { v: 4.0, t: '高飛！' }, { v: 6.5, t: '沖天！' }]
const MS_DIST = [{ v: 5, t: '飛遠！' }, { v: 9, t: '超遠！' }, { v: 14, t: '爆遠！' }]

function killAnimal(e) {
  if (e.dead) return
  e.dead = true; e.popping = 0
  const height = Math.max(0, (e.maxY || 0) - (e.startY || 0))
  const dist = Math.hypot(e.body.position.x - (e.spawnX || 0), e.body.position.z - (e.spawnZ || 0))
  const bonus = bonusFor(height, dist)
  addScore(bonus); addCoins(COIN_PER_KILL); game.pigs--; pendingKills++   // 全服消滅數 +1；死鬥每殺給固定金幣
  sfx.die()
  removeTag(e); removeTrail(e)   // 收掉跟隨計數器與拖尾
  // 死亡結算：金色大字定格上飄
  spawnFloater(e.body.position, (e.hy || 0.8) + 0.4, '+' + bonus,
    { fill: '#ffd63a', size: 82, life: 1.2, rise: 1.6, grow: 0.6, worldScale: 2.6 })
  refreshHUD()
}

// ---- 一次性飄升文字（死亡結算、里程碑爆字共用）----
const floaters = []
function makeTextTexture(text, { fill = '#ffd63a', stroke = 'rgba(50,25,0,.9)', size = 76, weight = 900 } = {}) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128
  const ctx = c.getContext('2d')
  ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft JhengHei", sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke; ctx.strokeText(text, 128, 66)
  ctx.fillStyle = fill; ctx.fillText(text, 128, 66)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
function spawnFloater(pos, headY, text, opts = {}) {
  const w = opts.worldScale || 2.2
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeTextTexture(text, opts), transparent: true, depthTest: false }))
  sp.position.set(pos.x, pos.y + headY, pos.z)
  sp.scale.set(w, w / 2, 1); sp.renderOrder = 999
  scene.add(sp)
  floaters.push({ sprite: sp, t: 0, w, life: opts.life || 1.0, rise: opts.rise || 1.8, grow: opts.grow ?? 0.6 })
}

// ---- 即時跟隨計數器（飛行中掛在動物頭上，數字隨高度/距離往上跳）----
function ensureTag(e) {
  if (e.tag) return
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
  const tex = new THREE.CanvasTexture(canvas.getContext('2d').canvas); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sp.scale.set(2.1, 1.05, 1); sp.renderOrder = 1000
  scene.add(sp)
  e.tag = { sprite: sp, ctx: canvas.getContext('2d'), tex, bucket: -1 }
}
function updateTag(e, amount) {
  ensureTag(e)
  const bucket = Math.round(amount / 50)
  if (bucket !== e.tag.bucket) {            // 只在顯示值跨 50 級距時重繪，不每幀新建紋理
    e.tag.bucket = bucket
    const ctx = e.tag.ctx
    ctx.clearRect(0, 0, 256, 128)
    ctx.font = '900 70px "Segoe UI", "Microsoft JhengHei", sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(50,25,0,.9)'
    ctx.strokeText('+' + bucket * 50, 128, 66)
    ctx.fillStyle = '#fff1a0'; ctx.fillText('+' + bucket * 50, 128, 66)
    e.tag.tex.needsUpdate = true
  }
  const p = e.body.position
  e.tag.sprite.position.set(p.x, p.y + (e.hy || 0.8) + 0.6, p.z)
}
function removeTag(e) {
  if (!e.tag) return
  scene.remove(e.tag.sprite); e.tag.tex.dispose(); e.tag.sprite.material.dispose()
  e.tag = null
}

// ---- 發光拖尾（沿飛行路徑噴發漸消的暖色光點，形成彗星尾）----
let glowTex = null
function getGlowTexture() {
  if (glowTex) return glowTex
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,220,140,0.8)'); g.addColorStop(1, 'rgba(255,180,60,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s)
  glowTex = new THREE.CanvasTexture(c)
  return glowTex
}
const sparks = []
function emitTrail(e, speed, dt) {
  e.sparkT = (e.sparkT || 0) + dt
  if (speed < 5 || e.sparkT < 0.028) return          // 夠快才噴、限制噴發頻率
  e.sparkT = 0
  const p = e.body.position
  const mat = new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  mat.color.setHSL(0.09 + Math.random() * 0.03, 1, 0.6)
  const sp = new THREE.Sprite(mat)
  sp.position.set(p.x, p.y + (e.hy || 0.5) * 0.4, p.z)
  const sc = 0.6 + Math.min(1, speed / 16) * 0.9
  sp.scale.set(sc, sc, 1)
  scene.add(sp)
  sparks.push({ sprite: sp, t: 0, life: 0.45, s0: sc })
}
function removeTrail(e) { e.sparkT = 0 }   // 光點各自淡出，這裡只重置節流

function endFlightFX(e) { removeTag(e); removeTrail(e); e.launched = false; e.calmT = 0 }

// 爆炸特效
const flashes = []     // 膨脹淡出的網格（火球層 / 衝擊波環）
const scorches = []    // 地面焦痕（慢慢淡掉）
function addFlash(mesh, size0, grow, life) { mesh.scale.setScalar(size0); scene.add(mesh); flashes.push({ mesh, t: 0, size0, grow, life }) }
function fireSphere(pos, color, size0, grow, life) {
  addFlash(new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
    .translateX(pos.x).translateY(pos.y).translateZ(pos.z), size0, grow, life)
}
// 火星 / 煙（billboard，可帶速度/重力/成長）
function addSpark(x, y, z, size, color, o = {}) {
  const mat = new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, depthWrite: false, blending: o.blend || THREE.AdditiveBlending })
  mat.color.copy(color)
  const sp = new THREE.Sprite(mat); sp.position.set(x, y, z); sp.scale.set(size, size, 1); sp.renderOrder = 997
  scene.add(sp)
  sparks.push({ sprite: sp, t: 0, life: o.life || 0.5, s0: size, vx: o.vx, vy: o.vy, vz: o.vz, g: o.g, grow: o.grow, op0: o.op != null ? o.op : 1 })
}
function explode(pos, R = 4) {
  const px = pos.x, py = pos.y, pz = pos.z
  sfx.explode(); addShake(Math.min(1.1, 0.6 + R * 0.06))
  // A 分層火球（白核 / 橘 / 紅）
  fireSphere(pos, 0xfff2c0, R * 0.28, R * 0.7, 0.20)
  fireSphere(pos, 0xff8a2a, R * 0.30, R * 1.15, 0.34)
  fireSphere(pos, 0xd23a12, R * 0.34, R * 1.5, 0.46)
  // C 地面衝擊波環
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.9, 36),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2; ring.position.set(px, 0.12, pz)
  addFlash(ring, 1, R * 2.2, 0.42)
  // B 火星四射
  const embers = 8 + Math.round(R * 2)
  for (let i = 0; i < embers; i++) {
    const a = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 8
    addSpark(px, py, pz, 0.35 + Math.random() * 0.4, new THREE.Color().setHSL(0.06 + Math.random() * 0.06, 1, 0.6),
      { vx: Math.cos(a) * sp, vy: (0.3 + Math.random() * 1.1) * sp * 0.7, vz: Math.sin(a) * sp, g: -16, life: 0.5 + Math.random() * 0.5 })
  }
  // D 上升煙霧
  for (let i = 0; i < 4; i++) {
    addSpark(px + (Math.random() - 0.5) * R, py + 0.3, pz + (Math.random() - 0.5) * R, 1 + Math.random(),
      new THREE.Color(0.55, 0.53, 0.5), { blend: THREE.NormalBlending, op: 0.5, vy: 1.5 + Math.random() * 1.5, grow: 1.6, life: 0.9 + Math.random() * 0.5 })
  }
  // E 地面焦痕
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(R * 0.55, 28),
    new THREE.MeshBasicMaterial({ color: 0x241a10, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }))
  scorch.rotation.x = -Math.PI / 2; scorch.position.set(px, 0.04, pz); scene.add(scorch)
  scorches.push({ mesh: scorch, t: 0, life: 4 })
  // H 更強擊飛
  for (const e of entities) {
    if (e.dead) continue
    const d = e.body.position.distanceTo(pos)
    if (d > R || d < 0.01) continue
    const f = 1 - d / R
    const dir = e.body.position.vsub(pos); dir.normalize()
    e.body.wakeUp()
    e.body.applyImpulse(new CANNON.Vec3(dir.x * f * 18 * e.body.mass, (dir.y * f + f) * 13 * e.body.mass, dir.z * f * 18 * e.body.mass), new CANNON.Vec3(0, 0, 0))
    // 爆炸只負責把動物炸飛，落地後才判定死亡
  }
}

// ---- 砲彈 ----
const balls = []
let lastThud = 0
function playThud(v) {
  const t = performance.now()
  if (t - lastThud > 55) { lastThud = t; sfx.thud(v) }
}
let lastClack = 0
function playClack(v, soft) {
  const t = performance.now()
  if (t - lastClack > 40) { lastClack = t; sfx.wood(v, soft) }   // 全域節流，避免整棟崩塌時爆音
}
let lastStomp = 0
function playStomp(v) {
  const t = performance.now()
  if (t - lastStomp > 90) { lastStomp = t; sfx.stomp(v) }
}
// ---- 畫面震動 ----
let shakeMag = 0
function addShake(v) { shakeMag = Math.min(1.5, shakeMag + v) }
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

// ============================================================
//  特殊彈藥（僅死鬥模式）：炸彈 / 一分多 / 召喚豬
// ============================================================
const SPECIALS = [
  { key: 'bomb', emoji: '💣', name: '炸彈', desc: '命中即爆炸，掀翻周圍一整片', price: 1100 },
  { key: 'split', emoji: '🎯', name: '一分多', desc: '飛行中分裂成多顆霰彈掃射', price: 850 },
  { key: 'summon', emoji: '🐖', name: '召喚豬', desc: '召喚巨大豬往準星衝，撞倒一切', price: 1500 },
  { key: 'blackhole', emoji: '🕳️', name: '黑洞彈', desc: '命中把周圍吸向中心再內爆', price: 1800 },
  { key: 'lightning', emoji: '⚡', name: '連鎖閃電', desc: '天降閃電連鎖電擊一排動物', price: 1400 },
  { key: 'wreck', emoji: '🎳', name: '鐵球', desc: '超重鐵球直接輾穿整座堡壘', price: 700 },
  { key: 'tornado', emoji: '🌪️', name: '龍捲風', desc: '命中生成龍捲把東西往上捲飛', price: 1300 },
  { key: 'cluster', emoji: '💥', name: '集束炸彈', desc: '空中散成多顆小炸彈連環爆', price: 1600 },
]
const equippedKeys = () => SPECIALS.filter((s) => loadout[s.key]).map((s) => s.key).slice(0, 3)   // 開局帶 3 種各 1 顆
const slotKeys = () => SPECIALS.map((s) => s.key)   // 死鬥/快樂 HUD 都列全 8 種（死鬥可在商店買到任一種）
const LOADOUT_KEY = 'angrypig:loadout'
function loadLoadout() { try { const o = JSON.parse(localStorage.getItem(LOADOUT_KEY)); return o && typeof o === 'object' ? o : {} } catch { return {} } }
const loadout = { bomb: true, split: true, summon: true, ...loadLoadout() }   // 預設全裝備
function saveLoadout() { try { localStorage.setItem(LOADOUT_KEY, JSON.stringify(loadout)) } catch {} }

function aimStart(fwd = 1.4) {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir)
  return { dir, start: camera.position.clone().addScaledVector(dir, fwd) }
}
function makeBallMesh(r, color) {
  const group = new THREE.Group()
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: color, emissiveIntensity: 0.15 }))
  m.castShadow = true; group.add(m); scene.add(group)
  return group
}
function addProjectile(group, body, type, extra = {}) {
  world.addBody(body)
  const ent = { body, group, type, hp: 1e9, born: 0, ...extra }
  body._ent = ent
  balls.push(ent); entities.push(ent)
  return ent
}
// 炸彈：命中即爆（外觀用 Prop_Bomb 模型，載入失敗則退回深色球）
function makeBombMesh(r) {
  const proto = protos.bombprop
  if (!proto) return makeBallMesh(r, 0x222228)
  const inst = proto.clone(true)
  const m = measure(proto)
  const scale = (r * 2.4) / (m.size.y || 1)
  inst.scale.setScalar(scale)
  inst.position.copy(m.center).multiplyScalar(-scale)   // 置中到群組原點
  inst.traverse((o) => { if (o.isMesh) o.castShadow = true })
  const group = new THREE.Group(); group.add(inst); scene.add(group)
  return group
}
function throwBomb(power) {
  const { dir, start } = aimStart()
  const r = 0.42
  const body = new CANNON.Body({ mass: 4, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(start.x, start.y, start.z)
  const s = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  body.velocity.set(dir.x * s, dir.y * s, dir.z * s)
  const ent = addProjectile(makeBombMesh(r), body, 'bomb')
  body.addEventListener('collide', (e) => {
    if (ent.boom) return
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
    if (v > 2) { ent.boom = true; explode(body.position, 4.8) }
  })
}
// 一分多：載體球飛一小段後分裂成霰彈
function throwSplit(power) {
  const { dir, start } = aimStart()
  const r = 0.34
  const body = new CANNON.Body({ mass: 3, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(start.x, start.y, start.z)
  const s = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  body.velocity.set(dir.x * s, dir.y * s, dir.z * s)
  addProjectile(makeBallMesh(r, 0x36b0ff), body, 'split')
}
const CYAN = () => new THREE.Color().setHSL(0.54 + Math.random() * 0.05, 1, 0.65)   // 青藍色
function spawnPellet(pos, vel) {
  const r = 0.26
  const body = new CANNON.Body({ mass: 1.6, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(pos.x, pos.y, pos.z); body.velocity.set(vel.x, vel.y, vel.z)
  const ent = addProjectile(makeBallMesh(r, 0x8fd4ff), body, 'ball')
  ent.pellet = true   // 標記為霰彈 → 主迴圈會拖青色光尾
  body.addEventListener('collide', (e) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
    if (v > 2.5) {
      playThud(v)
      const b = body.position   // 命中小青火花
      for (let i = 0; i < 3; i++) addSpark(b.x, b.y, b.z, 0.3, CYAN(),
        { vx: (Math.random() - 0.5) * 5, vy: Math.random() * 4, vz: (Math.random() - 0.5) * 5, g: -14, life: 0.3 })
    }
  })
  return ent
}
function doSplit(ent) {
  const p = ent.body.position, v = ent.body.velocity
  // 分裂爆點：青白閃光 + 衝擊波環 + 火花爆散 + 音效
  sfx.split()
  fireSphere(p, 0x9fe0ff, 0.5, 1.6, 0.18)
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 5
    addSpark(p.x, p.y, p.z, 0.3 + Math.random() * 0.3, CYAN(),
      { vx: Math.cos(a) * sp, vy: (Math.random() - 0.3) * sp, vz: Math.sin(a) * sp, g: -12, life: 0.4 + Math.random() * 0.3 })
  }
  const base = new THREE.Vector3(v.x, v.y, v.z); const speed = base.length() || 22; base.normalize()
  const ref = Math.abs(base.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const right = new THREE.Vector3().crossVectors(base, ref).normalize()
  const up = new THREE.Vector3().crossVectors(right, base).normalize()
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, spread = 0.3
    const d = base.clone().addScaledVector(right, Math.cos(a) * spread).addScaledVector(up, Math.sin(a) * spread).normalize()
    spawnPellet(p, d.multiplyScalar(speed))
  }
}
// 召喚豬：巨大豬往準星水平方向衝刺，靠大質量撞倒沿路一切
function throwSummon() {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir)
  const cd = new THREE.Vector3(dir.x, 0, dir.z); if (cd.lengthSq() < 1e-4) cd.set(0, 0, -1); cd.normalize()
  const { wrap, hx, hy, hz } = makeVisual('summonpig')
  scene.add(wrap)
  const start = camera.position.clone().addScaledVector(dir, 3)
  const body = new CANNON.Body({ mass: TYPE.summonpig.mass, material: matBox, shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)) })
  body.position.set(start.x, hy + 0.15, start.z)
  body.fixedRotation = true; body.updateMassProperties()   // 不翻滾，維持衝刺姿態
  body.allowSleep = false
  body.quaternion.setFromEuler(0, Math.atan2(cd.x, cd.z), 0)
  world.addBody(body)
  const ent = { body, group: wrap, type: 'summon', hp: 1e9, born: 0, dir: cd,
    reach: Math.max(hx, hz) + 1.0, hit: new Set() }
  // 播放素材的 Run 動作（衝刺感）
  const clips = animClips.summonpig
  if (clips && clips.length) {
    const run = clips.find((c) => /run/i.test(c.name)) || clips.find((c) => /walk/i.test(c.name)) || clips[0]
    ent.mixer = new THREE.AnimationMixer(wrap)
    ent.mixer.clipAction(run).play()
  }
  body._ent = ent
  entities.push(ent)   // 不放 balls；非目標，不計入 game.pigs、不被 killAnimal
  sfx.summon(); addShake(1.2)                                   // 吼叫 + 發射大震
  if (IS_TOUCH && navigator.vibrate) navigator.vibrate(120)    // 手機震動回饋
}
// ---- 新特殊彈：黑洞 / 閃電 / 鐵球 / 龍捲 / 集束 / 彈跳 ----
const wells = []   // 重力井（黑洞吸入 / 龍捲上捲）
const bolts = []   // 閃電線段
const ZERO = new CANNON.Vec3(0, 0, 0)
// 通用載體球：命中(v>1.5)後設 ent.hit，主迴圈觸發 onHit 效果
function throwCarrier(power, color, r, onHit, mass = 3) {
  const { dir, start } = aimStart()
  const body = new CANNON.Body({ mass, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(start.x, start.y, start.z)
  const s = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  body.velocity.set(dir.x * s, dir.y * s, dir.z * s)
  const ent = addProjectile(makeBallMesh(r, color), body, 'ball')
  ent.onHit = onHit
  body.addEventListener('collide', (e) => { if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > 1.5) ent.hit = true })
  return ent
}
function throwBlackhole(power) { throwCarrier(power, 0x7a3bd0, 0.36, 'blackhole') }
function throwTornado(power) { throwCarrier(power, 0xbfe6ff, 0.34, 'tornado') }
function throwLightning(power) { throwCarrier(power, 0xfff27a, 0.3, 'lightning', 2) }
function throwCluster(power) { const e = throwCarrier(power, 0x33343e, 0.34, null); e.cluster = true }
function throwWreckingBall(power) {
  const { dir, start } = aimStart(1.9)
  const r = 0.9
  const body = new CANNON.Body({ mass: 26, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(start.x, start.y, start.z)
  const s = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * power
  body.velocity.set(dir.x * s, dir.y * s, dir.z * s)
  const ent = addProjectile(makeBallMesh(r, 0x6a7082), body, 'ball'); ent.big = true
  body.addEventListener('collide', (e) => { if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > 3) { playStomp(3); addShake(0.35) } })
}
// 集束：載體空中散成 5 顆小炸彈（type 'bomb' 沿用引信+清理）
function spawnMiniBomb(pos, vel) {
  const r = 0.24
  const body = new CANNON.Body({ mass: 1.4, material: matBall, shape: new CANNON.Sphere(r) })
  body.position.set(pos.x, pos.y, pos.z); body.velocity.set(vel.x, vel.y, vel.z)
  const ent = addProjectile(makeBallMesh(r, 0x2a2a30), body, 'bomb')
  body.addEventListener('collide', (e) => {
    if (ent.boom) return
    if (Math.abs(e.contact.getImpactVelocityAlongNormal()) > 1.5) { ent.boom = true; explode(body.position, 3) }
  })
}
function doCluster(ent) {
  const p = ent.body.position, v = ent.body.velocity
  const base = new THREE.Vector3(v.x, v.y, v.z); const speed = Math.max(12, base.length()); base.normalize()
  const right = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize()
  const up = new THREE.Vector3().crossVectors(right, base).normalize()
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2, spread = 0.35
    const d = base.clone().addScaledVector(right, Math.cos(a) * spread).addScaledVector(up, Math.sin(a) * spread).normalize()
    spawnMiniBomb(p, d.multiplyScalar(speed * 0.8))
  }
}
function drawBolt(a, b) {
  const seg = 8, pts = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, j = (i > 0 && i < seg) ? 0.6 : 0
    pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t + (Math.random() - 0.5) * j, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * j, a.z + (b.z - a.z) * t + (Math.random() - 0.5) * j))
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xcfefff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  line.renderOrder = 998; scene.add(line); bolts.push({ line, t: 0, life: 0.28 })
}
function strikeLightning(pos) {
  sfx.zap(); addShake(0.5)
  const P = new THREE.Vector3(pos.x, pos.y, pos.z)
  const targets = entities.filter((e) => isAnimal(e.type) && !e.dead)
    .map((e) => ({ e, d: e.body.position.distanceTo(pos) })).filter((o) => o.d < 6)
    .sort((a, b) => a.d - b.d).slice(0, 5).map((o) => o.e)
  let prev = new THREE.Vector3(pos.x, pos.y + 14, pos.z)
  drawBolt(prev, P); prev = P
  for (const e of targets) {
    const tp = new THREE.Vector3(e.body.position.x, e.body.position.y, e.body.position.z)
    drawBolt(prev, tp); prev = tp
    e.body.wakeUp()
    e.body.applyImpulse(new CANNON.Vec3((Math.random() - 0.5) * 4 * e.body.mass, 9 * e.body.mass, (Math.random() - 0.5) * 4 * e.body.mass), ZERO)
    addSpark(tp.x, tp.y, tp.z, 0.5, new THREE.Color(0.75, 0.9, 1), { life: 0.3 })
  }
  for (const e of entities) {   // 命中點附近積木也震開
    if (e.dead) continue
    const d = e.body.position.distanceTo(pos); if (d > 3 || d < 0.01) continue
    const f = 1 - d / 3; const dir = e.body.position.vsub(pos); dir.normalize(); e.body.wakeUp()
    e.body.applyImpulse(new CANNON.Vec3(dir.x * f * 8 * e.body.mass, (f + 0.5) * 8 * e.body.mass, dir.z * f * 8 * e.body.mass), ZERO)
  }
}
function triggerCarrier(kind, pos) {
  if (kind === 'lightning') { strikeLightning(pos); return }
  if (kind === 'blackhole') { wells.push({ x: pos.x, y: pos.y, z: pos.z, t: 0, life: 1.5, mode: 'in' }); playStomp(6) }
  else if (kind === 'tornado') {
    wells.push({ x: pos.x, y: 0.2, z: pos.z, t: 0, life: 3.0, mode: 'up', spin: 0 })
    sfx.summon(); addShake(0.5)   // 低吼當風聲
  }
}

function throwSpecial(kind, power) {
  if (kind === 'bomb') throwBomb(power)
  else if (kind === 'split') throwSplit(power)
  else if (kind === 'summon') throwSummon(power)
  else if (kind === 'blackhole') throwBlackhole(power)
  else if (kind === 'lightning') throwLightning(power)
  else if (kind === 'wreck') throwWreckingBall(power)
  else if (kind === 'tornado') throwTornado(power)
  else if (kind === 'cluster') throwCluster(power)
  sfx.throw()
}
function hasUsableSelected() { return !!(game && game.selected && game.specials && game.specials[game.selected]) }
function selectSpecial(key) {
  if (!game || !game.endless || game.over || game.paused || !game.specials) return
  if (!game.specials[key]) return   // 未裝備或已用完
  game.selected = (game.selected === key) ? null : key
}
// HUD 特殊槽：只在死鬥顯示；只在狀態改變時重繪
let specialsSig = ''
function updateSpecialsHUD() {
  const el = document.getElementById('specials'); if (!el) return
  const on = !!(game && game.endless && !game.over && game.specials)
  el.classList.toggle('hidden', !on)
  if (!on) { specialsSig = ''; return }
  const eq = slotKeys()
  const cnt = (k) => game.specials[k] || 0
  const sig = eq.map((k) => k + cnt(k) + (game.selected === k ? '*' : '')).join('|')
  if (sig === specialsSig) return
  specialsSig = sig
  el.innerHTML = eq.map((k, i) => {
    const s = SPECIALS.find((x) => x.key === k)
    const c = cnt(k)
    const cls = 'sp-slot' + (c > 0 ? '' : ' used') + (game.selected === k ? ' sel' : '')
    const badge = c === Infinity ? '∞' : c   // 快樂無限顯示 ∞，死鬥顯示剩餘數
    return `<button class="${cls}" data-sp="${k}"><span class="sp-emoji">${s.emoji}</span><span class="sp-key">${i + 1}</span><span class="sp-cnt">${badge}</span></button>`
  }).join('')
}
// 商店：兩種模式 —— 'equip'（首頁免費挑開局 3 種）/ 'buy'（死鬥中每 10 波花金幣補貨）
let shopMode = 'equip'
function renderShop() {
  const list = document.getElementById('shop-list'); if (!list) return
  const title = document.getElementById('shop-title')
  const head = document.getElementById('shop-count')
  const cont = document.getElementById('shop-continue')
  const buying = shopMode === 'buy'
  shopModal.classList.toggle('locked', buying)
  if (title) title.textContent = buying ? '🛒 補給站 · 花金幣補貨' : '🛒 商店 · 特殊彈藥'
  if (cont) cont.classList.toggle('hidden', !buying)
  if (head) {
    head.textContent = buying ? `💰 ${(game.coins || 0).toLocaleString()} 金幣` : `免費挑開局 3 種（已裝備 ${equippedKeys().length} / 3）`
  }
  list.innerHTML = SPECIALS.map((s) => {
    const info = `<div class="shop-info"><div class="shop-name">${s.name}</div><div class="shop-desc">${s.desc}</div></div>`
    if (buying) {
      const own = (game.specials && game.specials[s.key]) || 0
      const afford = (game.coins || 0) >= s.price
      return `<div class="shop-item"><div class="shop-emoji">${s.emoji}<span class="shop-own">×${own}</span></div>` + info +
        `<button class="shop-buy${afford ? '' : ' poor'}" data-sp="${s.key}">💰 ${s.price}</button></div>`
    }
    const on = !!loadout[s.key]
    return `<div class="shop-item"><div class="shop-emoji">${s.emoji}</div>` + info +
      `<button class="shop-toggle${on ? ' on' : ''}" data-sp="${s.key}">${on ? '已裝備' : '裝備'}</button></div>`
  }).join('')
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
  msgRank: document.getElementById('msg-rank'), msgLb: document.getElementById('msg-lb'),
  airBonus: document.getElementById('air-bonus'), abValue: document.getElementById('ab-value'),
  abFill: document.getElementById('ab-fill'), abMult: document.getElementById('ab-mult'),
  flyBest: document.getElementById('fly-best'),
  flyBig: document.getElementById('fly-big'), flyBigVal: document.getElementById('fb-val'),
  coins: document.getElementById('coins'), coinStat: document.getElementById('coin-stat'),
}
function refreshHUD() {
  if (!game) return
  hud.score.textContent = game.score
  const a = Math.max(0, game.ammo)
  hud.ammo.textContent = game.happy ? '🔴∞' : a > 8 ? '🔴×' + a : '🔴'.repeat(a)
  hud.pigs.textContent = '🐾 ' + Math.max(0, game.pigs)
  hud.level.textContent = game.happy ? `😄 快樂 第 ${game.wave} 波` : game.endless ? `☠️ 第 ${game.wave} 波` : `${currentLevel + 1}／${LEVELS.length}`
  // 金幣：只有死鬥模式顯示（快樂無限、一般關卡不用）
  const showCoins = game.endless && !game.happy
  if (hud.coinStat) hud.coinStat.classList.toggle('hidden', !showCoins)
  if (hud.coins && showCoins) hud.coins.textContent = '💰 ' + (game.coins || 0).toLocaleString()
}
// 空中 BONUS 倍率條：有動物在飛就顯示當前最佳表現
function updateAirBonusHUD(bonus, height) {
  if (!hud.airBonus) return
  if (bonus > 0 && game && !game.over) {
    hud.airBonus.classList.remove('hidden')
    hud.abValue.textContent = '+' + bonus
    hud.abFill.style.width = Math.min(100, bonus / 6000 * 100) + '%'
    hud.abMult.textContent = 'x' + Math.max(1, Math.min(9, 1 + Math.floor(height / 1.5)))
  } else {
    hud.airBonus.classList.add('hidden')
  }
}

// 即時最高飛行：小 HUD 常駐；一旦刷新紀錄（數字往上跳）就全螢幕大字顯示，停住 0.8s 後淡出
let flyShown = 0, flyBigHold = 0
function updateFlyBig(dt) {
  const mf = game ? (game.maxFly || 0) : 0
  if (hud.flyBest) hud.flyBest.textContent = mf.toFixed(1) + ' m'
  if (!hud.flyBig) return
  if (mf < flyShown - 0.01) flyShown = mf          // 新的一場（maxFly 歸零）→ 重置
  if (game && !game.over && mf > flyShown + 0.05) { // 正在刷新紀錄 → 大字即時攀升
    flyShown = mf; flyBigHold = 0.8
    hud.flyBigVal.textContent = mf.toFixed(1)
    hud.flyBig.classList.remove('hidden')
    hud.flyBig.classList.remove('pop'); void hud.flyBig.offsetWidth; hud.flyBig.classList.add('pop')
  } else if (flyBigHold > 0) {
    flyBigHold -= dt
    if (flyBigHold <= 0) hud.flyBig.classList.add('hidden')
  }
}

function clearWorld() {
  for (const e of entities) { world.removeBody(e.body); scene.remove(e.group); removeTag(e) }
  entities.length = 0; balls.length = 0
  flashes.forEach((f) => scene.remove(f.mesh)); flashes.length = 0
  scorches.forEach((s) => scene.remove(s.mesh)); scorches.length = 0
  bolts.forEach((b) => scene.remove(b.line)); bolts.length = 0
  wells.forEach((w) => { if (w.mesh) scene.remove(w.mesh) }); wells.length = 0
  floaters.forEach((p) => { scene.remove(p.sprite); p.sprite.material.map.dispose(); p.sprite.material.dispose() })
  floaters.length = 0
  sparks.forEach((s) => { scene.remove(s.sprite); s.sprite.material.dispose() }); sparks.length = 0
  if (hud.airBonus) hud.airBonus.classList.add('hidden')
  if (hud.flyBig) hud.flyBig.classList.add('hidden')
  flyBigHold = 0
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
// 交替木箱／紙箱的高柱（外觀更有變化），回傳頂部高度
function variedColumn(x, z, n, base = 0) {
  const palette = ['crate', 'cardboard', 'crate']
  let top = base
  for (let i = 0; i < n; i++) top = addBody(palette[i % palette.length], x, z, top)
  return top
}
// 高樓：爆裂物當「地基」最底層 → 交替建材高柱 → 屋頂站動物。
// 打爆地基（或轟掉塔基）→ 爆炸衝擊波掀翻整棟，動物落地即消滅。
function tower(x, z, floors, foundation = 'gastank') {
  const base = foundation ? addBody(foundation, x, z, 0) : 0   // 地基弱點
  const top = variedColumn(x, z, floors, base)
  addBody(nextAnimal(), x, z, top)                             // 屋頂動物
  return top
}
// 紙箱大樓：反覆「兩根紙箱柱 + 木板橫版」往上疊出多層樓（像蓋房子）；屋頂站動物，回傳頂高
function plankTower(x, z, floors, legH = 2) {
  const dx = 1.05          // 兩根紙箱柱並排（紙箱較寬 → 寬底座、疊高也穩）
  let base = 0
  for (let f = 0; f < floors; f++) {
    const lt = stack('cardboard', x - dx, z, legH, base)
    const rt = stack('cardboard', x + dx, z, legH, base)
    base = addBody('plank', x, z, Math.max(lt, rt))   // 橫版蓋兩柱之上，成為下一層地板
  }
  addBody(nextAnimal(), x, z, base)                   // 屋頂動物
  return base
}

// ---- 關卡定義（難度與建築複雜度遞增；後段為可炸地基連鎖倒塌的高樓）----
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
  {
    // 危樓：兩側爆裂地基高塔 + 中央橫版堆疊的紙箱大樓
    name: '危樓', ammo: 10, build() {
      tower(-4.5, -10, 4, 'gastank')       // 左爆裂地基塔
      tower(4.5, -10, 4, 'barrel')         // 右爆裂地基塔
      plankTower(0, -12, 3)                // 中央紙箱大樓（兩柱 + 橫版）
      for (const x of [-2, 2]) addBody('brick', x, -6.5, 0)   // 前排磚牆掩護
      pigColumn(0, -7.8, 1)                                    // 前排動物
    }
  },
  {
    // 摩天樓：中央高樓 + 兩側樓層，地基爆裂物成群，炸基座整片崩塌
    name: '摩天樓', ammo: 13, build() {
      tower(0, -13, 6, 'gastank')                 // 中央主樓
      tower(-3, -11, 4, 'barrel'); tower(3, -11, 4, 'barrel')   // 兩側副樓
      pigColumn(-5.2, -10, 3); pigColumn(5.2, -10, 3)          // 側翼動物塔
      addBody('gastank', -1.6, -8, 0); addBody('gastank', 1.6, -8, 0)   // 前線地基弱點
      for (const x of [-3, 0, 3]) addBody('sack', x, -6.3, 0)  // 前線沙包掩體
    }
  },
  {
    // 紙箱大樓：兩根紙箱柱 + 木板橫版反覆堆疊成多層高樓；炸前方地基掀翻整棟
    name: '紙箱大樓', ammo: 11, build() {
      plankTower(-5, -11, 3)
      plankTower(5, -11, 3)
      plankTower(0, -13, 4)                                // 中央更高
      addBody('gastank', 0, -10, 0)                        // 中央地基弱點
      addBody('gastank', -5, -8.5, 0); addBody('gastank', 5, -8.5, 0)   // 兩側地基弱點
      pigColumn(-2, -7.5, 1); pigColumn(2, -7.5, 1)        // 前排動物
    }
  },
  {
    // 摩天要塞：中央超高紙箱大樓 + 兩側爆裂地基高塔，地基弱點成串可連環崩塌
    name: '摩天要塞', ammo: 13, build() {
      plankTower(0, -14, 4)                          // 中央超高紙箱大樓（橫版堆疊）
      tower(-4.5, -11, 4, 'gastank')                 // 左爆裂地基塔
      tower(4.5, -11, 4, 'barrel')                   // 右爆裂地基塔
      addBody('gastank', 0, -11, 0)                  // 中央樓地基弱點（炸它掀翻主樓）
      for (const x of [-2.5, 2.5]) addBody('sack', x, -6.5, 0)   // 前線沙包掩體
      pigColumn(-1.5, -8, 1); pigColumn(1.5, -8, 1)  // 前排動物
    }
  },
  {
    // 天空要塞：集大成終局 — 中央紙箱大樓 + 兩側爆裂高塔 + 難拆硬箱塔 + 縱深後排
    name: '天空要塞', ammo: 14, build() {
      plankTower(0, -15, 5)                                        // 中央超高紙箱大樓
      tower(-4.5, -12, 5, 'gastank'); tower(4.5, -12, 5, 'barrel') // 兩側爆裂地基高塔
      addBody(nextAnimal(), -2.4, -9, hardColumn(-2.4, -9, 3))     // 前排硬箱塔（難震下）+ 動物
      addBody(nextAnimal(), 2.4, -9, hardColumn(2.4, -9, 3))
      addBody('gastank', 0, -10, 0)                               // 中央前線地基弱點
      for (const x of [-3.5, 0, 3.5]) addBody('sack', x, -6.5, 0) // 前線沙包掩體
      pigColumn(-1.5, -17, 2); pigColumn(1.5, -17, 2)             // 縱深後排
    }
  },
]

function resetGame(idx) {
  currentLevel = Math.max(0, Math.min(LEVELS.length - 1, idx))
  clearWorld()
  const L = LEVELS[currentLevel]
  game = { score: 0, ammo: L.ammo, ammoStart: L.ammo, pigs: 0, over: false, cooldown: 0, emptyT: 0, startT: 0, armed: false, intro: true, introT: 0, winDelay: 0, maxFly: 0 }
  hud.msg.classList.add('hidden')
  animIdx = currentLevel * 3                    // 每關從不同動物起輪替，增加跨關變化（可重現）
  L.build()
  game.pigs = entities.filter((e) => isAnimal(e.type)).length
  refreshHUD()
  updateIntroCamera(0)   // 擺到環繞起點
}

// 本場所在模式（給「飛高」榜當額外資訊，不影響排名）
function modeLabel() {
  if (game.happy) return '😄 快樂'
  if (game.endless) return '☠️ 死鬥'
  return (LEVELS[currentLevel] && LEVELS[currentLevel].name) || '關卡'
}
// 結算：送出本場最高飛行到「飛高」榜，並回傳顯示字串
function flySuffix() {
  if (!(game.maxFly > 0)) return ''
  submitScore(Math.round(game.maxFly * 10), FLY_KEY, modeLabel())
  return `　🚀 最高 ${game.maxFly.toFixed(1)} 公尺`
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
  showLevelRank(LEVELS[currentLevel].name, game.score)   // 送分並顯示本關名次
  const last = currentLevel >= LEVELS.length - 1
  hud.msgTitle.textContent = last ? '🏆 全破！' : '🎉 過關！'
  hud.msgText.textContent = `得分 ${game.score}（剩餘彈藥 +${game.ammo * 1000}）` + flySuffix()
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
  hud.msgText.textContent = `還剩 ${game.pigs} 隻動物。得分 ${game.score}` + flySuffix()
  hud.stars.innerHTML = ''
  hud.next.style.display = 'none'
  sfx.lose()
  showLevelRank(LEVELS[currentLevel].name, game.score)   // 送分並顯示本關名次
  hud.msg.classList.remove('hidden'); exitLock()
}

// ============================================================
//  死鬥模式（無限波，每波補彈，純遞增，每 5 波 Boss）
// ============================================================
const ENDLESS_KEY = '死鬥'   // 排行榜 level 鍵：用純中文，避免 emoji 變體選擇字被伺服器清掉導致查詢不match
const FLY_KEY = '飛高'       // 打出動物飛最高的排行榜（分數存 height*10，顯示為公尺）
// 依波數程序生成堡壘（全用現有建築 helper，柱距 2.4 保證不重疊）
function buildWave(n) {
  const boss = n % 5 === 0
  const happy = !!(game && game.happy)   // 快樂模式：怪物更多
  const r = Math.random
  const hi = Math.min(2 + Math.floor(n / 2), boss ? 9 : 6)    // 塔高上限隨波數成長
  const lo = Math.max(2, hi - 2)
  const slotsAll = boss ? [-4.8, -2.4, 2.4, 4.8] : [0, -2.4, 2.4, -4.8, 4.8]
  const count = happy ? slotsAll.length : Math.min(boss ? 4 : 2 + Math.floor(n / 3), slotsAll.length)
  const fChance = Math.min(0.15 + n * 0.05, 0.7)             // 地基放爆裂物的機率隨波數上升
  const hardChance = Math.min(0.1 + n * 0.06, 0.8)          // 用硬箱蓋塔的機率隨波數上升（更難震下）
  const buildStack = (x, z, h, found, hard) => {            // 地基 → 柱 → 屋頂動物
    const base = found ? addBody(found, x, z, 0) : 0
    const top = hard ? hardColumn(x, z, h, base) : variedColumn(x, z, h, base)
    addBody(nextAnimal(), x, z, top)
  }
  for (const x of slotsAll.slice(0, count)) {
    const h = lo + Math.floor(r() * (hi - lo + 1))
    const z = -9 - Math.floor(r() * 4)
    const found = (boss || r() < fChance) ? (r() < 0.5 ? 'gastank' : 'barrel') : null
    buildStack(x, z, h, found, r() < hardChance)
  }
  if (happy || n >= 2) { pigColumn(-1.4, -7, 1); pigColumn(1.4, -7, 1) }   // 前排動物
  if (happy || n >= 3) for (const x of [-3.6, 3.6]) addBody(r() < 0.5 ? 'brick' : 'sack', x, -6.3, 0)  // 前排掩體
  const backRows = happy ? 5 : Math.min(Math.floor(n / 4), 3)             // 縱深後排（快樂模式更多）
  for (let i = 0; i < backRows; i++) { pigColumn((i - (backRows - 1) / 2) * 2.4, -15 - i, 2); if (happy) pigColumn((i - (backRows - 1) / 2) * 2.4 + 1.2, -15 - i, 1) }
  if (boss) {                                                          // Boss：中央超高硬箱塔 + 中央前線爆裂桶
    buildStack(0, -14, Math.min(6 + Math.floor(n / 5), 10), 'gastank', true)
    addBody('gastank', 0, -8, 0)
  }
}
// 硬箱柱：往上疊 n 個硬箱，回傳頂高
function hardColumn(x, z, n, base = 0) {
  let top = base
  for (let i = 0; i < n; i++) top = addBody('hardbox', x, z, top)
  return top
}
// 每波補彈量：只看波數、與動物數脫鉤（Boss 動物多但補彈不變 → 變難）
const MAX_HOLD = 10   // 身上彈藥上限
function waveAmmo(n) {
  return Math.min(3 + Math.floor(n / 4), 5)   // 每波補 3~5 顆（隨波數 3→5）
}
function startEndless(happy = false) {
  initAudio()
  if (musicEnabled) music.start()
  clearWorld()
  // 快樂：所有特殊彈無限（值 Infinity）；死鬥：開局帶裝備的 3 種各 1 顆，之後靠金幣在商店補
  const specials = {}
  if (happy) for (const s of SPECIALS) specials[s.key] = Infinity
  else for (const k of equippedKeys()) specials[k] = 1
  game = { score: 0, coins: 0, ammo: 0, ammoStart: 0, pigs: 0, over: false, cooldown: 0, emptyT: 0, startT: 0, armed: false, intro: false, introT: 0, winDelay: 0, endless: true, happy, wave: 0, paused: false, maxFly: 0,
    specials, selected: null }
  bumpPlays()
  overlay.classList.add('hidden'); hud.msg.classList.add('hidden')
  document.getElementById('landing').classList.add('hidden')
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.toggle('hidden', IS_TOUCH)   // 桌機顯示 Esc 提示；手機用暫停鈕
  nextWave()
  if (!IS_TOUCH) canvas.requestPointerLock()   // 觸控裝置不用指標鎖定，改用虛擬搖桿
}
function nextWave() {
  clearWorld()
  game.wave++
  animIdx = game.wave * 3
  buildWave(game.wave)
  const animals = entities.filter((e) => isAnimal(e.type)).length
  game.pigs = animals
  const refill = waveAmmo(game.wave)
  game.ammo = game.happy ? 999 : Math.min(game.ammo + refill, MAX_HOLD)   // 快樂模式無限彈;死鬥補彈上限 10
  game.ammoStart = game.ammo
  game.startT = 0; game.armed = false; game.emptyT = 0; game.winDelay = 0
  refreshHUD()
  showWaveBanner(game.wave, game.happy ? null : refill)
  if (game.wave === 1) { game.intro = true; game.introT = 0; updateIntroCamera(0) }  // 只有第一波運鏡
}
const HAPPY_KEY = '快樂'
function endEndless() {
  if (game.over) return
  game.over = true
  hud.msgTitle.textContent = game.happy ? '😄 快樂模式結束' : '☠️ 死鬥結束'
  hud.msgText.textContent = `撐到第 ${game.wave} 波・得分 ${game.score}` + flySuffix()
  hud.stars.innerHTML = ''
  hud.next.style.display = 'none'
  sfx.lose()
  showLevelRank(game.happy ? HAPPY_KEY : ENDLESS_KEY, game.score, String(game.wave))   // 送分＋波數（不影響排名）
  document.getElementById('pause-hint').classList.add('hidden')
  hud.msg.classList.remove('hidden'); exitLock()
}
function showWaveBanner(wave, refill) {
  const boss = wave % 5 === 0
  const el = document.getElementById('wave-banner')
  if (!el) return
  const sub = refill == null ? '🔫 無限火力' : `+${refill} 彈藥`
  el.innerHTML = `<div class="wb-title">${boss ? '☠️ BOSS 波' : '第 ' + wave + ' 波'}</div><div class="wb-sub">${sub}</div>`
  el.classList.toggle('boss', boss)
  el.classList.remove('hidden'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show')
}
// 暫停 / 繼續 / 結束（死鬥模式用 Esc；手機用暫停鈕，一般關卡也適用）
function pauseGame() {
  if (!game || game.over || game.paused || game.intro) return
  game.paused = true
  const endBtn = document.getElementById('end-btn')
  if (game.endless) {
    document.getElementById('pause-text').textContent = `第 ${game.wave} 波・目前得分 ${game.score}`
    endBtn.textContent = game.happy ? '😄 結束快樂模式' : '☠️ 結束死鬥'
  } else {
    document.getElementById('pause-text').textContent = `${LEVELS[currentLevel].name}・目前得分 ${game.score}`
    endBtn.textContent = '← 回選單'
  }
  document.getElementById('pause').classList.remove('hidden')
}
function resumeGame() {
  if (!game) return
  game.paused = false
  document.getElementById('pause').classList.add('hidden')
  if (!IS_TOUCH) canvas.requestPointerLock()   // 觸控裝置不用指標鎖定，改用虛擬搖桿
}
function pauseEnd() {
  game.paused = false
  document.getElementById('pause').classList.add('hidden')
  if (game.endless) endEndless()   // 死鬥：結算送分；一般關卡：回選單
  else showMenu()
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
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.add('hidden')
  if (game) game.paused = false
  buildLevelSelect()
  updateMusicBtn()
  const who = document.getElementById('who')
  if (who) who.innerHTML = playerName ? `玩家：<b>${escapeHtml(playerName)}</b>` : ''
  overlay.classList.remove('hidden')
}

function startLevel(idx) {
  initAudio()
  if (musicEnabled) music.start()
  resetGame(idx)
  bumpPlays()                 // 累計遊玩場次 +1
  overlay.classList.add('hidden')
  hud.msg.classList.add('hidden')
  if (!IS_TOUCH) canvas.requestPointerLock()   // 觸控裝置不用指標鎖定，改用虛擬搖桿
}

// ---- 背景音樂開關（記憶偏好）----
let musicEnabled = localStorage.getItem('fps3d_music') !== 'off'
function updateMusicBtn() {
  const b = document.getElementById('music-toggle')
  if (b) b.innerHTML = `<span class="ico">${musicEnabled ? '🔊' : '🔇'}</span>${musicEnabled ? '音樂開' : '音樂關'}`
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

// ============================================================
//  玩家名字 + 本地排行榜（參考 fake-whiteout-survival 的登入門檻與排行榜；
//  本專案為靜態站，無後端，改用 localStorage 儲存，與該專案無後端時的 fallback 相同）
// ============================================================
const NAME_KEY = 'angrypig:name', LB_KEY = 'angrypig:scores', DEVICE_KEY = 'angrypig:device'
let playerName = (localStorage.getItem(NAME_KEY) || '').trim()
function setPlayerName(n) { playerName = (n || '').trim().slice(0, 12); localStorage.setItem(NAME_KEY, playerName) }
// 裝置 id（給後端限流/去重用）
let deviceId = localStorage.getItem(DEVICE_KEY)
if (!deviceId) { deviceId = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(DEVICE_KEY, deviceId) }

function loadLB() { try { const a = JSON.parse(localStorage.getItem(LB_KEY)); return Array.isArray(a) ? a : [] } catch { return [] } }
// 本機分數存一份，並嘗試上傳後端；回傳後端算出的該關名次 { rank, total, best }（離線則 null）
async function submitScore(score, levelName, note) {
  if (!playerName || !(score > 0)) return null
  const a = loadLB()
  a.push({ name: playerName, score, level: levelName, note: note || '', at: Date.now() })
  a.sort((x, y) => y.score - x.score)
  try { localStorage.setItem(LB_KEY, JSON.stringify(a.slice(0, 100))) } catch {}
  try {
    const res = await fetch('/api/score', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: playerName, score, level: levelName, note: note || '', deviceId }),
    })
    if (res.ok) { const j = await res.json(); if (j && j.ok) return j }
  } catch {}
  return null
}
// 本機名次（後端離線時用）：以本機各名字該關最高分計算
function localRank(score, levelName) {
  const best = {}
  for (const r of loadLB()) if (r.level === levelName) best[r.name] = Math.max(best[r.name] || 0, r.score)
  const mine = best[playerName] != null ? best[playerName] : score
  const vals = Object.values(best)
  return { rank: 1 + vals.filter((v) => v > mine).length, total: Math.max(1, vals.length), best: mine, local: true }
}
// 本機前 N 名：有 level → 該關各名字最高分；無 level → 各名字「每關最高分加總」
function localTop(levelName, n) {
  if (levelName) {
    const best = {}
    for (const r of loadLB()) {
      if (r.level !== levelName) continue
      if (!best[r.name] || r.score > best[r.name].score) best[r.name] = { name: r.name, score: r.score, note: r.note || '' }
    }
    return Object.values(best).sort((x, y) => y.score - x.score).slice(0, n)
  }
  // 全部關卡：先取每人每關最高分，再加總
  const byName = {}   // name -> { level -> best }
  for (const r of loadLB()) {
    const m = (byName[r.name] = byName[r.name] || {})
    if (!(r.level in m) || r.score > m[r.level]) m[r.level] = r.score
  }
  return Object.entries(byName)
    .map(([name, levels]) => ({ name, score: Object.values(levels).reduce((a, b) => a + b, 0) }))
    .sort((x, y) => y.score - x.score).slice(0, n)
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtScore = (level, v) => level === FLY_KEY ? (Number(v) / 10).toFixed(1) + ' 公尺' : Number(v).toLocaleString()
// 額外資訊徽章（不影響排名）：死鬥/快樂＝第 N 波；飛高＝達成模式
function lbNote(level, note) {
  if (!note) return ''
  if (level === ENDLESS_KEY || level === HAPPY_KEY) return `<span class="lb-note">第 ${escapeHtml(note)} 波</span>`
  if (level === FLY_KEY) return `<span class="lb-note">${escapeHtml(note)}</span>`
  return ''
}
function lbRowsHtml(rows, showLevel, level) {
  return rows.map((r, i) =>
    `<div class="lb-row${r.name === playerName ? ' me' : ''}"><span class="lb-rank${i < 3 ? ' top' : ''}">${i + 1}</span>` +
    `<span class="lb-name">${escapeHtml(r.name)}</span>` +
    (showLevel ? `<span class="lb-lv">${escapeHtml(r.level || '')}</span>` : '') +
    lbNote(level, r.note) +
    `<span class="lb-score">${fmtScore(level, r.score)}</span></div>`).join('')
}
// 主排行榜彈窗：先顯示本機、再用後端覆蓋；level 為空＝全關
async function renderLeaderboard(levelName) {
  const list = document.getElementById('lb-list')
  const label = levelName ? `🌐 ${levelName}` : '🌐 全部關卡總分（各關最高分加總）'
  const localLabel = levelName ? `📱 ${levelName}（本機）` : '📱 全部關卡總分（本機）'
  const src = (remote) => `<div class="lb-src">${remote ? label : localLabel}</div>`
  const empty = levelName ? '這一關還沒有紀錄，搶頭香！' : '還沒有紀錄，開始第一場吧！'
  const draw = (rows, remote) =>
    list.innerHTML = rows.length ? src(remote) + lbRowsHtml(rows, false, levelName)
      : src(remote) + `<div class="lb-empty">${empty}</div>`
  draw(localTop(levelName, 10), false)
  try {
    const res = await fetch(`/api/leaderboard?limit=10${levelName ? '&level=' + encodeURIComponent(levelName) : ''}`)
    if (res.ok) { const rows = await res.json(); if (Array.isArray(rows)) draw(rows, true) }
  } catch {}
}
// 結算畫面：送出分數 → 顯示本關名次 + 本關前幾名（highlight 自己）
async function showLevelRank(levelName, score, note) {
  hud.msgRank.textContent = '結算名次中…'; hud.msgLb.innerHTML = ''
  if (score > 0) {
    const info = (await submitScore(score, levelName, note)) || localRank(score, levelName)
    const src = info.local ? '📱 本機' : '🌐 全球'
    hud.msgRank.innerHTML = `本關排名 <b>第 ${info.rank}</b> / ${info.total} 名　<span class="rank-src">${src}</span>`
  } else {
    hud.msgRank.innerHTML = '<span class="rank-src">本場 0 分，未計入排行</span>'
  }
  let rows = localTop(levelName, 5), remote = false
  try {
    const res = await fetch(`/api/leaderboard?limit=5&level=${encodeURIComponent(levelName)}`)
    if (res.ok) { const r = await res.json(); if (Array.isArray(r)) { rows = r; remote = true } }
  } catch {}
  hud.msgLb.innerHTML = rows.length
    ? `<div class="lb-src">${remote ? '🌐 本關前 5 名' : '📱 本關前 5 名（本機）'}</div>` + lbRowsHtml(rows, false, levelName)
    : ''
}

// ============================================================
//  社群：線上人數 / 累計遊玩 / 留言板 / 上線歷史（後端離線時各自靜默）
// ============================================================
async function postHeartbeat() {
  try { await fetch('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) }) } catch {}
}
async function refreshOnline() {
  try { const r = await fetch('/api/online'); if (r.ok) { const j = await r.json(); const el = document.getElementById('online-n'); if (el && j.online != null) el.textContent = j.online } } catch {}
}
const fmtDuration = (sec) => {
  sec = Math.max(0, Math.round(sec))
  if (sec < 3600) return Math.round(sec / 60) + ' 分'
  if (sec < 86400) return (sec / 3600).toFixed(1) + ' 小時'
  return (sec / 86400).toFixed(1) + ' 天'
}
async function refreshTotals() {
  try {
    const r = await fetch('/api/totals'); if (!r.ok) return
    const j = await r.json()
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v }
    set('total-plays', Number(j.plays || 0).toLocaleString())
    set('total-kills', Number(j.kills || 0).toLocaleString())
    set('total-time', fmtDuration(j.seconds || 0))
  } catch {}
}
function bumpPlays() { fetch('/api/totals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs: 1 }) }).catch(() => {}) }
// 全服累計：消滅動物數 + 遊玩秒數 —— 遊戲中累積，定期/離開時上傳（成功才清零）
let pendingKills = 0, pendingSeconds = 0
function flushTotals() {
  const k = pendingKills, s = Math.floor(pendingSeconds)
  if (k <= 0 && s <= 0) return
  fetch('/api/totals', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kills: k, seconds: s }),
  }).then((r) => { if (r.ok) { pendingKills -= k; pendingSeconds -= s } }).catch(() => {})
}

const timeAgo = (at) => {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return '剛剛'
  if (s < 3600) return Math.floor(s / 60) + ' 分鐘前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小時前'
  return Math.floor(s / 86400) + ' 天前'
}
// ---- 留言板 ----
async function loadMessages() {
  const list = document.getElementById('msg-list')
  list.innerHTML = '<div class="m-empty">載入中…</div>'
  let msgs = null
  try { const r = await fetch('/api/messages'); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) msgs = j } } catch {}
  if (msgs === null) { list.innerHTML = '<div class="m-empty">留言板需連線到伺服器（線上版才可用）</div>'; return }
  if (!msgs.length) { list.innerHTML = '<div class="m-empty">還沒有留言，搶頭香！</div>'; return }
  list.innerHTML = msgs.map((m) =>
    `<div class="msg-item"><div><span class="m-name">${escapeHtml(m.name)}</span>` +
    `<span class="m-when">${timeAgo(m.at)}</span></div>` +
    `<div class="m-text">${escapeHtml(m.text)}</div></div>`).join('')
}
async function sendMessage() {
  const input = document.getElementById('msg-text')
  const text = input.value.trim()
  if (!text) return
  const btn = document.getElementById('msg-send'); btn.disabled = true
  try {
    const r = await fetch('/api/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: playerName || '匿名', text, deviceId }),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.ok) { input.value = ''; await loadMessages() }
    else if (j.error === 'too fast') alert('留言太頻繁，請稍候再試')
    else if (j.error === 'blocked') alert('留言含不當字詞，已擋下')
    else alert('留言失敗（需連線到線上版）')
  } catch { alert('留言失敗（需連線到線上版）') }
  btn.disabled = false
}
// ---- 上線人數歷史 ----
const dayLabel = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()}` }
async function openOnline() {
  const body = document.getElementById('online-body')
  body.innerHTML = '<div class="on-empty">載入中…</div>'
  document.getElementById('online-modal').classList.remove('hidden')
  let online = null, hist = []
  try { const r = await fetch('/api/online'); if (r.ok) online = (await r.json()).online } catch {}
  try { const r = await fetch('/api/online-history'); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) hist = j } } catch {}
  const nowLine = `<div class="on-now">目前線上 <b>${online != null ? online : '–'}</b> 人 · 最近 7 天每日尖峰</div>`
  if (!hist.length) { body.innerHTML = nowLine + '<div class="on-empty">還沒有歷史資料，等大家上線後逐日記錄</div>'; return }
  const W = 300, H = 120, padX = 24, padY = 18
  const max = Math.max(1, ...hist.map((d) => d.peak))
  const n = hist.length
  const pts = hist.map((d, i) => {
    const x = n <= 1 ? W / 2 : padX + (i / (n - 1)) * (W - 2 * padX)
    const y = padY + (1 - d.peak / max) * (H - 2 * padY)
    return { x, y, peak: d.peak, label: dayLabel(d.at) }
  })
  const poly = pts.map((p) => `${p.x},${p.y}`).join(' ')
  const dots = pts.map((p) =>
    `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#e0533b"/>` +
    `<text x="${p.x}" y="${p.y - 7}" fill="#666" font-size="10" font-weight="bold" text-anchor="middle">${p.peak}</text>` +
    `<text x="${p.x}" y="${H - 3}" fill="#999" font-size="9" text-anchor="middle">${p.label}</text>`).join('')
  body.innerHTML = nowLine +
    `<svg viewBox="0 0 ${W} ${H}"><polyline points="${poly}" fill="none" stroke="#e0533b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`
}

// ---- 登入頁 / 排行榜彈窗 ----
const landing = document.getElementById('landing')
const nameInput = document.getElementById('name-input')
const startBtn = document.getElementById('start-btn')
const endlessBtn = document.getElementById('endless-btn')
const happyBtn = document.getElementById('happy-btn')
const lbModal = document.getElementById('lb-modal')
function refreshStartBtn() {
  const ok = nameInput.value.trim().length > 0
  startBtn.disabled = !ok
  endlessBtn.disabled = !ok
  happyBtn.disabled = !ok
  document.getElementById('name-hint').style.visibility = ok ? 'hidden' : 'visible'
  if (ok) setPlayerName(nameInput.value)   // 即時存名字，供排行榜/留言/死鬥使用
}
function showLanding() {
  exitLock()
  hud.msg.classList.add('hidden')
  overlay.classList.add('hidden')
  lbModal.classList.add('hidden')
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.add('hidden')
  if (game) game.paused = false
  nameInput.value = playerName
  refreshStartBtn()
  updateMusicBtn()                    // 音樂鈕現在在首頁
  landing.classList.remove('hidden')
  nameInput.focus()
  flushTotals(); refreshOnline(); setTimeout(refreshTotals, 400)   // 先上傳本場累積，再更新全服統計
}
function beginFromLanding() {
  if (nameInput.value.trim().length === 0) return
  setPlayerName(nameInput.value)
  landing.classList.add('hidden')
  showMenu()
}
nameInput.addEventListener('input', refreshStartBtn)
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') beginFromLanding() })
startBtn.addEventListener('click', beginFromLanding)
endlessBtn.addEventListener('click', () => { if (nameInput.value.trim().length === 0) return; setPlayerName(nameInput.value); startEndless(false) })
happyBtn.addEventListener('click', () => { if (nameInput.value.trim().length === 0) return; setPlayerName(nameInput.value); startEndless(true) })
document.getElementById('to-home').addEventListener('click', showLanding)
// 排行榜分頁：只呈現總分 / 死鬥 / 快樂 / 飛最高（隱藏各關成績，改點選）
const LB_TABS = [
  { k: '', label: '🏆 總分' },
  { k: '死鬥', label: '☠️ 死鬥' },
  { k: '快樂', label: '😄 快樂' },
  { k: '飛高', label: '🚀 飛最高' },
]
let lbTab = ''
const lbTabsEl = document.getElementById('lb-tabs')
lbTabsEl.innerHTML = LB_TABS.map((t) => `<button class="lb-tab" data-k="${t.k}">${t.label}</button>`).join('')
function setLbTab(k) {
  lbTab = k
  for (const b of lbTabsEl.children) b.classList.toggle('active', b.dataset.k === k)
  renderLeaderboard(k)
}
lbTabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]')
  if (b) setLbTab(b.dataset.k)
})
function openLB(levelName) {
  setLbTab(levelName != null ? levelName : '')
  lbModal.classList.remove('hidden')
}
document.getElementById('lb-close').addEventListener('click', () => lbModal.classList.add('hidden'))
lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.classList.add('hidden') })
document.getElementById('lb-btn-landing').addEventListener('click', () => openLB())

// ---- 留言板 / 上線人數 彈窗 ----
const msgModal = document.getElementById('msg-modal'), onlineModal = document.getElementById('online-modal')
function openMsg() { loadMessages(); msgModal.classList.remove('hidden') }
document.getElementById('msg-btn-landing').addEventListener('click', openMsg)
document.getElementById('online-btn-landing').addEventListener('click', openOnline)
document.getElementById('msg-send').addEventListener('click', sendMessage)
document.getElementById('msg-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage() })
// 關閉鈕（data-close）與點背景關閉
for (const btn of document.querySelectorAll('.mclose[data-close]')) {
  btn.addEventListener('click', () => {
    const m = document.getElementById(btn.dataset.close)
    if (m === shopModal && shopMode === 'buy') return   // 補給站不能用 ✕ 關，只能按繼續
    m.classList.add('hidden')
  })
}
// 商店（裝備特殊彈藥）
const shopModal = document.getElementById('shop-modal')
function openShop() { shopMode = 'equip'; renderShop(); shopModal.classList.remove('hidden') }
document.getElementById('shop-btn-landing').addEventListener('click', openShop)
// 死鬥每 10 波：暫停開啟補給商店（花金幣補貨），按「繼續」才進下一波
function openRunShop() {
  game.paused = true; game.selected = null
  shopMode = 'buy'; renderShop(); shopModal.classList.remove('hidden')
  exitLock()   // 釋放指標鎖定才能點按鈕
}
function closeRunShop() {
  shopModal.classList.add('hidden')
  game.paused = false
  nextWave()
  if (!IS_TOUCH) canvas.requestPointerLock()
}
document.getElementById('shop-continue').addEventListener('click', closeRunShop)
document.getElementById('shop-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sp]'); if (!b) return
  const key = b.dataset.sp
  const head = document.getElementById('shop-count')
  if (shopMode === 'buy') {
    const s = SPECIALS.find((x) => x.key === key); if (!s) return
    if ((game.coins || 0) < s.price) { if (head) { head.classList.add('warn'); setTimeout(() => head.classList.remove('warn'), 900) } return }
    game.coins -= s.price
    game.specials[key] = (game.specials[key] || 0) + 1
    sfx.pop(); renderShop()
    return
  }
  // 裝備模式：切換開局 3 種
  if (!loadout[key] && equippedKeys().length >= 3) { if (head) { head.textContent = '最多裝備 3 種！'; head.classList.add('warn'); setTimeout(() => head.classList.remove('warn'), 900) } return }
  loadout[key] = !loadout[key]; saveLoadout(); renderShop()
})
// 特殊彈藥槽：點選（手機）；桌機用 1/2/3 鍵
document.getElementById('specials').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sp]'); if (b) selectSpecial(b.dataset.sp)
})
document.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '9') { const k = slotKeys()[+e.key - 1]; if (k) selectSpecial(k) }
})
for (const m of [msgModal, onlineModal, shopModal]) m.addEventListener('click', (e) => {
  if (e.target !== m) return
  if (m === shopModal && shopMode === 'buy') return   // 補給站不能點背景關閉
  m.classList.add('hidden')
})
// 心跳 + 線上人數：載入即上報，之後每 60 秒
postHeartbeat(); refreshOnline(); refreshTotals()
setInterval(() => { postHeartbeat(); refreshOnline() }, 60000)
setInterval(flushTotals, 30000)   // 每 30 秒上傳一次累積的消滅數/遊玩時間
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTotals() })

document.getElementById('retry').addEventListener('click', () => (game && game.endless ? startEndless(game.happy) : startLevel(currentLevel)))
document.getElementById('next').addEventListener('click', () => startLevel(currentLevel + 1))
for (const id of ['to-menu', 'to-menu2']) {
  const el = document.getElementById(id)
  if (el) el.addEventListener('click', showMenu)
}
document.getElementById('music-toggle').addEventListener('click', toggleMusic)
document.getElementById('resume-btn').addEventListener('click', resumeGame)
document.getElementById('end-btn').addEventListener('click', pauseEnd)
document.getElementById('pause-btn').addEventListener('click', pauseGame)   // 手機暫停鈕
document.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') toggleMusic() })

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas
  if (!locked) {
    charging = false; hideTrajectory(); hud.power.style.width = '0%'
    // Esc 放開滑鼠：死鬥模式 → 暫停選單；一般關卡進行中 → 回主選單；勝負畫面維持 msg
    if (game && game.endless && !game.over) pauseGame()
    else if (!game || !game.over) showMenu()
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
// 開火：按下蓄力、放開發射（滑鼠與觸控共用）
function fireDown() {
  if (!game || game.over || game.paused) return
  if (game.intro) { endIntro(); return }   // 開場運鏡中 → 直接跳過
  if (game.cooldown > 0) return
  if (game.ammo <= 0 && !hasUsableSelected()) return   // 沒普通彈、也沒選可用特殊彈 → 不發射
  charging = true; chargeT = 0
}
function fireUp() {
  if (!charging) return
  const power = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
  charging = false; hideTrajectory(); hud.power.style.width = '0%'
  if (hasUsableSelected()) {                       // 發射選定的特殊彈（不扣普通彈藥）
    const sel = game.selected
    throwSpecial(sel, power)
    if (!game.happy) { game.specials[sel]--; if (game.specials[sel] <= 0) game.selected = null }   // 快樂無限不消耗
    game.cooldown = 0.45; refreshHUD()
  } else {
    throwBall(power); sfx.throw()
    if (!game.happy) game.ammo--   // 快樂模式無限彈
    game.cooldown = 0.45; refreshHUD()
  }
}
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  // 未鎖定（剛從暫停繼續、或瀏覽器冷卻擋掉自動鎖定）→ 點畫面重新鎖定（觸控裝置不鎖定）
  if (!locked) { if (!IS_TOUCH && game && !game.over && !game.paused) canvas.requestPointerLock(); return }
  fireDown()
})
window.addEventListener('mouseup', (e) => { if (e.button === 0) fireUp() })

// ---- 手機：虛擬搖桿（控準星方向）+ 發射鈕 ----
const LOOK_RATE = 0.48   // 虛擬搖桿轉視角速率（越低越不靈敏）
let lookX = 0, lookY = 0
const touchControls = document.getElementById('touch-controls')
const hudEl = document.getElementById('hud')
{
  const base = document.getElementById('joystick'), knob = document.getElementById('joy-knob')
  const fireBtn = document.getElementById('fire-btn')
  const JOY_R = 40
  let joyId = null, cx = 0, cy = 0
  const setKnob = (kx, ky) => { knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))` }
  const updateJoy = (t) => {
    const dx = t.clientX - cx, dy = t.clientY - cy
    const d = Math.hypot(dx, dy) || 1, m = Math.min(d, JOY_R), a = Math.atan2(dy, dx)
    const kx = Math.cos(a) * m, ky = Math.sin(a) * m
    setKnob(kx, ky); lookX = kx / JOY_R; lookY = ky / JOY_R
  }
  base.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; joyId = t.identifier
    const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2
    updateJoy(t); e.preventDefault()
  }, { passive: false })
  window.addEventListener('touchmove', (e) => {
    if (joyId == null) return
    for (const t of e.changedTouches) if (t.identifier === joyId) { updateJoy(t); e.preventDefault() }
  }, { passive: false })
  const endJoy = (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; lookX = lookY = 0; setKnob(0, 0) } }
  window.addEventListener('touchend', endJoy); window.addEventListener('touchcancel', endJoy)
  fireBtn.addEventListener('touchstart', (e) => { e.preventDefault(); fireDown() }, { passive: false })
  fireBtn.addEventListener('touchend', (e) => { e.preventDefault(); fireUp() }, { passive: false })
}

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
  if (game && game.paused) { renderer.render(scene, camera); return }   // 暫停：凍結物理/計時/特效，只維持畫面
  updateEnv(dt)

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
      // 手機虛擬搖桿：控準星方向
      if (IS_TOUCH && (lookX || lookY)) {
        yaw -= lookX * LOOK_RATE * dt
        pitch -= lookY * LOOK_RATE * dt
        pitch = Math.max(-1.45, Math.min(1.0, pitch))
        camera.rotation.y = yaw; camera.rotation.x = pitch
      }
      if (game.cooldown > 0) game.cooldown -= dt
      if (charging) {
        chargeT += dt
        const power = Math.max(0.12, Math.min(1, chargeT / CHARGE_TIME))
        hud.power.style.width = (power * 100) + '%'
        showTrajectory(power)
      }
      pendingSeconds += dt   // 全服累計遊玩時間
      // 起始緩衝：等堆疊穩定後才開始判定豬落地（避免開場晃動誤殺）
      game.startT += dt
      if (!game.armed && game.startT > 1.5) game.armed = true
      // 豬落地判定：中心高度掉到接近地面就算死
      if (game.armed) {
        for (const e of entities) {
          if (isAnimal(e.type) && !e.dead && e.body.position.y < (e.hy || 0.5) + GROUND_MARGIN) killAnimal(e)
        }
      }
      // 彈藥用盡且場面靜止 → 判負（死鬥模式則結算死鬥成績）
      if (game.ammo <= 0 && game.pigs > 0) {
        game.emptyT += dt
        if (game.emptyT > 4) (game.endless ? endEndless() : lose())
      }
    }
  }

  // 同步 + 動畫 + 清理
  let flyBonus = 0, flyHeight = 0   // 本幀空中動物的最佳表現，供 HUD 倍率條
  const fxActive = game && !game.over && !game.intro && game.armed
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]
    e.group.position.copy(e.body.position)
    e.group.quaternion.copy(e.body.quaternion)
    if (e.mixer) e.mixer.update(dt)
    if (!e.dead && e.maxY !== undefined && e.body.position.y > e.maxY) e.maxY = e.body.position.y  // 追蹤飛行最高點
    if (game && !e.dead && e.startY !== undefined) { const fh = e.body.position.y - e.startY; if (fh > game.maxFly) game.maxFly = fh }   // 全場最高飛行
    // 飛行特效：被擊飛的動物 → 跟隨計數器 + 拖尾 + 里程碑爆字
    if (fxActive && isAnimal(e.type) && !e.dead) {
      const p = e.body.position
      const speed = Math.hypot(e.body.velocity.x, e.body.velocity.y, e.body.velocity.z)
      const height = e.maxY - e.startY
      const dist = Math.hypot(p.x - e.spawnX, p.z - e.spawnZ)
      if (!e.launched && (speed > 4 || height > 0.6 || dist > 1.0)) e.launched = true
      if (e.launched) {
        const bonus = bonusFor(height, dist)
        updateTag(e, bonus)
        emitTrail(e, speed, dt)
        while (e.msH < MS_HEIGHT.length && height >= MS_HEIGHT[e.msH].v) {
          spawnFloater(p, (e.hy || 0.8) + 1.0, MS_HEIGHT[e.msH].t, { fill: '#9fe6ff', size: 58, life: 0.85, rise: 2.4, grow: 0.9, worldScale: 2.2 }); e.msH++
        }
        while (e.msD < MS_DIST.length && dist >= MS_DIST[e.msD].v) {
          spawnFloater(p, (e.hy || 0.8) + 0.5, MS_DIST[e.msD].t, { fill: '#ffd0f0', size: 58, life: 0.85, rise: 2.4, grow: 0.9, worldScale: 2.2 }); e.msD++
        }
        if (bonus > flyBonus) { flyBonus = bonus; flyHeight = height }
        // 靜止一段時間仍未死亡（安全落回）→ 收掉特效，允許再次擊飛
        if (speed < 0.6) { e.calmT = (e.calmT || 0) + dt; if (e.calmT > 0.8) endFlightFX(e) }
        else e.calmT = 0
      }
    }
    if (e.type === 'ball' || e.type === 'bomb' || e.type === 'split' || e.type === 'summon') {
      e.born += dt
      if (e.type === 'summon') {                        // 召喚豬：水平衝刺 + 主動把沿路物件撞飛
        e.body.wakeUp()
        if (e.born < 5) { e.body.velocity.x = e.dir.x * 30; e.body.velocity.z = e.dir.z * 30 }
        const P = e.body.position, R = e.reach
        for (const o of entities) {
          if (o === e || o.type === 'summon' || o.type === 'ball' || o.type === 'bomb' || o.type === 'split') continue
          if (e.hit.has(o)) continue
          const dx = o.body.position.x - P.x, dz = o.body.position.z - P.z, dy = o.body.position.y - P.y
          const d2 = Math.hypot(dx, dz)
          if (d2 > R || Math.abs(dy) > R + 1.5) continue
          e.hit.add(o); o.body.wakeUp()
          const m = o.body.mass || 1, inv = 1 / (d2 || 1)
          o.body.applyImpulse(new CANNON.Vec3(
            (e.dir.x * 16 + dx * inv * 5) * m, 12 * m, (e.dir.z * 16 + dz * inv * 5) * m),
            new CANNON.Vec3(0, 0, 0))
          playStomp(4)                                  // 撞飛：悶重撞擊聲（不再震動，避免頭暈）
        }
      }
      if (e.type === 'split' && !e.split) {   // 載體前兆：青色火花（充能中）
        e.fuseT = (e.fuseT || 0) + dt
        if (e.fuseT > 0.04) {
          e.fuseT = 0; const p = e.body.position
          addSpark(p.x, p.y, p.z, 0.24 + Math.random() * 0.12, CYAN(), { life: 0.24, grow: -0.5 })
        }
      }
      if (e.type === 'split' && e.born > 0.3 && !e.split) { e.split = true; doSplit(e) }   // 分裂成霰彈
      if (e.pellet) {   // 霰彈青色拖尾
        e.sparkT = (e.sparkT || 0) + dt
        if (e.sparkT > 0.03) { e.sparkT = 0; const p = e.body.position; addSpark(p.x, p.y, p.z, 0.28, CYAN(), { life: 0.22 }) }
      }
      if (e.type === 'bomb' && !e.boom) {   // 引信火花（飛行中）
        e.fuseT = (e.fuseT || 0) + dt
        if (e.fuseT > 0.04) {
          e.fuseT = 0; const p = e.body.position
          addSpark(p.x, p.y + 0.35, p.z, 0.22 + Math.random() * 0.12, new THREE.Color().setHSL(0.13, 1, 0.65),
            { vy: 1.2, life: 0.28, grow: -0.6, vx: (Math.random() - 0.5) * 0.6, vz: (Math.random() - 0.5) * 0.6 })
        }
      }
      if (e.onHit && e.hit && !e.done) { e.done = true; triggerCarrier(e.onHit, e.body.position) }   // 命中觸發（黑洞/龍捲/閃電）
      if (e.cluster && e.born > 0.4 && !e.done) { e.done = true; doCluster(e) }   // 集束空中散開
      const maxLife = e.big ? 10 : 7
      const gone = e.done || e.born > maxLife || e.body.position.y < -8 ||
        (e.type === 'bomb' && e.boom) || (e.type === 'split' && e.split) || (e.type === 'summon' && e.born > 5)
      if (gone) { world.removeBody(e.body); scene.remove(e.group); entities.splice(i, 1); const bi = balls.indexOf(e); if (bi >= 0) balls.splice(bi, 1) }
    }
    if (e.dead && e.popping !== undefined) {
      e.popping += dt
      const k = Math.max(0, 1 - e.popping / 0.35)
      e.group.scale.setScalar(k)
      if (k <= 0.001 && !e.removed) { e.removed = true; world.removeBody(e.body); scene.remove(e.group); entities.splice(i, 1) }
    }
  }
  // 全部消滅後不立刻結算：延遲讓最後一隻的「+分數」特效播完
  if (game && !game.over && !game.intro && game.pigs <= 0) {
    game.winDelay += dt
    if (game.endless) {
      if (game.winDelay >= 1.6) {
        addScore(300 + game.wave * 150)
        addCoins(40 + game.wave * 15)   // 每波清空的小額金幣（隨波數微幅成長）
        // 死鬥每 10 波 → 進補給商店（買完再下一波）；快樂模式直接下一波
        if (!game.happy && game.wave % 10 === 0) openRunShop()
        else nextWave()
      }
    } else if (game.winDelay >= WIN_DELAY) win()
  }

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]; f.t += dt
    const k = Math.min(1, f.t / f.life), e = 1 - (1 - k) * (1 - k)   // easeOut 膨脹
    f.mesh.scale.setScalar(f.size0 + f.grow * e)
    f.mesh.material.opacity = Math.max(0, 1 - k)
    if (f.t >= f.life) { scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); flashes.splice(i, 1) }
  }
  // 地面焦痕：慢慢淡掉
  for (let i = scorches.length - 1; i >= 0; i--) {
    const s = scorches[i]; s.t += dt
    s.mesh.material.opacity = Math.max(0, 0.5 * (1 - s.t / s.life))
    if (s.t >= s.life) { scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); scorches.splice(i, 1) }
  }
  // 重力井（黑洞吸入 / 龍捲上捲）
  for (let i = wells.length - 1; i >= 0; i--) {
    const w = wells[i]; w.t += dt
    const R = w.mode === 'in' ? 5.5 : 4.5
    for (const o of entities) {
      if (o.dead || o.type === 'summon') continue
      const dx = o.body.position.x - w.x, dy = o.body.position.y - w.y, dz = o.body.position.z - w.z
      const d = Math.hypot(dx, dy, dz); if (d > R || d < 0.01) continue
      o.body.wakeUp()
      if (w.mode === 'in') {
        const m = o.body.mass || 1, s = 1 - d / R
        o.body.applyImpulse(new CANNON.Vec3(-dx / d * s * 30 * m * dt, (-dy / d * s * 30 + 5) * m * dt, -dz / d * s * 30 * m * dt), ZERO)
      } else {
        // 龍捲：直接命令沿固定半徑高速環繞 + 緩慢上升 → 多轉幾圈才被拋出
        const h = Math.hypot(dx, dz) || 1
        const ux = dx / h, uz = dz / h, tx = -uz, tz = ux            // 外向 / 切線
        const inward = Math.max(-7, Math.min(7, (1.6 - h) * 7))       // 拉回目標半徑 1.6（向心）
        o.body.velocity.x = tx * 15 + ux * inward                     // 切線 15 = 旋轉快、圈數多
        o.body.velocity.z = tz * 15 + uz * inward
        o.body.velocity.y = Math.max(o.body.velocity.y, 2.6)          // 緩慢上升
      }
    }
    if (w.mode === 'in') {
      if (Math.random() < 0.7) { const a = Math.random() * Math.PI * 2, rr = R * 0.85
        addSpark(w.x + Math.cos(a) * rr, w.y + 0.4, w.z + Math.sin(a) * rr, 0.4, new THREE.Color(0.62, 0.3, 0.95),
          { vx: -Math.cos(a) * 5, vz: -Math.sin(a) * 5, life: 0.4 }) }
    } else {   // 龍捲：密集螺旋上升粒子柱（無漏斗）
      w.spin += dt * 9
      for (let k = 0; k < 8; k++) {
        const hgt = Math.random() * 12, rr = 0.4 + (hgt / 12) * 2.0     // 高度加倍（更高的龍捲柱）
        const a = w.spin * 2 + hgt * 1.6 + Math.random() * 0.5         // 沿高度螺旋
        addSpark(w.x + Math.cos(a) * rr, w.y + hgt, w.z + Math.sin(a) * rr, 0.35 + Math.random() * 0.25,
          new THREE.Color(0.85, 0.9, 1),
          { vx: -Math.sin(a) * 6, vz: Math.cos(a) * 6, vy: 4 + Math.random() * 3, life: 0.6 })
      }
    }
    if (w.t >= w.life) {
      if (w.mode === 'in') explode(new CANNON.Vec3(w.x, w.y, w.z), 3)
      if (w.mesh) { scene.remove(w.mesh); w.mesh.geometry.dispose(); w.mesh.material.dispose() }
      wells.splice(i, 1)
    }
  }
  // 閃電線段：快速淡出
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i]; b.t += dt
    b.line.material.opacity = Math.max(0, 1 - b.t / b.life)
    if (b.t >= b.life) { scene.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose(); bolts.splice(i, 1) }
  }

  // 飄升文字（死亡結算 / 里程碑）：向上飄、放大、淡出
  for (let i = floaters.length - 1; i >= 0; i--) {
    const p = floaters[i]; p.t += dt
    p.sprite.position.y += dt * p.rise
    const s = 1 + p.t * p.grow
    p.sprite.scale.set(p.w * s, p.w / 2 * s, 1)
    p.sprite.material.opacity = Math.max(0, 1 - p.t / p.life)
    if (p.t > p.life) {
      scene.remove(p.sprite); p.sprite.material.map.dispose(); p.sprite.material.dispose()
      floaters.splice(i, 1)
    }
  }

  // 光點：拖尾原地縮小；爆炸火星/煙帶速度+重力+成長
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]; s.t += dt
    const k = 1 - s.t / s.life
    if (s.vx !== undefined) {
      s.vy = (s.vy || 0) + (s.g || 0) * dt
      s.sprite.position.x += s.vx * dt; s.sprite.position.y += s.vy * dt; s.sprite.position.z += s.vz * dt
      const sc = s.s0 * (1 + (s.grow || 0) * s.t)
      s.sprite.scale.set(sc, sc, 1)
    } else {
      s.sprite.scale.setScalar(s.s0 * (0.4 + 0.6 * k))
    }
    s.sprite.material.opacity = Math.max(0, k) * (s.op0 || 1)
    if (s.t >= s.life) { scene.remove(s.sprite); s.sprite.material.dispose(); sparks.splice(i, 1) }
  }

  // HUD 空中 BONUS 倍率條 + 即時最高飛行高度（動物上升中會持續攀升）
  updateAirBonusHUD(flyBonus, flyHeight)
  updateFlyBig(dt)
  updateSpecialsHUD()

  // 只在實際遊玩中顯示 HUD / 手機控制項（選單/首頁/暫停/結算時隱藏那條 HUD）
  const inGame = !!game && !game.over && !game.paused &&
    overlay.classList.contains('hidden') && landing.classList.contains('hidden')
  hudEl.style.display = inGame ? '' : 'none'
  if (!inGame && hud.flyBig && !hud.flyBig.classList.contains('hidden')) { hud.flyBig.classList.add('hidden'); flyBigHold = 0 }
  if (touchControls) touchControls.classList.toggle('show', IS_TOUCH && inGame)

  // 畫面震動（FPS 遊玩中）：以 EYE + (pitch,yaw) 為基準加抖動，衰減後還原
  if (shakeMag > 0.001 && game && !game.intro && !game.over && !game.paused) {
    const s = shakeMag, R = () => (Math.random() * 2 - 1)
    camera.position.set(EYE.x + R() * s * 0.18, EYE.y + R() * s * 0.18, EYE.z + R() * s * 0.18)
    camera.rotation.set(pitch + R() * s * 0.03, yaw + R() * s * 0.03, R() * s * 0.03)
    shakeMag = Math.max(0, shakeMag - dt * 4)
    if (shakeMag <= 0.001) { camera.position.copy(EYE); camera.rotation.set(pitch, yaw, 0) }   // 還原
  }

  renderer.render(scene, camera)
}

function resize() {
  // 用實際可視尺寸（iOS 上 innerHeight 會排除瀏覽器工具列），避免畫布比可視區高導致瞄準中心偏移
  const w = window.innerWidth, h = window.innerHeight
  renderer.setSize(w, h)   // updateStyle=true：畫布 CSS 尺寸 = 可視區
  camera.aspect = w / h
  // 直式（手機）時降低 FOV 自動拉近，減少上下大量留白、堡壘更大更好瞄；橫式維持 70
  camera.fov = camera.aspect >= 1 ? 70 : Math.max(60, Math.min(70, 52 + camera.aspect * 22))
  camera.updateProjectionMatrix()
  // 準星對齊畫布正中心（= 相機瞄準點），不靠 CSS 50% 以免 iOS 視窗高度差造成偏移
  const cx = document.getElementById('crosshair')
  cx.style.left = (w / 2) + 'px'; cx.style.top = (h / 2) + 'px'
}
window.addEventListener('resize', resize)
window.addEventListener('orientationchange', resize)
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize)

loadAll().then(() => {
  buildEnvironment()
  resize()
  camera.rotation.set(pitch, yaw, 0)
  buildLevelSelect()
  showLanding()      // 先進登入頁，輸入名字才進選單
  loop()
  document.getElementById('loading').remove()
}).catch((err) => { document.getElementById('loading').textContent = '載入失敗：' + err; console.error(err) })
