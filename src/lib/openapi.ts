import { apiReference } from '@scalar/hono-api-reference'
import type { Hono } from 'hono'
import type { Env } from './types'

export function configureOpenApi(app: Hono<{ Bindings: Env }>) {
  app.get(
    '/api/openapi',
    async (c) => {
      const doc = {
        openapi: '3.0.3',
        info: {
          title: '파일 서버 API',
          version: '1.0.0',
          description: 'Cloudflare Workers + R2 기반 파일 서버. 최대 250MB 파일 업로드, 24시간 보관 후 자동 삭제됩니다.',
        },
        servers: [
          {
            url: 'https://file.kalpha.kr',
            description: '운영 서버',
          },
        ],
      }
      return c.json(doc)
    },
  )

  app.get(
    '/api/docs',
    apiReference({
      spec: { url: '/api/openapi' },
      pageTitle: '파일 서버 API 문서',
    }),
  )
}
