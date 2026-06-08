import type { MiddlewareHandler } from 'hono'
import type { Env } from '../lib/types'

const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
let lastCleanup = 0

export const rateLimit = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/admin') || path === '/api/docs' || path === '/api/openapi') {
      return next()
    }

    const ip = c.req.header('CF-Connecting-IP') || 'unknown'

    const limit = parseInt(c.env.RATE_LIMIT_PER_MINUTE || '60', 10)
    const now = Date.now()
    const windowMs = 60_000

    if (now - lastCleanup > 300_000) {
      lastCleanup = now
      for (const [key, val] of rateLimitStore) {
        if (now > val.resetAt) rateLimitStore.delete(key)
      }
    }

    const record = rateLimitStore.get(ip)

    if (!record || now > record.resetAt) {
      rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs })
      return next()
    }

    if (record.count >= limit) {
      return c.json(
        {
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `분당 최대 ${limit}회 요청을 초과했습니다. 잠시 후 다시 시도하세요.`,
          },
        },
        429,
      )
    }

    record.count++
    await next()
  }
}
