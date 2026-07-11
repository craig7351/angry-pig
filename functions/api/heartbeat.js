import { json, sanitizeText } from './_lib.js'

// POST /api/heartbeat — 首頁/遊戲中定期上報，標記此裝置在線
// 條件式 upsert：只有距上次心跳 ≥8 秒才真的寫入（連發時 WHERE 不成立 → 0 列寫入），
// 免掉獨立 rate 表的讀寫，省 D1 用量又保有連發防護。
export const onRequestPost = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({}))
    const id = sanitizeText(body.deviceId, 64)
    if (!id) return json({ ok: false }, 400)
    const now = Date.now()
    await env.DB.prepare(
      'INSERT INTO presence (device_id, last_seen) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen = ? WHERE ? - presence.last_seen >= 8000',
    ).bind(id, now, now, now).run()
    return json({ ok: true })
  } catch {
    return json({ ok: false }, 500)
  }
}
