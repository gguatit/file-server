import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Env, ApiResponse, FileMetadata, PaginatedList } from '../lib/types'
import { MAX_UPLOAD_SIZE, BLOCKED_MIME_TYPES } from '../schemas/files'
import {
  fileMetadataSchema,
  fileListDataSchema,
  deleteDataSchema,
  errorResponseSchema,
  queryParamsSchema,
} from '../schemas/files'
import {
  uploadFile,
  getFile,
  getFileBody,
  deleteFile,
  listFiles,
  generateFileId,
} from '../services/r2'
import { auth } from '../middleware/auth'
import { cors } from '../middleware/cors'
import { rateLimit } from '../middleware/rate-limit'
import { configureOpenApi } from '../lib/openapi'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.use('*', cors())
app.use('*', rateLimit())

app.get('/', (c) => c.redirect('/api/docs'))

configureOpenApi(app)

const listRoute = createRoute({
  method: 'get',
  path: '/api/files',
  tags: ['파일'],
  summary: '파일 목록 조회',
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
    429: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '요청 초과',
    },
  },
})

app.openapi(listRoute, async (c) => {
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
  summary: '파일 메타데이터 조회',
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
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일을 찾을 수 없음',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
  },
})

app.openapi(infoRoute, async (c) => {
  const { id } = c.req.valid('param')
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
  summary: '파일 삭제',
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
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '파일을 찾을 수 없음',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '인증 실패',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: '서버 오류',
    },
  },
})

app.openapi(deleteRoute, async (c) => {
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

  return c.json({ success: true as const, data: { id, deleted: true } }, 200)
})

app.on(['POST'], '/api/files', auth(), async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file || typeof file === 'string') {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: '파일 필드가 필요합니다. multipart/form-data로 file 필드를 전송하세요.' } },
      400,
    )
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json(
      { success: false, error: { code: 'FILE_TOO_LARGE', message: `파일 크기는 최대 250MB까지 허용됩니다. 현재 크기: ${(file.size / 1024 / 1024).toFixed(2)}MB` } },
      413,
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

  return c.json({ success: true, data: metadata } satisfies ApiResponse<FileMetadata>, 201)
})

app.on(['GET'], '/api/files/:id', auth(), async (c) => {
  const id = c.req.param('id')

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

  c.res.headers.set('Content-Type', contentType)
  c.res.headers.set(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(originalFilename)}`,
  )
  c.res.headers.set('Cache-Control', 'no-store')
  c.res.headers.set('X-Content-Type-Options', 'nosniff')

  return c.newResponse(body, 200)
})

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
