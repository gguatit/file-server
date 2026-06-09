import { createHash } from 'crypto'

const SALT = 'file-server-admin-salt'
const password = process.argv[2]

if (!password) {
  console.log('사용법: npx tsx scripts/hash-legacy.ts <비밀번호>')
  process.exit(1)
}

const hash = createHash('sha256').update(password + SALT).digest('hex')
console.log(`SHA-256 해시: ${hash}`)
console.log(`wrangler.toml에 ADMIN_PW_HASH = "${hash}" 로 설정하세요.`)
