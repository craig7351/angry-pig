// Cloudflare Pages Functions 共用工具（檔名以 _ 開頭 → 不當作路由）

/** 回傳 JSON Response */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 讀取端點邊緣快取：命中直接回；否則跑 build() 產生 Response，成功(200)才設 Cache-Control 並存入快取。
 * 讓多位使用者的重複 GET 直接吃 Cloudflare 邊緣，不進 Functions 也不打 D1。
 */
export async function edgeCached(request, waitUntil, maxAge, build) {
  const cache = caches.default
  const key = new Request(new URL(request.url).toString(), { method: 'GET' })
  const hit = await cache.match(key)
  if (hit) return hit
  const resp = await build()
  try {
    if (resp.status === 200) {
      resp.headers.set('Cache-Control', `public, max-age=${maxAge}`)
      if (waitUntil) waitUntil(cache.put(key, resp.clone()))
    }
  } catch {}
  return resp
}

/** 夾在 [min,max] 的整數（非數字回 min） */
export function clampInt(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.round(Math.min(max, Math.max(min, n)))
}

/** 請求來源 IP（Cloudflare 提供，作為限流 key，比 client 傳的 deviceId 難偽造） */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}

/**
 * 伺服器端速率限制：同一 key 在 windowMs 內第二次呼叫即擋下（回 true）。
 * 限流表異常時不擋，不影響正常使用。
 */
export async function rateLimited(env, key, windowMs) {
  const now = Date.now()
  try {
    const row = await env.DB.prepare('SELECT last_at FROM rate WHERE k=?').bind(key).first()
    if (row && now - row.last_at < windowMs) return true
    await env.DB.prepare('INSERT INTO rate (k,last_at) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET last_at=?')
      .bind(key, now, now).run()
    return false
  } catch {
    return false
  }
}

/** 清理文字：移除角括號與控制字元（\p{C}），限長 */
export function sanitizeText(v, maxLen) {
  if (typeof v !== 'string') return ''
  return v.replace(/[<>]/g, '').replace(/\p{C}/gu, '').trim().slice(0, maxLen)
}

/** 基本髒話 / 廣告字詞過濾（命中即拒收留言） */
const BAD_WORDS = [
  '幹你', '幹妳', '操你', '操妳', '靠北', '靠腰', '婊', '賤貨', '王八', '雜種',
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'porn', 'sex',
  '威而鋼', '博弈', '娛樂城', '加賴', '加line', '徵信', '代儲', '色情', '援交',
]
export function isBadText(text) {
  const t = String(text).toLowerCase().replace(/\s/g, '')
  return BAD_WORDS.some((w) => t.includes(w.toLowerCase()))
}
