import type { MiddlewareHandler } from 'hono'
import type { Env } from '../lib/types'
import { verifyAdminToken } from '../services/admin'

function extractToken(c: { req: { header: (name: string) => string | undefined; raw: Request } }): string | null {
  const bearer = c.req.header('Authorization')?.slice(7)
  if (bearer) return bearer

  const cookie = c.req.raw.headers.get('cookie') || ''
  const match = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('admin_token='))
  return match ? match.slice(12) : null
}

export const adminPageAuth = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const token = extractToken(c)
    if (!token) return c.redirect('/admin/login')

    const payload = await verifyAdminToken(token, c.env.ADMIN_PW_HASH)
    if (!payload) return c.redirect('/admin/login')

    await next()
  }
}

export const adminApiAuth = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const token = extractToken(c)
    if (!token) {
      return c.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: '관리자 인증이 필요합니다.' } },
        401,
      )
    }

    const payload = await verifyAdminToken(token, c.env.ADMIN_PW_HASH)
    if (!payload) {
      return c.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: '유효하지 않은 관리자 인증입니다.' } },
        401,
      )
    }

    await next()
  }
}
