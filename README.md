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

R2 수명주기 규칙 -> 객체 나이 24시간 경과 시 자동 삭제
                    (미완료 멀티파트 업로드는 7일 후 abort)
```

### 파일 생명 주기

1. 클라이언트가 `POST /api/files`로 파일 업로드 (multipart/form-data, 최대 50MB)
2. 50MB 초과 파일은 청크 업로드 API 사용 (`POST /api/files/chunked/init` -> `/part` -> `/complete`, 최대 250MB)
3. 서버가 UUID 파일 ID 생성, R2에 저장하며 `expireAt` 메타데이터 기록 (업로드 + 24시간)
4. R2 수명주기 규칙이 객체 나이 24시간 경과 시 자동 삭제 (Worker Cron 아님)
5. 관리자 연장(`PUT /api/files/:id/extend`)은 객체를 다시 쓰는 방식이라 나이가 리셋되어 만료 시각이 현재 + 24시간이 됩니다 (`hours` 값과 무관)

### 디렉토리 구조

```
src/
  index.ts          # Worker 진입점 (fetch)
  app.ts            # Hono 앱 조립
  routes/
    files.ts        # 파일 API 라우트 (업로드/청크/다운로드/공유/연장/통계)
    admin.ts        # 관리자 페이지 라우트
  middleware/
    auth.ts         # API 인증 (API_KEY + 관리자 토큰)
    admin-auth.ts   # 관리자 페이지/API 인증
    cors.ts         # CORS 처리
    rate-limit.ts   # IP 기반 속도 제한
  services/
    r2.ts           # R2 버킷 작업 (업로드/다운로드/삭제/목록/멀티파트)
    admin.ts        # 관리자 로그인/토큰 관리 (PBKDF2 + HMAC-SHA256)
    stats.ts        # 버킷 통계 (isolate 로컬 60초 캐시)
    logger.ts       # 구조화 JSON 로그
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
- **파일 크기 제한**: 단일 업로드 50MB, 청크 업로드 합계 250MB
- **MIME 제한**: 없음 (모든 파일 형식 허용)
- **파일 키**: UUID v4 자동 생성으로 경로 추측 불가
- **다운로드 헤더**: `Content-Disposition: attachment` 강제, `X-Content-Type-Options: nosniff`
- **만료 검사**: 다운로드 시 `expireAt` 경과 파일은 404 반환
- **관리자 비밀번호**: PBKDF2-SHA256 (10만 회) 해시로 저장, 레거시 SHA-256 해시도 검증 지원
- **관리자 토큰**: HMAC-SHA256 서명, 12시간 만료, httpOnly + Secure + SameSite=Strict 쿠키

## 환경 변수

### wrangler.toml에 설정하는 변수

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `ADMIN_ID` | 관리자 로그인 아이디 | `kalpha` |
| `ADMIN_PW_HASH` | 관리자 비밀번호 SHA-256 해시 (생성 방법은 아래 참고) | - |
| `ALLOWED_ORIGIN` | CORS 허용 출처 | `https://kalpha.mmv.kr` |
| `MAX_UPLOAD_SIZE` | 청크 업로드 기준 전체 최대 크기 (바이트) | `262144000` |
| `RATE_LIMIT_PER_MINUTE` | IP당 분당 요청 제한 | `60` |

### Secret으로 설정하는 변수

```bash
wrangler secret put API_KEY
wrangler secret put ADMIN_TOKEN_SECRET
```

`API_KEY`는 파일 업로드/다운로드를 위한 키입니다. `ADMIN_TOKEN_SECRET`은 관리자 토큰(JWT) 서명 키입니다. 둘 다 `wrangler.toml`에 평문으로 넣지 말고 반드시 secret으로 설정하세요.

### ADMIN_PW_HASH 생성 방법

```bash
npx tsx scripts/hash-pbkdf2.ts '원하는_비밀번호'
```

출력된 `pbkdf2:100000:...` 값을 `wrangler.toml`의 `ADMIN_PW_HASH`에 설정합니다. 기존 SHA-256 해시가 설정되어 있어도 동작합니다 (PBKDF2 우선 검증, 실패 시 레거시 SHA-256 검증).

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
| `FILE_TOO_LARGE` | 413 | 단일 업로드 50MB 초과 (청크 업로드 사용) |
| `INVALID_FILE_TYPE` | 415 | 차단된 파일 형식 |
| `VALIDATION_ERROR` | 400 | 요청 형식 오류 |
| `RATE_LIMITED` | 429 | 속도 제한 초과 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

## 관리자 대시보드

1. [https://file.kalpha.kr/admin/login](https://file.kalpha.kr/admin/login) 접속
2. 관리자 아이디와 비밀번호 입력
3. 대시보드 기능:
   - 파일 목록/검색, 통계 카드, 페이지네이션 (20/50/100)
   - 드래그 앤 드롭 다중 업로드 (10MB 초과 시 자동 청크 업로드)
   - 선택 삭제, 다운로드 URL 복사, 공유 링크 생성, 만료 연장(+24시간 리셋)
   - 파일 상세 정보 모달 (이미지 미리보기 포함)
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

- 단일 업로드 최대 크기: 50MB
- 청크 업로드 최대 크기: 250MB
- 보관 기간: 객체 나이 기준 24시간
- 자동 삭제: R2 수명주기 규칙 (Worker Cron 아님, 미완료 멀티파트는 7일 후 abort)
- 만료 연장: 관리자 전용, 현재 시각 + 24시간으로 리셋 (`hours` 값 무관)
- 만료 파일 다운로드: 404 반환
- 속도 제한: IP당 분당 60회 (isolate 메모리 기반, 콜드 스타트 시 초기화)
- MIME 제한: 없음
- R2 저장소 최대 10GB
