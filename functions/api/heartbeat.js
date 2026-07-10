import { json, sanitizeText, clientIp, rateLimited } from './_lib.js'

// POST /api/heartbeat — 首頁/遊戲中定期上報，標記此裝置在線
// 正常客戶端每 60 秒才心跳一次；此處用 10 秒短窗擋掉連發濫用（放大寫入 / 灌線上人數），
// 對同 IP 的多位正常玩家幾乎無影響。
export const onRequestPost = async ({ request, env }) => {
  try {
    if (await rateLimited(env, `hb:${clientIp(request)}`, 10000)) return json({ ok: false, error: 'too fast' }, 429)
    const body = await request.json().catch(() => ({}))
    const id = sanitizeText(body.deviceId, 64)
    if (!id) return json({ ok: false }, 400)
    const now = Date.now()
    await env.DB.prepare(
      'INSERT INTO presence (device_id, last_seen) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen = ?',
    ).bind(id, now, now).run()
    return json({ ok: true })
  } catch {
    return json({ ok: false }, 500)
  }
}
