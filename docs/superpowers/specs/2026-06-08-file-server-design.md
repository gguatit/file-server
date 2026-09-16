# 파일 서버 설계 문서

**작성일:** 2026-06-08  
**상태:** 승인됨 (2026-09-16 현행화)

---

## 개요

Cloudflare Workers + R2 버킷을 활용한 경량 파일 서버. 최대 10GB 저장 공간, 1백만 건의 Class A 작업, 1천만 건의 Class B 작업을 지원하며, 업로드된 파일은 24시간 후 자동 삭제된다. 허용 도메인 `kalpha.mmv.kr`에서만 CORS 접근을 허용하며, OpenAPI 3.0 명세를 따른다. 관리자 대시보드(`/admin`)에서 업로드/목록/통계/공유/연장을 관리한다.

---

## 기술 스택

| 계층 | 기술 |
|------|------|
| **런타임** | Cloudflare Workers |
| **스토리지** | Cloudflare R2 (S3 호환 객체 저장소) |
| **프레임워크** | Hono + `@hono/zod-openapi` |
| **검증** | Zod |
| **API 문서** | Scalar UI (`@scalar/hono-api-reference`) |
| **인증** | Bearer API Key + 관리자 JWT (PBKDF2 비밀번호 검증) |
| **언어** | TypeScript |

---

## 프로젝트 구조

```
file-server/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── scripts/
│   ├── hash-pbkdf2.ts         # ADMIN_PW_HASH 생성기 (권장)
│   └── hash-legacy.ts         # 레거시 SHA-256 해시 생성기
├── src/
│   ├── index.ts               # 진입점: fetch 핸들러 (scheduled 없음)
│   ├── app.ts                 # Hono 앱 조립 (미들웨어, 라우트 연결)
│   ├── routes/
│   │   ├── files.ts           # 파일 API (업로드/청크/다운로드/공유/연장/통계)
│   │   └── admin.ts           # 관리자 로그인 + 대시보드
│   ├── middleware/
│   │   ├── auth.ts            # API Key / 관리자 토큰 검증
│   │   ├── admin-auth.ts      # 관리자 페이지/API 인증 (쿠키 또는 Bearer)
│   │   ├── cors.ts            # 허용 도메인 CORS 설정
│   │   └── rate-limit.ts      # IP 기반 Rate Limit
│   ├── services/
│   │   ├── r2.ts              # R2 작업 추상화 (단일/멀티파트 업로드, 목록, 삭제)
│   │   ├── admin.ts           # PBKDF2 검증, 관리자/공유 토큰 (HMAC-SHA256 JWT)
│   │   ├── stats.ts           # 버킷 통계 (isolate 로컬 60초 캐시)
│   │   └── logger.ts          # 구조화 JSON 로그
│   ├── schemas/
│   │   └── files.ts           # Zod 스키마 + OpenAPI 메타데이터 + 상수
│   └── lib/
│       ├── openapi.ts         # OpenAPI 문서 생성 및 설정
│       └── types.ts           # 공통 타입 정의
```

---

## 아키텍처

### 단일 Worker 모놀리스

하나의 Worker가 모든 역할을 수행한다:

- **`fetch` 핸들러**: 모든 HTTP API 요청 처리 (파일 업로드, 다운로드, 목록 조회, 삭제, 메타데이터, 공유)
- **자동 삭제**: Worker Cron이 아니라 **R2 수명주기 규칙**이 담당 (객체 나이 24시간 경과 시 삭제, 미완료 멀티파트 업로드는 7일 후 abort)

### 데이터 흐름

```
클라이언트 (kalpha.mmv.kr)
       │
       ▼
   Cloudflare Worker
       │
       └── fetch → Hono App → Middleware → Route Handler → R2

R2 Custom Metadata (업로드 시 저장):
  ┌─────────────────────────────────────────┐
  │  expireAt:        ISO 8601 타임스탬프     │
  │  originalFilename: 원본 파일명            │
  │  uploadedAt:      ISO 8601 타임스탬프     │
  └─────────────────────────────────────────┘
  (콘텐츠 타입은 R2 httpMetadata.contentType)
```

### 파일 생명주기

1. 단일 업로드: `POST /api/files` (multipart/form-data, 최대 50MB)
2. 50MB 초과: 청크 업로드 (`POST /api/files/chunked/init` → `/part` → `/complete`, 최대 250MB)
3. 서버가 UUID 파일 ID 생성, R2에 저장하며 `expireAt`(업로드 + 24시간) 메타데이터 기록
4. R2 수명주기 규칙이 객체 나이 24시간 경과 시 자동 삭제
5. 다운로드 시 `expireAt`을 검사해 만료된 파일은 404 반환 (수명주기 삭제 전에도 차단)
6. 관리자 연장(`PUT /api/files/:id/extend`)은 객체를 다시 쓰는 방식이라 나이가 리셋되어 만료 시각이 **현재 + 24시간**이 된다 (`hours` 값은 하위 호환용으로 무시됨)

