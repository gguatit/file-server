import { z } from 'zod'

export const FILE_RETENTION_HOURS = 24
export const MAX_UPLOAD_SIZE = 262144000
export const MAX_FILENAME_LENGTH = 512

export const BLOCKED_MIME_TYPES: string[] = []

export const fileMetadataSchema = z.object({
  id: z.string(),
  originalFilename: z.string(),
  size: z.number().int().positive(),
  uploadedAt: z.string().datetime(),
  expireAt: z.string().optional(),
  contentType: z.string().optional(),
})

export const fileListDataSchema = z.object({
  items: z.array(fileMetadataSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
})

export const deleteDataSchema = z.object({
  id: z.string(),
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

export const extendDataSchema = z.object({
  id: z.string(),
  newExpireAt: z.string().datetime(),
  extended: z.boolean(),
})

export const shareDataSchema = z.object({
  token: z.string(),
  url: z.string(),
  expiresAt: z.string().datetime(),
})

export const statsDataSchema = z.object({
  totalFiles: z.number().int(),
  totalSize: z.number().int(),
  averageSize: z.number().int(),
  oldestUpload: z.string().datetime().nullable(),
  newestUpload: z.string().datetime().nullable(),
  expiringSoon: z.number().int(),
})
