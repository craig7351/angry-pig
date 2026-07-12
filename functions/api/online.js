import { json, sanitizeText } from './_lib.js'

// 線上人數 = 近 3 小時內「進過場」的 distinct 裝置數（取代心跳輪詢，大幅降低請求數）
const WINDOW = 3 * 60 * 60 * 1000   // 3 小時

const countActive = (env, since) =>
  env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?').bind(since).first()

// 機會性維護（約 1/8 次）：記錄今日尖峰 + 清除過期 presence(>3h) / rate(>1 天)
async function maybeMaintain(env, now, n) {
  if (Math.random() >= 0.13) return
  const day = Math.floor(now / 86400000)
  await env.DB.prepare('INSERT INTO online_daily (day, peak) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET peak = MAX(peak, ?)')
    .bind(day, n, n).run()
  await env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - WINDOW).run()
  await env.DB.prepare('DELETE FROM rate WHERE last_at < ?').bind(now - 86400000).run()
}

// POST /api/online — 進場：記錄此裝置（依 deviceId upsert，重進不灌數）+ 回傳近 3 小時人數
export const onRequestPost = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const id = sanitizeText(body.deviceId, 64)
    const now = Date.now()
    if (id) {
      await env.DB.prepare('INSERT INTO presence (device_id, last_seen) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen = ?')
        .bind(id, now, now).run()
    }
    const row = await countActive(env, now - WINDOW)
    const n = Math.max(1, (row && row.n) || 0)
    await maybeMaintain(env, now, n)
    return json({ online: n })
  } catch {
    return json({ online: 1 })
  }
}

// GET /api/online — 只讀近 3 小時人數（開「上線」視窗時用，不寫入）
export const onRequestGet = async ({ env }) => {
  try {
    const now = Date.now()
    const row = await countActive(env, now - WINDOW)
    const n = Math.max(1, (row && row.n) || 0)
    await maybeMaintain(env, now, n)
    return json({ online: n })
  } catch {
    return json({ online: 1 })
  }
}
