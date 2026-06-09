import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Env, ApiResponse, FileMetadata, PaginatedList } from '../lib/types'
import { BLOCKED_MIME_TYPES, MAX_FILENAME_LENGTH } from '../schemas/files'
import {
  fileMetadataSchema,
  fileListDataSchema,
  deleteDataSchema,
  errorResponseSchema,
  queryParamsSchema,
  extendDataSchema,
  shareDataSchema,
  statsDataSchema,
} from '../schemas/files'
import {
  uploadFile,
  getFile,
  getFileBody,
  deleteFile,
  listFiles,
  generateFileId,
} from '../services/r2'
import { checkAuth } from '../middleware/auth'
import { cors } from '../middleware/cors'
import { rateLimit } from '../middleware/rate-limit'
import { configureOpenApi } from '../lib/openapi'
import { createShareToken, verifyShareToken } from '../services/admin'
import { logEvent } from '../services/logger'
import { getBucketStats } from '../services/stats'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.use('*', cors())
app.use('*', rateLimit())

app.get('/', (c) => c.redirect('/api/docs'))

const listRoute = createRoute({
  method: 'get',
  path: '/api/files',
  tags: ['파일'],
  summary: '파일 목록 조회 (관리자 전용)',
  description: '저장된 모든 파일의 목록을 페이지네이션으로 조회합니다. 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: { query: queryParamsSchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: fileListDataSchema }),
        },
      },
      description: '파일 목록',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    403: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '관리자 권한 필요',
    },
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과 (분당 60회 제한)',
    },
  },
})

app.openapi(listRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('list', ip)

  const { cursor, limit } = c.req.valid('query')
  const result = await listFiles(c.env.FILE_BUCKET, { cursor, limit })
  return c.json(
    { success: true as const, data: result } satisfies ApiResponse<PaginatedList<FileMetadata>>,
    200,
  )
})

const infoRoute = createRoute({
  method: 'get',
  path: '/api/files/:id/info',
  tags: ['파일'],
  summary: '파일 메타데이터 조회 (관리자 전용)',
  description: '특정 파일의 업로드 시간, 만료 시간, 크기 등 메타데이터를 조회합니다. 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: fileMetadataSchema }),
        },
      },
      description: '파일 정보',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    403: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '관리자 권한 필요',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일을 찾을 수 없음',
    },
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과 (분당 60회 제한)',
    },
  },
})

app.openapi(infoRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const { id } = c.req.valid('param')

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('info', ip, { fileId: id })

  const obj = await getFile(c.env.FILE_BUCKET, id)

  if (!obj) {
    return c.json(
      { success: false as const, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } },
      404,
    )
  }

  const custom = obj.customMetadata ?? {}
  const metadata: FileMetadata = {
    id: obj.key,
    originalFilename: (custom.originalFilename as string) || obj.key,
    size: obj.size,
    uploadedAt: (custom.uploadedAt as string) || obj.uploaded.toISOString(),
    expireAt: (custom.expireAt as string) || '',
    contentType: obj.httpMetadata?.contentType ?? undefined,
  }

  return c.json({ success: true as const, data: metadata } satisfies ApiResponse<FileMetadata>, 200)
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/files/:id',
  tags: ['파일'],
  summary: '파일 삭제 (관리자 전용)',
  description: '지정한 파일을 R2 버킷에서 영구 삭제합니다. 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: deleteDataSchema }),
        },
      },
      description: '삭제 성공',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    403: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '관리자 권한 필요',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일을 찾을 수 없음',
    },
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과 (분당 60회 제한)',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '서버 오류',
    },
  },
})

app.openapi(deleteRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const { id } = c.req.valid('param')

  const obj = await getFile(c.env.FILE_BUCKET, id)
  if (!obj) {
    return c.json(
      { success: false as const, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } },
      404,
    )
  }

  const ok = await deleteFile(c.env.FILE_BUCKET, id)
  if (!ok) {
    return c.json(
      { success: false as const, error: { code: 'INTERNAL_ERROR', message: '파일 삭제 중 오류가 발생했습니다.' } },
      500,
    )
  }

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('delete', ip, { fileId: id })

  return c.json({ success: true as const, data: { id, deleted: true } }, 200)
})

const uploadRoute = createRoute({
  method: 'post' as const,
  path: '/api/files',
  tags: ['파일'],
  summary: '파일 업로드',
  description: 'multipart/form-data로 파일을 업로드합니다. 최대 250MB까지 허용됩니다. API_KEY 또는 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.any() }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: fileMetadataSchema }),
        },
      },
      description: '업로드 성공 (파일 ID, 만료 시간 등 메타데이터 반환)',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '유효하지 않은 요청 (file 필드 누락 등)',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    413: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일 크기 초과 (최대 250MB)',
    },
    415: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '지원하지 않는 파일 형식',
    },
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과 (분당 60회 제한)',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '서버 오류',
    },
  },
})

