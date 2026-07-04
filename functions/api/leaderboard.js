import { json } from './_lib.js'

// GET /api/leaderboard?limit=10 — 全球排行榜：每個名字取其最高分，依分數排序
export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50)
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.name, s.score, s.level, s.created_at
         FROM scores s
         JOIN (SELECT name, MAX(score) AS ms FROM scores GROUP BY name) b
           ON s.name = b.name AND s.score = b.ms
        GROUP BY s.name
        ORDER BY s.score DESC
        LIMIT ?`,
    ).bind(limit).all()
    return json(results.map((r) => ({ name: r.name, score: r.score, level: r.level, at: r.created_at })))
  } catch {
    return json({ error: 'db error' }, 500)
  }
}
