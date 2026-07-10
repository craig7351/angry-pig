import { json } from './_lib.js'

// GET /api/online — 近 90 秒在線人數（心跳間隔 60s），並記錄今日尖峰
export const onRequestGet = async ({ env }) => {
  try {
    const now = Date.now()
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?')
      .bind(now - 90000).first()
    const n = Math.max(1, (row && row.n) || 0)
    // 記錄今日在線尖峰（取最大），供 7 天歷史
    const day = Math.floor(now / 86400000)
    await env.DB.prepare('INSERT INTO online_daily (day, peak) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET peak = MAX(peak, ?)')
      .bind(day, n, n).run()
    // 機會性清除過期列：在線名單（>10 分）與限流表（>1 天，順帶縮短 IP 留存）
    await env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 600000).run()
    await env.DB.prepare('DELETE FROM rate WHERE last_at < ?').bind(now - 86400000).run()
    return json({ online: n })
  } catch {
    return json({ online: 1 })
  }
}
