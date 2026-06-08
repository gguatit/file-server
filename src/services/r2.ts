import type { R2Bucket, R2Object } from '@cloudflare/workers-types'
import { FILE_RETENTION_HOURS, MAX_FILENAME_LENGTH } from '../schemas/files'
import type { FileMetadata, PaginatedList } from '../lib/types'

export function generateFileId(): string {
  return crypto.randomUUID()
}

export function computeExpireAt(): Date {
  return new Date(Date.now() + FILE_RETENTION_HOURS * 60 * 60 * 1000)
}

export function r2ObjectToMetadata(obj: R2Object): FileMetadata {
  const custom = obj.customMetadata ?? {}
  return {
    id: obj.key,
    originalFilename: (custom.originalFilename as string) || obj.key,
    size: obj.size,
    uploadedAt: (custom.uploadedAt as string) || obj.uploaded.toISOString(),
    expireAt: (custom.expireAt as string) || obj.uploaded.toISOString(),
    contentType: obj.httpMetadata?.contentType ?? undefined,
  }
}

export async function uploadFile(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | ReadableStream,
  metadata: {
    originalFilename: string
    contentType?: string
  },
): Promise<FileMetadata | null> {
  const now = new Date()
  const expireAt = computeExpireAt()

  const safeName = metadata.originalFilename.slice(0, MAX_FILENAME_LENGTH)
  const obj = await bucket.put(key, body, {
    httpMetadata: {
      contentType: metadata.contentType ?? 'application/octet-stream',
    },
    customMetadata: {
      originalFilename: safeName,
      uploadedAt: now.toISOString(),
      expireAt: expireAt.toISOString(),
    },
  })

  if (!obj) return null

  return {
    id: key,
    originalFilename: metadata.originalFilename,
    size: obj.size,
    uploadedAt: now.toISOString(),
    expireAt: expireAt.toISOString(),
    contentType: obj.httpMetadata?.contentType ?? metadata.contentType,
  }
}

export async function getFile(
  bucket: R2Bucket,
  key: string,
): Promise<R2Object | null> {
  const obj = await bucket.head(key)
  return obj ?? null
}

export async function getFileBody(
  bucket: R2Bucket,
  key: string,
): Promise<{ body: ReadableStream; obj: R2Object } | null> {
  const result = await bucket.get(key)
  if (!result || !result.body) return null
  return { body: result.body, obj: result }
}

export async function deleteFile(
  bucket: R2Bucket,
  key: string,
): Promise<boolean> {
  try {
    await bucket.delete(key)
    return true
  } catch {
    return false
  }
}

export async function listFiles(
  bucket: R2Bucket,
  options: { cursor?: string; limit?: number },
): Promise<PaginatedList<FileMetadata>> {
  const limit = options.limit ?? 20
  const result = await bucket.list({
    limit,
    cursor: options.cursor,
    include: ['customMetadata', 'httpMetadata'],
  } as R2ListOptions & { include: string[] })

  const items: FileMetadata[] = result.objects.map(r2ObjectToMetadata)

  return {
    items,
    cursor: result.truncated ? result.cursor : undefined,
    hasMore: result.truncated,
  }
}
