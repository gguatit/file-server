import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from '../lib/types'

export const cors = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const allowedOrigin = c.env.ALLOWED_ORIGIN
    const origin = c.req.header('Origin')

    if (origin) {
      if (origin !== allowedOrigin) {
        return c.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: '허용되지 않은 도메인입니다.',
            },
          },
          403,
        )
      }

      c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin)
      c.res.headers.set(
        'Access-Control-Allow-Methods',
        'GET, POST, DELETE, OPTIONS',
      )
      c.res.headers.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type',
      )
      c.res.headers.set('Access-Control-Max-Age', '86400')
    }

    if (c.req.method === 'OPTIONS') {
      return c.text('', 204 as ContentfulStatusCode)
    }

    await next()
  }
}
