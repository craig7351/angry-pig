import { json } from './_lib.js'

// GET /api/leaderboard?limit=10&level=關卡名
//   有 level → 該關排行榜；無 level → 全關（各名字取最高分）
export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50)
  const level = url.searchParams.get('level') || ''
  try {
    let results
    if (level) {
      ;({ results } = await env.DB.prepare(
        `SELECT s.name, s.score, s.level, s.note, s.created_at
           FROM scores s
           JOIN (SELECT name, MAX(score) AS ms FROM scores WHERE level = ? GROUP BY name) b
             ON s.name = b.name AND s.score = b.ms AND s.level = ?
          GROUP BY s.name
          ORDER BY s.score DESC
          LIMIT ?`,
      ).bind(level, level, limit).all())
    } else {
      // 全部關卡：每位玩家「各關最高分」加總後排序
      ;({ results } = await env.DB.prepare(
        `SELECT name, SUM(best) AS score
           FROM (SELECT name, level, MAX(score) AS best FROM scores GROUP BY name, level)
          GROUP BY name
          ORDER BY score DESC
          LIMIT ?`,
      ).bind(limit).all())
    }
    return json(results.map((r) => ({ name: r.name, score: r.score, level: r.level, note: r.note, at: r.created_at })))
  } catch {
    return json({ error: 'db error' }, 500)
  }
}
