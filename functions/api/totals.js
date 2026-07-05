import { json, clampInt, clientIp, rateLimited } from './_lib.js'

// GET /api/totals — 全服累計統計（遊玩場次）
export const onRequestGet = async ({ env }) => {
  try {
    const s = await env.DB.prepare('SELECT plays FROM stats WHERE id=1').first()
    return json({ plays: (s && s.plays) || 0 })
  } catch {
    return json({ plays: 0 })
  }
}

// POST /api/totals — 累加場次（每場開始 +1；同 IP 每 2.5 秒最多一次）
export const onRequestPost = async ({ request, env }) => {
  if (await rateLimited(env, `tot:${clientIp(request)}`, 2500)) return json({ ok: false, error: 'too fast' }, 429)
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const runs = clampInt(body.runs, 0, 1)
  try {
    await env.DB.prepare('UPDATE stats SET plays = plays + ? WHERE id = 1').bind(runs).run()
  } catch {
    return json({ error: 'db error' }, 500)
  }
  return json({ ok: true })
}
