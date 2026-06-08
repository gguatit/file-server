import { apiReference } from '@scalar/hono-api-reference'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from './types'
import { adminApiAuth, adminPageAuth } from '../middleware/admin-auth'

export function configureOpenApi(app: OpenAPIHono<{ Bindings: Env }>) {
  app.use('/api/openapi', adminApiAuth())

  app.doc('/api/openapi', {
    openapi: '3.0.3',
    info: {
      title: '파일 서버 API',
      version: '1.0.0',
      description: [
        'Cloudflare Workers + R2 기반 파일 서버 API입니다.',
        '',
        '## 운영 정책',
        '',
        '- 파일당 최대 업로드 크기: 250MB',
        '- 보관 기간: 업로드 후 24시간',
        '- 자동 삭제: Cron 트리거로 12시간마다 만료된 파일 정리 (KST 오전 9시, 오후 9시)',
        '- 속도 제한: IP당 분당 60회 요청',
        '- CORS: https://kalpha.mmv.kr 및 동일 출처만 허용',
        '',
        '## 차단된 파일 형식',
        '',
        '- text/html',
        '- application/x-httpd-php',
        '- application/x-msdownload',
        '- application/x-sh',
        '- application/x-bat',
        '- application/x-msi',
        '',
        '## 권한 체계',
        '',
        '- API_KEY: 파일 업로드 및 다운로드만 가능',
        '- 관리자 토큰: 모든 작업 가능 (목록 조회, 메타데이터, 삭제, API 문서 열람)',
        '',
        '관리자 로그인은 /admin/login 에서 진행합니다.',
      ].join('\n'),
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

  app.use('/api/docs', adminPageAuth())

  app.get(
    '/api/docs',
    apiReference({
      spec: { url: '/api/openapi' },
      pageTitle: '파일 서버 API 문서',
    }),
  )
}
