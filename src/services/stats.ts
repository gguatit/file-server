import type { R2Bucket } from '@cloudflare/workers-types'

export interface R2Stats {
  totalFiles: number
  totalSize: number
  averageSize: number
  oldestUpload: string | null
  newestUpload: string | null
  expiringSoon: number
}

let cache: { data: R2Stats; at: number } | null = null
const CACHE_TTL_MS = 60000

export async function getBucketStats(bucket: R2Bucket): Promise<R2Stats> {
  // ponytail: isolate-local 60s cache; stats may lag up to 60s, resets on cold start
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  let totalFiles = 0
  let totalSize = 0
  let cursor: string | undefined
  let maxIterations = 200
  let oldestUpload: Date | null = null
  let newestUpload: Date | null = null
  let expiringSoon = 0
  const now = Date.now()

  while (maxIterations-- > 0) {
    const result = await bucket.list({
      limit: 500,
      cursor,
      include: ['customMetadata'],
    } as R2ListOptions & { include: string[] })

    for (const obj of result.objects) {
      totalFiles++
      totalSize += obj.size

      const uploaded = obj.uploaded
      if (!oldestUpload || uploaded < oldestUpload) oldestUpload = uploaded
      if (!newestUpload || uploaded > newestUpload) newestUpload = uploaded

      const expireAt = (obj.customMetadata?.expireAt as string) || ''
      if (expireAt) {
        const expireMs = new Date(expireAt).getTime()
        if (expireMs - now < 3600000) expiringSoon++
      }
    }

    if (result.truncated) {
      cursor = result.cursor
    } else {
      break
    }
  }

  const stats: R2Stats = {
    totalFiles,
    totalSize,
    averageSize: totalFiles > 0 ? Math.round(totalSize / totalFiles) : 0,
    oldestUpload: oldestUpload?.toISOString() ?? null,
    newestUpload: newestUpload?.toISOString() ?? null,
    expiringSoon,
  }

  cache = { data: stats, at: Date.now() }
  return stats
}