---

## API 엔드포인트

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| `GET` | `/` | 소개 페이지 (HTML) | 없음 |
| `GET` | `/api/health` | 헬스 체크 | 없음 |
| `POST` | `/api/files` | 단일 파일 업로드 (최대 50MB) | Bearer |
| `POST` | `/api/files/chunked/init` | 청크 업로드 초기화 | Bearer |
| `POST` | `/api/files/chunked/:uploadId/part` | 청크 파트 업로드 | Bearer |
| `POST` | `/api/files/chunked/:uploadId/complete` | 청크 업로드 완료 | Bearer |
| `GET` | `/api/files` | 파일 목록 조회 (관리자, 페이징: `?page=&limit=`) | 관리자 |
| `GET` | `/api/files/:id/info` | 파일 메타데이터 조회 | 관리자 |
| `GET` | `/api/files/:id` | 파일 다운로드 (바이너리 스트림) | Bearer |
| `DELETE` | `/api/files/:id` | 파일 삭제 | 관리자 |
| `PUT` | `/api/files/:id/extend` | 만료 연장 (현재 + 24시간으로 리셋) | 관리자 |
| `POST` | `/api/files/:id/share` | 공유 링크 생성 (`expiryHours` 1~72, 기본 1) | 관리자 |
| `GET` | `/api/dl/:token` | 공유 링크 다운로드 | 없음 |
| `GET` | `/api/stats` | 버킷 통계 | 관리자 |
| `GET` | `/admin/login`, `POST /admin/login`, `GET /admin/logout` | 관리자 로그인/로그아웃 | 없음 |
| `GET` | `/admin` | 관리자 대시보드 (HTML) | 관리자 |
| `GET` | `/api/openapi` | OpenAPI 3.0 JSON 문서 | 관리자 |
| `GET` | `/api/docs` | Scalar API 문서 UI | 관리자 |

> 인증이 "Bearer"인 엔드포인트는 API Key 또는 관리자 토큰 모두 허용. "관리자"는 관리자 토큰만 허용 (API Key로 요청 시 403).

### 응답 형식

**성공 응답:**

```json
{
  "success": true,
  "data": { ... }
}
```

**에러 응답:**

```json
{
  "success": false,
  "error": {
    "code": "FILE_NOT_FOUND",
    "message": "파일을 찾을 수 없습니다."
  }
}
```

---

## 보안

### 1. 인증 체계

두 가지 인증 수단을 사용한다.

| 인증 수단 | 발급 방식 | 권한 범위 |
|-----------|----------|----------|
| API Key | `wrangler secret put API_KEY` | 파일 업로드, 다운로드 |
| 관리자 토큰 | `/admin/login` 로그인 시 발급 (HS256 JWT, 12시간 유효) | 모든 작업 |

- 비밀번호는 `ADMIN_PW_HASH`에 저장. `pbkdf2:100000:<salt>:<hash>` 형식(PBKDF2-HMAC-SHA256, 100,000회)을 우선 지원하며, 기존 SHA-256 해시도 폴백으로 검증
- 관리자 토큰은 `ADMIN_TOKEN_SECRET`으로 서명한 HS256 JWT (payload: `{id, iat, exp}`)
- 비밀번호 해시 생성: `npx tsx scripts/hash-pbkdf2.ts '<비밀번호>'`

### 2. CORS — 허용 도메인 제한

- 요청에 `Origin`이 있으면 `ALLOWED_ORIGIN` 또는 동일 출처(same-origin)만 허용, 그 외 403
- `Access-Control-Allow-Origin`: 요청 오리진 (허용 시)
- `Access-Control-Allow-Methods`: `GET, POST, PUT, DELETE, OPTIONS`
- `Access-Control-Allow-Headers`: `Authorization, Content-Type`
- `Access-Control-Max-Age`: `86400`
- `OPTIONS` 프리플라이트는 204 반환

### 3. IP 기반 Rate Limit

- IP당 분당 60회 요청 제한 (`RATE_LIMIT_PER_MINUTE`)
- 초과 시 `429 Too Many Requests` 반환
- Worker isolate 메모리 기반 카운터: isolate 간 공유되지 않고 콜드 스타트 시 리셋됨 (제한적이지만 수용)
- 제외 경로: `/admin*`, `/api/docs`, `/api/openapi`, `/api/health`, `/api/dl/`
- 로그인 실패 반복 시 별도로 IP당 5회/5분 제한

### 4. 업로드 제한

- 단일 업로드: 최대 **50MB** (`SINGLE_UPLOAD_MAX_SIZE`, Workers 메모리 한계 고려, 초과 시 413 + 청크 업로드 안내)
- 청크 업로드: 총 최대 **250MB** (`MAX_UPLOAD_SIZE`)
- 파일명 최대 512자
- MIME 타입 차단은 현재 비활성 (`BLOCKED_MIME_TYPES = []`). 활성화 시 `INVALID_FILE_TYPE`(415) 반환

