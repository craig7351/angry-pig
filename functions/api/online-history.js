import { json } from './_lib.js'

// GET /api/online-history — 最近 7 天每日在線尖峰（舊→新）
export const onRequestGet = async ({ env }) => {
  try {
    const { results } = await env.DB.prepare('SELECT day, peak FROM online_daily ORDER BY day DESC LIMIT 7').all()
    return json(results.map((r) => ({ at: r.day * 86400000, peak: r.peak })).reverse())
  } catch {
    return json([])
  }
}
