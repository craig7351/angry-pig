import { json, clampInt, clientIp, rateLimited, edgeCached } from './_lib.js'

// GET /api/totals — 全服累計統計（遊玩場次 / 消滅動物 / 遊玩秒數）。邊緣快取 60 秒。
export const onRequestGet = async (ctx) => edgeCached(ctx.request, ctx.waitUntil && ctx.waitUntil.bind(ctx), 60, async () => {
  try {
    const s = await ctx.env.DB.prepare('SELECT plays, kills, seconds FROM stats WHERE id=1').first()
    return json({ plays: (s && s.plays) || 0, kills: (s && s.kills) || 0, seconds: (s && s.seconds) || 0 })
  } catch {
    return json({ plays: 0, kills: 0, seconds: 0 })
  }
})

// POST /api/totals — 累加 { runs, kills, seconds }（同 IP 每 2.5 秒最多一次）
export const onRequestPost = async ({ request, env }) => {
  if (await rateLimited(env, `tot:${clientIp(request)}`, 2500)) return json({ ok: false, error: 'too fast' }, 429)
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const runs = clampInt(body.runs, 0, 1)
  const kills = clampInt(body.kills, 0, 100000)
  const seconds = clampInt(body.seconds, 0, 86400)
  try {
    await env.DB.prepare('UPDATE stats SET plays = plays + ?, kills = kills + ?, seconds = seconds + ? WHERE id = 1')
      .bind(runs, kills, seconds).run()
  } catch {
    return json({ error: 'db error' }, 500)
  }
  return json({ ok: true })
}
