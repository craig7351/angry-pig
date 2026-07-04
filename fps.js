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
sun.shadow.mapSize.set(2048, 2048)
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
  // 純裝飾（不參與物理，用來佈置場地邊界與四周）
  fence: 'assets/MetalFence.gltf',
  barrier: 'assets/Barrier_Single.gltf',
  cone: 'assets/TrafficCone.gltf',
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
  const inst = isAnimal(type) ? skeletonClone(proto) : proto.clone(true)
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
      if (v > 6) { ent.hp -= v * 6; if (ent.hp <= 0) { ent.dead = true; ent.popping = 0; explode(body.position, cfg.explosive); game.score += 500 } }
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

// 里程碑門檻（飛行中突破就爆字）
const MS_HEIGHT = [{ v: 2.0, t: '騰空！' }, { v: 4.0, t: '高飛！' }, { v: 6.5, t: '沖天！' }]
const MS_DIST = [{ v: 5, t: '飛遠！' }, { v: 9, t: '超遠！' }, { v: 14, t: '爆遠！' }]

function killAnimal(e) {
  if (e.dead) return
  e.dead = true; e.popping = 0
  const height = Math.max(0, (e.maxY || 0) - (e.startY || 0))
  const dist = Math.hypot(e.body.position.x - (e.spawnX || 0), e.body.position.z - (e.spawnZ || 0))
  const bonus = bonusFor(height, dist)
  game.score += bonus; game.pigs--
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
  airBonus: document.getElementById('air-bonus'), abValue: document.getElementById('ab-value'),
  abFill: document.getElementById('ab-fill'), abMult: document.getElementById('ab-mult'),
}
function refreshHUD() {
  if (!game) return
  hud.score.textContent = game.score
  hud.ammo.textContent = '🔴'.repeat(Math.max(0, game.ammo))
  hud.pigs.textContent = '🐾 ' + Math.max(0, game.pigs)
  hud.level.textContent = `關卡 ${currentLevel + 1}／${LEVELS.length}`
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

function clearWorld() {
  for (const e of entities) { world.removeBody(e.body); scene.remove(e.group); removeTag(e) }
  entities.length = 0; balls.length = 0
  flashes.forEach((f) => scene.remove(f.mesh)); flashes.length = 0
  floaters.forEach((p) => { scene.remove(p.sprite); p.sprite.material.map.dispose(); p.sprite.material.dispose() })
  floaters.length = 0
  sparks.forEach((s) => { scene.remove(s.sprite); s.sprite.material.dispose() }); sparks.length = 0
  if (hud.airBonus) hud.airBonus.classList.add('hidden')
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
]

function resetGame(idx) {
  currentLevel = Math.max(0, Math.min(LEVELS.length - 1, idx))
  clearWorld()
  const L = LEVELS[currentLevel]
  game = { score: 0, ammo: L.ammo, ammoStart: L.ammo, pigs: 0, over: false, cooldown: 0, emptyT: 0, startT: 0, armed: false, intro: true, introT: 0, winDelay: 0 }
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
  recordScore(game.score, LEVELS[currentLevel].name)   // 過關分數進排行榜
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
  recordScore(game.score, LEVELS[currentLevel].name)   // 失敗也記錄本場分數
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
  const who = document.getElementById('who')
  if (who) who.innerHTML = playerName ? `玩家：<b>${escapeHtml(playerName)}</b>` : ''
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
// 送出分數：本機先存一份，同時上傳後端（有部署才會成功；開發/離線自動忽略）
function recordScore(score, levelName) {
  if (!playerName || !(score > 0)) return
  const a = loadLB()
  a.push({ name: playerName, score, level: levelName, at: Date.now() })
  a.sort((x, y) => y.score - x.score)
  try { localStorage.setItem(LB_KEY, JSON.stringify(a.slice(0, 50))) } catch {}
  fetch('/api/score', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: playerName, score, level: levelName, deviceId }),
  }).catch(() => {})
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function drawLB(rows, remote) {
  const list = document.getElementById('lb-list')
  const src = `<div class="lb-src">${remote ? '🌐 全球排行榜' : '📱 本機紀錄（未連線到伺服器）'}</div>`
  if (!rows.length) { list.innerHTML = src + '<div class="lb-empty">還沒有紀錄，開始第一場吧！</div>'; return }
  list.innerHTML = src + rows.map((r, i) =>
    `<div class="lb-row"><span class="lb-rank${i < 3 ? ' top' : ''}">${i + 1}</span>` +
    `<span class="lb-name">${escapeHtml(r.name)}</span>` +
    `<span class="lb-lv">${escapeHtml(r.level || '')}</span>` +
    `<span class="lb-score">${Number(r.score).toLocaleString()}</span></div>`).join('')
}
// 先顯示本機資料，再用後端（若有部署）覆蓋
async function renderLeaderboard() {
  drawLB(loadLB().slice(0, 10), false)
  try {
    const res = await fetch('/api/leaderboard?limit=10')
    if (res.ok) { const rows = await res.json(); if (Array.isArray(rows)) drawLB(rows, true) }
  } catch {}
}

