// Cloudflare Pages Functions 共用工具（檔名以 _ 開頭 → 不當作路由）

/** 回傳 JSON Response */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
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
