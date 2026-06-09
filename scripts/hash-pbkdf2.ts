function toBase64Url(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const saltB64 = toBase64Url(salt)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )
  const hashB64 = toBase64Url(new Uint8Array(bits))
  return `pbkdf2:100000:${saltB64}:${hashB64}`
}

const password = process.argv[2]

if (!password) {
  console.log('사용법: npx tsx scripts/hash-pbkdf2.ts <비밀번호>')
  process.exit(1)
}

hashPassword(password).then((result) => {
  console.log(`PBKDF2 해시: ${result}`)
  console.log(`wrangler.toml에 ADMIN_PW_HASH = "${result}" 로 변경하세요.`)
  console.log('기존 SHA-256 해시가 있으면 이 값으로 교체하면 됩니다. (PBKDF2 우선 검증, 실패 시 레거시 SHA-256 검증)')
})
