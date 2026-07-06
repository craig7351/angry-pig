import { json, clampInt, sanitizeText, clientIp, rateLimited } from './_lib.js'

// POST /api/score — 送出一場得分 { name, score, level, note, deviceId }
//   note＝額外資訊（不影響排名）：死鬥/快樂＝波數、飛高＝模式
//   回傳該關名次 { ok, best, rank, total }（best=此玩家該關最高分）
export const onRequestPost = async ({ request, env }) => {
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
  const note = sanitizeText(body.note, 24)
  const device = sanitizeText(body.deviceId, 64)
  if (score <= 0) return json({ ok: false })
  try {
    await env.DB.prepare('INSERT INTO scores (device_id,name,level,score,note,created_at) VALUES (?,?,?,?,?,?)')
      .bind(device, name, level, score, note, Date.now()).run()
    // 該關名次：以「各名字最高分」計算
    const mine = await env.DB.prepare('SELECT MAX(score) AS s FROM scores WHERE name=? AND level=?')
      .bind(name, level).first()
    const best = mine && mine.s != null ? mine.s : score
    const hi = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT name, MAX(score) AS ms FROM scores WHERE level=? GROUP BY name) t WHERE t.ms > ?',
    ).bind(level, best).first()
    const tot = await env.DB.prepare('SELECT COUNT(DISTINCT name) AS c FROM scores WHERE level=?')
      .bind(level).first()
    return json({ ok: true, best, rank: (hi ? hi.c : 0) + 1, total: tot && tot.c ? tot.c : 1 })
  } catch {
    return json({ error: 'db error' }, 500)
  }
}