app.openapi(uploadRoute, async (c) => {
  const authErr = await checkAuth(c, false)
  if (authErr) return authErr as any

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file || typeof file === 'string') {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: '파일 필드가 필요합니다. multipart/form-data로 file 필드를 전송하세요.' } },
      400,
    )
  }

  const maxUploadSize = parseInt(c.env.MAX_UPLOAD_SIZE || '262144000', 10)

  if (file.size > maxUploadSize) {
    return c.json(
      { success: false, error: { code: 'FILE_TOO_LARGE', message: `파일 크기는 최대 ${Math.round(maxUploadSize / 1024 / 1024)}MB까지 허용됩니다. 현재 크기: ${(file.size / 1024 / 1024).toFixed(2)}MB` } },
      413,
    )
  }

  if (file.name.length > MAX_FILENAME_LENGTH) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: `파일명은 최대 ${MAX_FILENAME_LENGTH}자까지 허용됩니다.` } },
      400,
    )
  }

  if (BLOCKED_MIME_TYPES.includes(file.type)) {
    return c.json(
      { success: false, error: { code: 'INVALID_FILE_TYPE', message: `허용되지 않는 파일 형식입니다: ${file.type}` } },
      415,
    )
  }

  const fileId = generateFileId()
  const buffer = await file.arrayBuffer()

  const metadata = await uploadFile(c.env.FILE_BUCKET, fileId, buffer, {
    originalFilename: file.name,
    contentType: file.type || undefined,
  })

  if (!metadata) {
    return c.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: '파일 업로드 중 오류가 발생했습니다.' } },
      500,
    )
  }

  const uploadIp = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('upload', uploadIp, { fileId, fileName: file.name, fileSize: file.size })

  return c.json({ success: true, data: metadata } satisfies ApiResponse<FileMetadata>, 201)
})

const downloadRoute = createRoute({
  method: 'get' as const,
  path: '/api/files/:id',
  tags: ['파일'],
  summary: '파일 다운로드',
  description: '파일 ID로 바이너리 데이터를 다운로드합니다. Content-Disposition: attachment로 처리되어 파일로 저장됩니다. API_KEY 또는 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: '파일 바이너리 데이터',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일을 찾을 수 없음',
    },
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과 (분당 60회 제한)',
    },
  },
})

