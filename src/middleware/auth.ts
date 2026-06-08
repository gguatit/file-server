import type { MiddlewareHandler } from 'hono'
import type { Env } from '../lib/types'

export const auth = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'API 키가 필요합니다. Authorization: Bearer <key> 헤더를 전송하세요.',
          },
        },
        401,
      )
    }

    const token = authHeader.slice(7)

    if (token !== c.env.API_KEY) {
      return c.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '유효하지 않은 API 키입니다.',
          },
        },
        401,
      )
    }

    await next()
  }
}
