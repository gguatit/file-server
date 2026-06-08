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

const TOKEN_EXPIRY_MS = 12 * 60 * 60 * 1000
const SALT = 'file-server-admin-salt'

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + SALT)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  return hash === storedHash
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

  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    id,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY_MS,
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

    if (payload.exp < Date.now()) return null

    return { id: payload.id }
  } catch {
    return null
  }
}