### 5. HTTP 보안 헤더

- 다운로드 응답: `X-Content-Type-Options: nosniff`, `X-Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
- 관리자 페이지: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`

---

## 청크(멀티파트) 업로드

R2 멀티파트 업로드를 사용해 250MB까지 업로드한다.

1. `POST /api/files/chunked/init` — `{filename, totalSize}` → `uploadId`, `fileId` 발급
2. `POST /api/files/chunked/:uploadId/part` — 10MB 단위 파트 업로드 (대시보드는 3개 병렬), `{partNumber, etag}` 수집
3. `POST /api/files/chunked/:uploadId/complete` — `{uploadId, fileId, parts}` → 업로드 완료, `expireAt` 메타데이터 기록

중도 실패 시 별도 abort를 하지 않으며, 미완료 멀티파트 업로드는 R2 수명주기 규칙이 7일 후 자동 abort한다.

---

## 공유 링크

- `POST /api/files/:id/share` — `expiryHours` 1~72 (기본 1) → `ADMIN_TOKEN_SECRET`으로 서명한 공유 토큰 발급
- `GET /api/dl/:token` — 인증 없이 다운로드 가능. 토큰의 `type: 'share'`와 `exp`를 검증하며, 만료/위조 시 404

---

## 관리자 대시보드

- `GET /admin` — 인라인 HTML/JS 대시보드 (관리자 토큰을 페이지에 임베드)
- 기능: 파일 목록/검색/페이징(20/50/100), 통계 카드, 드래그 앤 드롭 다중 업로드(10MB 초과 시 청크), 선택 삭제, URL 복사, 공유 링크 생성, 만료 연장, 상세 모달 + 이미지 미리보기, 토스트, 모바일 대응
- `/api/stats`는 isolate 로컬 60초 캐시를 사용한다 (`services/stats.ts`)

---

## Wrangler 설정

```toml
name = "file-server"
main = "src/index.ts"
compatibility_date = "2026-06-08"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "FILE_BUCKET"
bucket_name = "file-server-bucket"

# [triggers] crons 없음 — 삭제는 R2 수명주기 규칙이 담당

[vars]
MAX_UPLOAD_SIZE = 262144000        # 청크 업로드 총량 상한 (250MB)
RATE_LIMIT_PER_MINUTE = 60
ALLOWED_ORIGIN = "https://kalpha.mmv.kr"
ADMIN_ID = "kalpha"
ADMIN_PW_HASH = "pbkdf2:..."
SHARE_BASE_URL = "https://file.kalpha.kr"
```

**Secrets** (`wrangler secret put <이름>`):

- `API_KEY` — 파일 API Bearer 키
- `ADMIN_TOKEN_SECRET` — 관리자/공유 토큰 서명 키

### R2 수명주기 규칙 (버킷 설정)

| 규칙 | 조건 | 동작 |
|------|------|------|
| Default Multipart Abort Rule | 7일 경과 | 미완료 멀티파트 업로드 abort |
| day | 객체 나이 24시간 경과 | 객체 삭제 |

---

## 에러 코드

| 코드 | HTTP 상태 | 설명 |
|------|-----------|------|
| `UNAUTHORIZED` | 401 | 인증 정보가 없거나 유효하지 않음 |
| `FORBIDDEN` | 403 | 허용되지 않은 오리진 또는 권한 부족 (API Key로 관리자 작업 등) |
| `RATE_LIMITED` | 429 | 분당 요청 한도 초과 또는 로그인 시도 초과 |
| `FILE_TOO_LARGE` | 413 | 단일 50MB 초과 또는 청크 총량 250MB 초과 |
| `INVALID_FILE_TYPE` | 415 | 허용되지 않은 MIME 타입 (차단 활성 시에만) |
| `FILE_NOT_FOUND` | 404 | 파일이 없거나 보관 기간 만료 |
| `INVALID_SHARE` | 404 | 공유 링크가 무효하거나 만료됨 |
| `VALIDATION_ERROR` | 400 | 요청 파라미터 검증 실패 |
| `NOT_FOUND` | 404 | 라우트가 존재하지 않음 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

---

## 제약 사항

| 항목 | 제한 |
|------|------|
| R2 최대 저장 공간 | 10GB |
| Class A 작업 (월) | 1,000,000회 (쓰기, 삭제) |
| Class B 작업 (월) | 10,000,000회 (읽기) |
| 파일당 최대 크기 | 단일 50MB / 청크 250MB |
| 파일 보관 기간 | 업로드 후 24시간 (R2 수명주기, 객체 나이 기준) |
| Worker CPU 시간 | 요청당 30초 (Paid), 10ms (Free) |
| 만료 연장 | 항상 현재 + 24시간으로 리셋 |
| 공유 링크 유효 기간 | 1~72시간 (기본 1시간) |
