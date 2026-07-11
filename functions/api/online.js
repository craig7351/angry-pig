import { json } from './_lib.js'

// GET /api/online — 近 90 秒在線人數（心跳間隔 60s），並記錄今日尖峰
export const onRequestGet = async ({ env }) => {
  try {
    const now = Date.now()
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?')
      .bind(now - 90000).first()
    const n = Math.max(1, (row && row.n) || 0)
    // 尖峰記錄 + 清理不必每次做：約每 8 次呼叫才寫一次，大幅降低 D1 寫入
    if (Math.random() < 0.13) {
      const day = Math.floor(now / 86400000)
      await env.DB.prepare('INSERT INTO online_daily (day, peak) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET peak = MAX(peak, ?)')
        .bind(day, n, n).run()
      await env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 600000).run()   // 在線名單 >10 分清除
      await env.DB.prepare('DELETE FROM rate WHERE last_at < ?').bind(now - 86400000).run()        // 限流表 >1 天清除
    }
    return json({ online: n })
  } catch {
    return json({ online: 1 })
  }
}