// ---- 登入頁 / 排行榜彈窗 ----
const landing = document.getElementById('landing')
const nameInput = document.getElementById('name-input')
const startBtn = document.getElementById('start-btn')
const lbModal = document.getElementById('lb-modal')
function refreshStartBtn() {
  const ok = nameInput.value.trim().length > 0
  startBtn.disabled = !ok
  document.getElementById('name-hint').style.visibility = ok ? 'hidden' : 'visible'
}
function showLanding() {
  exitLock()
  hud.msg.classList.add('hidden')
  overlay.classList.add('hidden')
  lbModal.classList.add('hidden')
  nameInput.value = playerName
  refreshStartBtn()
  landing.classList.remove('hidden')
  nameInput.focus()
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
document.getElementById('rename-btn').addEventListener('click', showLanding)
function openLB() { renderLeaderboard(); lbModal.classList.remove('hidden') }
document.getElementById('lb-close').addEventListener('click', () => lbModal.classList.add('hidden'))
lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.classList.add('hidden') })
for (const id of ['lb-btn-landing', 'lb-btn-menu']) document.getElementById(id).addEventListener('click', openLB)

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
  let flyBonus = 0, flyHeight = 0   // 本幀空中動物的最佳表現，供 HUD 倍率條
  const fxActive = game && !game.over && !game.intro && game.armed
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]
    e.group.position.copy(e.body.position)
    e.group.quaternion.copy(e.body.quaternion)
    if (e.mixer) e.mixer.update(dt)
    if (!e.dead && e.maxY !== undefined && e.body.position.y > e.maxY) e.maxY = e.body.position.y  // 追蹤飛行最高點
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
  // 全部消滅後不立刻結算：延遲數秒讓最後一隻的「+分數」特效播完，玩家看清得分
  if (game && !game.over && !game.intro && game.pigs <= 0) {
    game.winDelay += dt
    if (game.winDelay >= WIN_DELAY) win()
  }

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]; f.t += dt
    f.mesh.scale.setScalar(1 + f.t * 16); f.mesh.material.opacity = Math.max(0, 0.9 - f.t * 2.5)
    if (f.t > 0.4) { scene.remove(f.mesh); flashes.splice(i, 1) }
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

  // 拖尾光點：快速縮小、淡出
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]; s.t += dt
    const k = 1 - s.t / s.life
    s.sprite.material.opacity = Math.max(0, k)
    s.sprite.scale.setScalar(s.s0 * (0.4 + 0.6 * k))
    if (s.t >= s.life) { scene.remove(s.sprite); s.sprite.material.dispose(); sparks.splice(i, 1) }
  }

  // HUD 空中 BONUS 倍率條
  updateAirBonusHUD(flyBonus, flyHeight)

  renderer.render(scene, camera)
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h; camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)

loadAll().then(() => {
  buildEnvironment()
  resize()
  camera.rotation.set(pitch, yaw, 0)
  buildLevelSelect()
  showLanding()      // 先進登入頁，輸入名字才進選單
  loop()
  document.getElementById('loading').remove()
}).catch((err) => { document.getElementById('loading').textContent = '載入失敗：' + err; console.error(err) })
