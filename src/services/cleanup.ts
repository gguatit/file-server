import type { R2Bucket } from '@cloudflare/workers-types'

const MAX_ITERATIONS = 200

export async function cleanupExpiredFiles(bucket: R2Bucket): Promise<{ deleted: number; errors: number }> {
  let deleted = 0
  let errors = 0
  let cursor: string | undefined
  let iterations = 0

  const now = Date.now()

  while (iterations < MAX_ITERATIONS) {
    iterations++
    const result = await bucket.list({
      limit: 500,
      cursor,
      include: ['customMetadata'],
    } as R2ListOptions & { include: string[] })

    const deletePromises: Promise<void>[] = []

    for (const obj of result.objects) {
      const expireAt = obj.customMetadata?.expireAt

      if (!expireAt) continue

      const expireTime = new Date(expireAt as string).getTime()

      if (!isNaN(expireTime) && expireTime < now) {
        deletePromises.push(
          bucket.delete(obj.key).then(
            () => { deleted++ },
            () => { errors++ },
          ),
        )
      }
    }

    await Promise.all(deletePromises)

    if (!result.truncated) break
    cursor = result.cursor
  }

  return { deleted, errors }
}
