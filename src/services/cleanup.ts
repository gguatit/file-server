import type { R2Bucket } from '@cloudflare/workers-types'

export async function cleanupExpiredFiles(bucket: R2Bucket): Promise<{ deleted: number; errors: number }> {
  let deleted = 0
  let errors = 0
  let cursor: string | undefined

  const now = Date.now()

  while (true) {
    const result = await bucket.list({
      limit: 500,
      cursor,
      include: ['customMetadata'],
    } as R2ListOptions & { include: string[] })

    for (const obj of result.objects) {
      const expireAt = obj.customMetadata?.expireAt

      if (!expireAt) {
        try {
          await bucket.delete(obj.key)
          deleted++
        } catch {
          errors++
        }
        continue
      }

      const expireTime = new Date(expireAt as string).getTime()

      if (isNaN(expireTime) || expireTime < now) {
        try {
          await bucket.delete(obj.key)
          deleted++
        } catch {
          errors++
        }
      }
    }

    if (!result.truncated) break
    cursor = result.cursor
  }

  return { deleted, errors }
}
