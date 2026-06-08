import { z } from 'zod'

export const FILE_RETENTION_HOURS = 24
export const MAX_UPLOAD_SIZE = 262144000

export const BLOCKED_MIME_TYPES = [
  'text/html',
  'application/x-httpd-php',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-bat',
  'application/x-msi',
]

export const fileMetadataSchema = z.object({
  id: z.string().uuid(),
  originalFilename: z.string(),
  size: z.number().int().positive(),
  uploadedAt: z.string().datetime(),
  expireAt: z.string().datetime(),
  contentType: z.string().optional(),
})

export const fileListDataSchema = z.object({
  items: z.array(fileMetadataSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
})

export const deleteDataSchema = z.object({
  id: z.string().uuid(),
  deleted: z.boolean(),
})

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

export const queryParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})
