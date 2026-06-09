export interface FileMetadata {
  id: string
  originalFilename: string
  size: number
  uploadedAt: string
  expireAt: string
  contentType?: string
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

export interface PaginatedList<T> {
  items: T[]
  cursor?: string
  hasMore: boolean
}

export interface ShareInfo {
  token: string
  url: string
  expiresAt: string
}

export interface Env {
  FILE_BUCKET: R2Bucket
  API_KEY: string
  ADMIN_ID: string
  ADMIN_PW_HASH: string
  ADMIN_TOKEN_SECRET: string
  MAX_UPLOAD_SIZE: string
  RATE_LIMIT_PER_MINUTE: string
  ALLOWED_ORIGIN: string
  SHARE_BASE_URL: string
}
