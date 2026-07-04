import { json, clampInt, sanitizeText, clientIp, rateLimited } from './_lib.js'

// POST /api/score — 送出一場得分 { name, score, level, deviceId }
export const onRequestPost = async ({ request, env }) => {
  // 同一 IP 每 3 秒最多一次，擋腳本洗榜
  if (await rateLimited(env, `score:${clientIp(request)}`, 3000)) {
    return json({ ok: false, error: 'too fast' }, 429)
  }
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const name = sanitizeText(body.name, 12) || '玩家'
  const level = sanitizeText(body.level, 24)
  const score = clampInt(body.score, 0, 100_000_000)
  const device = sanitizeText(body.deviceId, 64)
  if (score <= 0) return json({ ok: false })
  try {
    await env.DB.prepare('INSERT INTO scores (device_id,name,level,score,created_at) VALUES (?,?,?,?,?)')
      .bind(device, name, level, score, Date.now()).run()
  } catch {
    return json({ error: 'db error' }, 500)
  }
  return json({ ok: true })
}
