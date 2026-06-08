import { apiReference } from '@scalar/hono-api-reference'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from './types'
import { adminApiAuth } from '../middleware/admin-auth'

export function configureOpenApi(app: OpenAPIHono<{ Bindings: Env }>) {
  app.use('/api/openapi', adminApiAuth())

  app.doc('/api/openapi', {
    openapi: '3.0.3',
    info: {
      title: '파일 서버 API',
      version: '1.0.0',
      description:
        'Cloudflare Workers + R2 기반 파일 서버. 최대 250MB 파일 업로드, 24시간 보관 후 자동 삭제됩니다.',
    },
    servers: [
      {
        url: 'https://file.kalpha.kr',
        description: '운영 서버',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
          description: 'API_KEY 또는 관리자 토큰을 Bearer 토큰으로 전송하세요.',
        },
      },
    },
  } as any)

  app.use('/api/docs', adminApiAuth())

  app.get(
    '/api/docs',
    apiReference({
      spec: { url: '/api/openapi' },
      pageTitle: '파일 서버 API 문서',
    }),
  )
}