app.openapi(downloadRoute, async (c) => {
  const authErr = await checkAuth(c, false)
  if (authErr) return authErr as any

  const { id } = c.req.valid('param')

  const result = await getFileBody(c.env.FILE_BUCKET, id)
  if (!result) {
    return c.json(
      { success: false, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } },
      404,
    )
  }

  const { body, obj } = result
  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream'
  const custom = obj.customMetadata ?? {}
  const originalFilename = (custom.originalFilename as string) || id
  const asciiFilename = originalFilename.replace(/[^\x20-\x7E]/g, '_')

  c.res.headers.set('Content-Type', contentType)
  c.res.headers.set('Content-Length', String(obj.size))
  c.res.headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(originalFilename)}`,
  )
  c.res.headers.set('Cache-Control', 'no-store')
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  c.res.headers.set('Referrer-Policy', 'no-referrer')

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('download', ip, { fileId: id, fileName: originalFilename, fileSize: obj.size })

  return c.newResponse(body, 200)
})

const extendRoute = createRoute({
  method: 'put',
  path: '/api/files/:id/extend',
  tags: ['파일'],
  summary: '파일 만료 시간 연장 (관리자 전용)',
  description: '파일의 만료 시간을 지정한 시간만큼 연장합니다. 관리자 토큰이 필요합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ hours: z.number().int().min(1).max(168) }) } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ success: z.literal(true), data: extendDataSchema }) } }, description: '연장 성공' },
    401: { content: { 'application/json': { schema: errorResponseSchema } }, description: '인증 실패' },
    403: { content: { 'application/json': { schema: errorResponseSchema } }, description: '관리자 권한 필요' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: '파일을 찾을 수 없음' },
  },
})

app.openapi(extendRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const { id } = c.req.valid('param')
  const { hours } = await c.req.json<{ hours: number }>()

  const obj = await getFile(c.env.FILE_BUCKET, id)
  if (!obj) {
    return c.json({ success: false as const, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } }, 404)
  }

  const custom = obj.customMetadata ?? {}
  const currentExpireAt = (custom.expireAt as string) || obj.uploaded.toISOString()
  const newExpire = new Date(new Date(currentExpireAt).getTime() + hours * 60 * 60 * 1000)
  const newExpireAt = newExpire.toISOString()

  const r2Body = await getFileBody(c.env.FILE_BUCKET, id)
  if (!r2Body) {
    return c.json({ success: false as const, error: { code: 'INTERNAL_ERROR', message: '파일 데이터를 읽을 수 없습니다.' } }, 500)
  }

  await c.env.FILE_BUCKET.put(id, r2Body.body, {
    httpMetadata: obj.httpMetadata,
    customMetadata: { ...custom, expireAt: newExpireAt },
  })

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('extend', ip, { fileId: id, details: `${hours}h` })

  return c.json({ success: true as const, data: { id, newExpireAt, extended: true } }, 200)
})

const shareRoute = createRoute({
  method: 'post',
  path: '/api/files/:id/share',
  tags: ['파일'],
  summary: '공유 링크 생성 (관리자 전용)',
  description: '파일 다운로드 공유 링크를 생성합니다. 생성된 링크로는 인증 없이 다운로드 가능합니다.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: z.object({ expiryHours: z.number().int().min(1).max(72).optional().default(1) }) } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ success: z.literal(true), data: shareDataSchema }) } }, description: '공유 링크 생성 성공' },
    401: { content: { 'application/json': { schema: errorResponseSchema } }, description: '인증 실패' },
    403: { content: { 'application/json': { schema: errorResponseSchema } }, description: '관리자 권한 필요' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: '파일을 찾을 수 없음' },
  },
})

app.openapi(shareRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const { id } = c.req.valid('param')
  const body = await c.req.json<{ expiryHours?: number }>()
  const expiryHours = body.expiryHours ?? 1

  const obj = await getFile(c.env.FILE_BUCKET, id)
  if (!obj) {
    return c.json({ success: false as const, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } }, 404)
  }

  const token = await createShareToken(id, c.env.ADMIN_TOKEN_SECRET, expiryHours * 3600)
  const base = (c.env.SHARE_BASE_URL || 'https://file.kalpha.kr').replace(/\/$/, '')
  const url = `${base}/api/dl/${token}`
  const expiresAt = new Date(Date.now() + expiryHours * 3600000).toISOString()

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('share', ip, { fileId: id, fileSize: obj.size })

  return c.json({ success: true as const, data: { token, url, expiresAt } }, 200)
})

const shareDownloadRoute = createRoute({
  method: 'get',
  path: '/api/dl/{token}',
  tags: ['파일'],
  summary: '공유 링크 다운로드 (인증 불필요)',
  description: '공유 링크를 통해 인증 없이 파일을 다운로드합니다.',
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: { description: '파일 바이너리 데이터' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: '유효하지 않거나 만료된 공유 링크' },
  },
})

app.openapi(shareDownloadRoute, async (c) => {
  const { token } = c.req.valid('param')

  const payload = await verifyShareToken(token, c.env.ADMIN_TOKEN_SECRET)
  if (!payload) {
    return c.json({ success: false as const, error: { code: 'INVALID_SHARE', message: '유효하지 않거나 만료된 공유 링크입니다.' } }, 404)
  }

  const result = await getFileBody(c.env.FILE_BUCKET, payload.fileId)
  if (!result) {
    return c.json({ success: false as const, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } }, 404)
  }

  const { body, obj } = result
  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream'
  const custom = obj.customMetadata ?? {}
  const originalFilename = (custom.originalFilename as string) || payload.fileId
  const asciiFilename = originalFilename.replace(/[^\x20-\x7E]/g, '_')

  c.res.headers.set('Content-Type', contentType)
  c.res.headers.set('Content-Length', String(obj.size))
  c.res.headers.set('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(originalFilename)}`)
  c.res.headers.set('Cache-Control', 'no-store')
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  c.res.headers.set('Referrer-Policy', 'no-referrer')

  return c.newResponse(body, 200)
})

const statsRoute = createRoute({
  method: 'get',
  path: '/api/stats',
  tags: ['통계'],
  summary: '저장소 통계 (관리자 전용)',
  description: '전체 파일 개수, 총 용량 등 버킷 통계를 조회합니다.',
  security: [{ bearerAuth: [] }],
  request: {},
  responses: {
    200: { content: { 'application/json': { schema: z.object({ success: z.literal(true), data: statsDataSchema }) } }, description: '통계 정보' },
    401: { content: { 'application/json': { schema: errorResponseSchema } }, description: '인증 실패' },
    403: { content: { 'application/json': { schema: errorResponseSchema } }, description: '관리자 권한 필요' },
  },
})

app.openapi(statsRoute, async (c) => {
  const authErr = await checkAuth(c, true)
  if (authErr) return authErr as any

  const stats = await getBucketStats(c.env.FILE_BUCKET)
  return c.json({ success: true as const, data: stats }, 200)
})

const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['시스템'],
  summary: '헬스 체크',
  description: '서버와 R2 연결 상태를 확인합니다.',
  request: {},
  responses: {
    200: { content: { 'application/json': { schema: z.object({ status: z.literal('ok'), r2: z.enum(['connected', 'error']), uptime: z.number() }) } }, description: '상태 확인' },
  },
})

app.openapi(healthRoute, async (c) => {
  let r2Status: 'connected' | 'error' = 'connected'
  try {
    await c.env.FILE_BUCKET.list({ limit: 1 })
  } catch {
    r2Status = 'error'
  }

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  logEvent('health', ip)

  return c.json({ status: 'ok' as const, r2: r2Status, uptime: Math.floor(Date.now() / 1000) }, 200)
})

configureOpenApi(app)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json(
    {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '서버 내부 오류가 발생했습니다.',
      },
    },
    500,
  )
})

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `요청하신 경로를 찾을 수 없습니다: ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  )
})

export default app
