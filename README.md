# file-server

Cloudflare Workers + R2 기반 파일 서버. 파일 업로드, 다운로드, 24시간 보관 후 자동 삭제 기능을 제공합니다.

## 배포 주소

- 운영 서버: [https://file.kalpha.kr](https://file.kalpha.kr)
- CORS 허용 도메인: [https://kalpha.mmv.kr](https://kalpha.mmv.kr)

## 기술 스택

- **런타임**: Cloudflare Workers
- **저장소**: Cloudflare R2 (10GB, 월 1백만 Class A / 1천만 Class B 작업)
- **프레임워크**: Hono + @hono/zod-openapi
- **API 문서**: Scalar UI
- **언어**: TypeScript

## 아키텍처

```
요청 -> Cloudflare Workers -> R2 Bucket
                               |
                     업로드 시 메타데이터 기록
                     (originalFilename, uploadedAt, expireAt)

Cron (12시간 간격) -> cleanupExpiredFiles
                      -> expireAt < 현재시간 인 파일 삭제
```

### 파일 생명 주기

1. 클라이언트가 `POST /api/files`로 파일 업로드 (multipart/form-data)
2. 서버가 UUID 파일 ID 생성, R2에 저장하며 `expireAt` 메타데이터 기록 (업로드 + 24시간)
3. 클라이언트는 파일 ID를 받아 다운로드 URL 구성
4. 12시간마다 Cron Worker가 만료된 파일 자동 삭제

### 디렉토리 구조

```
src/
  index.ts          # Worker 진입점 (fetch + scheduled)
  app.ts            # Hono 앱 조립
  routes/
    files.ts        # 파일 CRUD API 라우트
    admin.ts        # 관리자 페이지 라우트
  middleware/
    auth.ts         # API 인증 (API_KEY + 관리자 토큰)
    admin-auth.ts   # 관리자 페이지/API 인증
    cors.ts         # CORS 처리
    rate-limit.ts   # IP 기반 속도 제한
  services/
    r2.ts           # R2 버킷 작업 (업로드/다운로드/삭제/목록)
    admin.ts        # 관리자 로그인/토큰 관리 (HMAC-SHA256)
    cleanup.ts      # 만료 파일 정리
  schemas/
    files.ts        # Zod 스키마 및 상수
  lib/
    types.ts        # 타입 정의
    openapi.ts      # OpenAPI 문서 생성 및 Scalar UI
```

## 보안

### 인증 체계

두 가지 인증 수단을 사용합니다.

| 인증 수단 | 발급 방식 | 권한 범위 |
|-----------|----------|----------|
| API Key | `wrangler secret put API_KEY` 로 설정 | 파일 업로드, 다운로드 |
| 관리자 토큰 | `/admin/login` 에서 로그인 시 발급 (12시간 유효) | 모든 작업 |

### 권한별 접근

| 작업 | API Key | 관리자 토큰 |
|------|---------|------------|
| 파일 업로드 | 허용 | 허용 |
| 파일 다운로드 | 허용 | 허용 |
| 파일 목록 조회 | 거부 | 허용 |
| 파일 메타데이터 | 거부 | 허용 |
| 파일 삭제 | 거부 | 허용 |
| API 문서 열람 | 거부 | 허용 |

### 기타 보안 조치

- **CORS**: `kalpha.mmv.kr` 및 동일 출처 요청만 허용
- **속도 제한**: IP당 분당 60회
- **파일 크기 제한**: 250MB
- **MIME 차단**: text/html, application/x-httpd-php 등 실행 가능한 파일 형식 차단
- **파일 키**: UUID v4 자동 생성으로 경로 추측 불가
- **다운로드 헤더**: `Content-Disposition: attachment` 강제, `X-Content-Type-Options: nosniff`
- **관리자 비밀번호**: SHA-256 해시로만 저장, 평문은 코드 어디에도 없음
- **관리자 토큰**: HMAC-SHA256 서명, 12시간 만료, httpOnly + Secure + SameSite=Strict 쿠키

## 환경 변수

### wrangler.toml에 설정하는 변수

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `ADMIN_ID` | 관리자 로그인 아이디 | `kalpha` |
| `ADMIN_PW_HASH` | 관리자 비밀번호 SHA-256 해시 (생성 방법은 아래 참고) | - |
| `ALLOWED_ORIGIN` | CORS 허용 출처 | `https://kalpha.mmv.kr` |
| `MAX_UPLOAD_SIZE` | 파일당 최대 업로드 크기 (바이트) | `262144000` |
| `RATE_LIMIT_PER_MINUTE` | IP당 분당 요청 제한 | `60` |

### Secret으로 설정하는 변수

```bash
wrangler secret put API_KEY
```

`API_KEY`는 파일 업로드/다운로드를 위한 키입니다. `wrangler.toml`에 평문으로 넣지 말고 반드시 secret으로 설정하세요.

### ADMIN_PW_HASH 생성 방법

다음 Node.js 스크립트로 해시를 생성합니다.

```js
const crypto = require('crypto')
const password = '원하는_비밀번호'
const salt = 'file-server-admin-salt'
const hash = crypto.createHash('sha256').update(password + salt).digest('hex')
console.log(hash)
```

생성된 해시 값을 `wrangler.toml`의 `ADMIN_PW_HASH`에 설정합니다.

## API 사용법

### 파일 업로드

```bash
curl -X POST https://file.kalpha.kr/api/files \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@example.png"
```

응답:
```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-...",
    "originalFilename": "example.png",
    "size": 12345,
    "uploadedAt": "2026-06-08T09:00:00.000Z",
    "expireAt": "2026-06-09T09:00:00.000Z",
    "contentType": "image/png"
  }
}
```

### 파일 다운로드

```bash
curl -O -J -H "Authorization: Bearer $API_KEY" \
  https://file.kalpha.kr/api/files/a1b2c3d4-...
```

### 파일 목록 조회 (관리자)

```bash
curl https://file.kalpha.kr/api/files?limit=10 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 파일 메타데이터 조회 (관리자)

```bash
curl https://file.kalpha.kr/api/files/a1b2c3d4-.../info \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 파일 삭제 (관리자)

```bash
curl -X DELETE https://file.kalpha.kr/api/files/a1b2c3d4-... \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## API 응답 형식

### 성공 응답

```json
{
  "success": true,
  "data": { ... }
}
```

### 오류 응답

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "오류 메시지"
  }
}
```

### 오류 코드

| 코드 | HTTP 상태 | 설명 |
|------|----------|------|
| `UNAUTHORIZED` | 401 | 인증 실패 |
| `FORBIDDEN` | 403 | 관리자 권한 필요 |
| `FILE_NOT_FOUND` | 404 | 파일이 존재하지 않음 |
| `FILE_TOO_LARGE` | 413 | 250MB 초과 |
| `INVALID_FILE_TYPE` | 415 | 차단된 파일 형식 |
| `VALIDATION_ERROR` | 400 | 요청 형식 오류 |
| `RATE_LIMITED` | 429 | 속도 제한 초과 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

## 관리자 대시보드

1. [https://file.kalpha.kr/admin/login](https://file.kalpha.kr/admin/login) 접속
2. 관리자 아이디와 비밀번호 입력
3. 대시보드 기능:
   - 저장된 파일 목록 및 파일 크기 확인
   - 다운로드 URL 클립보드 복사
   - 파일 개별 삭제
   - 페이지네이션 (20개 단위)
   - API 문서 바로가기 (`/api/docs`)

로그인 세션은 12시간 유지되며, 이후 자동 만료됩니다.

## 로컬 개발

```bash
npm install
npx wrangler dev
```

개발 시 `.dev.vars` 파일에 다음 내용을 추가하세요.

```
API_KEY=개발용_API_키
```

## 배포

```bash
npx wrangler deploy
```

### 최초 설정 순서

1. Cloudflare 대시보드에서 R2 버킷 생성 (`file-server-bucket`)
2. `wrangler.toml`에 `bucket_name` 확인
3. `ADMIN_PW_HASH` 생성 후 `wrangler.toml`에 설정
4. `wrangler secret put API_KEY` 로 API 키 등록
5. `npx wrangler deploy` 로 배포

## 제한 사항

- 파일당 최대 크기: 250MB
- 보관 기간: 업로드 시점부터 24시간
- 자동 삭제: Cron 트리거로 12시간마다 실행 (KST 오전 9시, 오후 9시)
- 속도 제한: IP당 분당 60회
- 차단 MIME 타입: `text/html`, `application/x-httpd-php`, `application/x-msdownload`, `application/x-msdos-program`, `application/x-java-archive`
- R2 저장소 최대 10GB
