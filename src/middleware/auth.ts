import type { Context } from 'hono'
import type { Env } from '../lib/types'
import { verifyAdminToken } from '../services/admin'

export async function checkAuth(c: Context<{ Bindings: Env }>, requireAdmin = false): Promise<Response | null> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: '인증이 필요합니다.' } },
      401,
    )
  }

  const token = authHeader.slice(7)

  if (token === c.env.API_KEY) {
    if (requireAdmin) {
      return c.json(
        { success: false, error: { code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' } },
        403,
      )
    }
    return null
  }

  const adminPayload = await verifyAdminToken(token, c.env.ADMIN_PW_HASH)
  if (adminPayload) {
    return null
  }

  return c.json(
    { success: false, error: { code: 'UNAUTHORIZED', message: '유효하지 않은 인증 정보입니다.' } },
    401,
  )
}
