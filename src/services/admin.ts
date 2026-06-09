function toBase64Url(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) str += '='
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const TOKEN_EXPIRY_SEC = 12 * 60 * 60
const PBKDF2_ITERATIONS = 100000

async function verifyPBKDF2(password: string, saltB64: string, expectedHashB64: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const salt = fromBase64Url(saltB64)
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  const actualHash = toBase64Url(new Uint8Array(bits))
  return actualHash === expectedHashB64
}

async function verifyLegacySHA256(password: string, storedHash: string): Promise<boolean> {
  const SALT = 'file-server-admin-salt'
  const encoder = new TextEncoder()
  const data = encoder.encode(password + SALT)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  return hash === storedHash
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('pbkdf2:')) {
    const parts = storedHash.split(':')
    if (parts.length !== 4) return false
    return verifyPBKDF2(password, parts[2], parts[3])
  }
  return verifyLegacySHA256(password, storedHash)
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const saltB64 = toBase64Url(salt)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  const hashB64 = toBase64Url(new Uint8Array(bits))
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltB64}:${hashB64}`
}

export async function createAdminToken(id: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const nowSec = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    id,
    iat: nowSec,
    exp: nowSec + TOKEN_EXPIRY_SEC,
  }

  const headerB64 = toBase64Url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const data = encoder.encode(`${headerB64}.${payloadB64}`)

  const signature = await crypto.subtle.sign('HMAC', key, data)
  const sigB64 = toBase64Url(new Uint8Array(signature))

  return `${headerB64}.${payloadB64}.${sigB64}`
}

export async function verifyAdminToken(
  token: string,
  secret: string,
): Promise<{ id: string } | null> {
  try {
    const encoder = new TextEncoder()
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, sigB64] = parts

    const keyData = encoder.encode(secret)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const data = encoder.encode(`${headerB64}.${payloadB64}`)
    const signature = fromBase64Url(sigB64)

    const valid = await crypto.subtle.verify('HMAC', key, signature, data)
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)))

    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return { id: payload.id }
  } catch {
    return null
  }
}

export async function createShareToken(fileId: string, secret: string, expirySec: number): Promise<string> {
  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

  const nowSec = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { fileId, iat: nowSec, exp: nowSec + expirySec, type: 'share' }

  const headerB64 = toBase64Url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const data = encoder.encode(`${headerB64}.${payloadB64}`)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  const sigB64 = toBase64Url(new Uint8Array(signature))

  return `${headerB64}.${payloadB64}.${sigB64}`
}

export async function verifyShareToken(token: string, secret: string): Promise<{ fileId: string } | null> {
  try {
    const encoder = new TextEncoder()
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const keyData = encoder.encode(secret)
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])

    const data = encoder.encode(`${parts[0]}.${parts[1]}`)
    const signature = fromBase64Url(parts[2])
    const valid = await crypto.subtle.verify('HMAC', key, signature, data)
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])))
    if (payload.type !== 'share') return null
    if (!payload.fileId) return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return { fileId: payload.fileId }
  } catch {
    return null
  }
}
