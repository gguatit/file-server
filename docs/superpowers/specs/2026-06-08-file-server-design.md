# 파일 서버 설계 문서

**작성일:** 2026-06-08  
**상태:** 승인됨

---

## 개요

Cloudflare Workers + R2 버킷을 활용한 경량 파일 서버. 최대 10GB 저장 공간, 1백만 건의 Class A 작업, 1천만 건의 Class B 작업을 지원하며, 업로드된 파일은 24시간 후 자동 삭제된다. 허용 도메인 `kalpha.mmv.kr`에서만 CORS 접근을 허용하며, OpenAPI 3.0 명세를 따른다.

---

## 기술 스택

| 계층 | 기술 |
|------|------|
| **런타임** | Cloudflare Workers |
| **스토리지** | Cloudflare R2 (S3 호환 객체 저장소) |
| **프레임워크** | Hono + `@hono/zod-openapi` |
| **검증** | Zod |
| **API 문서** | Scalar UI (`@scalar/hono-api-reference`) |
| **언어** | TypeScript |

---

## 프로젝트 구조

```
file-server/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # 진입점: fetch + scheduled 핸들러
│   ├── app.ts                 # Hono 앱 조립 (미들웨어, 라우트 연결)
│   ├── routes/
│   │   └── files.ts           # 파일 CRUD 라우트 정의
│   ├── middleware/
│   │   ├── auth.ts            # Bearer API Key 검증
│   │   ├── cors.ts            # kalpha.mmv.kr CORS 설정
│   │   └── rate-limit.ts      # IP 기반 Rate Limit
│   ├── services/
│   │   ├── r2.ts              # R2 작업 추상화 계층
│   │   └── cleanup.ts         # Cron 정리 로직
│   ├── schemas/
│   │   └── files.ts           # Zod 스키마 + OpenAPI 메타데이터
│   └── lib/
│       ├── openapi.ts         # OpenAPI 문서 생성 및 설정
│       └── types.ts           # 공통 타입 정의
```

---

## 아키텍처

### 단일 Worker 모놀리스

하나의 Worker가 모든 역할을 수행한다:

- **`fetch` 핸들러**: 모든 HTTP API 요청 처리 (파일 업로드, 다운로드, 목록 조회, 삭제, 메타데이터)
- **`scheduled` 핸들러**: Cron 트리거를 받아 만료된 파일 정리 (12시간 간격)

### 데이터 흐름

```
클라이언트 (kalpha.mmv.kr)
       │
       ▼
   Cloudflare Worker
       │
       ├── fetch → Hono App → Middleware → Route Handler → R2
       │
       └── scheduled → Cleanup Service → R2 (만료 파일 삭제)

R2 Custom Metadata (업로드 시 저장):
  ┌─────────────────────────────────────────┐
  │  expireAt:        ISO 8601 타임스탬프     │
  │  originalFilename: 원본 파일명            │
  │  uploadedAt:      ISO 8601 타임스탬프     │
  │  size:            파일 크기 (bytes)       │
  └─────────────────────────────────────────┘
```

---

## API 엔드포인트

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| `POST` | `/api/files` | 파일 업로드 (multipart/form-data, 최대 250MB) | Bearer |
| `GET` | `/api/files` | 파일 목록 조회 (페이징: `?cursor=&limit=`) | Bearer |
| `GET` | `/api/files/:id` | 파일 다운로드 (바이너리 스트림) | Bearer |
| `GET` | `/api/files/:id/info` | 파일 메타데이터 조회 | Bearer |
| `DELETE` | `/api/files/:id` | 파일 삭제 | Bearer |
| `GET` | `/api/openapi` | OpenAPI 3.0 JSON 문서 | 없음 |
| `GET` | `/api/docs` | Scalar API 문서 UI | 없음 |

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

### 1. 인증 — Bearer API Key

- 환경변수 `API_KEY`에 저장된 키와 요청의 `Authorization: Bearer <key>` 헤더를 대조
- 일치하지 않으면 `401 Unauthorized` 반환

### 2. CORS — 허용 도메인 제한

- `Access-Control-Allow-Origin`: `https://kalpha.mmv.kr`
- `Access-Control-Allow-Methods`: `GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers`: `Authorization, Content-Type`
- `Access-Control-Max-Age`: `86400`

### 3. IP 기반 Rate Limit

- IP당 분당 60회 요청 제한
- 초과 시 `429 Too Many Requests` 반환
- 메모리 기반 카운터 (Worker 인스턴스 간 공유 불필요, 제한적이지만 충분)

### 4. 업로드 제한

- 파일 하나당 최대 **250MB** (`max-size` 검증)
- MIME 타입 검증: `text/html` 등 악용 가능한 콘텐츠 타입 차단
- 멀티파트 파일 필드명 검증

### 5. HTTP 보안 헤더

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

---

## Cron 정리 (24시간 자동 삭제)

### 트리거

```toml
[triggers]
crons = ["0 0,12 * * *"]   # 매일 00:00, 12:00 (UTC) → KST로는 09:00, 21:00
```

### 작동 방식

1. `scheduled` 이벤트 발생 시 `cleanup.ts` 서비스 실행
2. R2 버킷의 모든 객체를 순회
3. 각 객체의 custom metadata `expireAt` 값과 현재 시간 비교
4. `expireAt < now()` 이면 해당 객체 삭제

### expireAt 계산

- 업로드 시점: `new Date()`
- 만료 시점: `new Date(uploadedAt.getTime() + 24 * 60 * 60 * 1000)`
- R2 custom metadata `expireAt` 필드에 ISO 8601 형식으로 저장

---

## Wrangler 설정

```toml
name = "file-server"
main = "src/index.ts"
compatibility_date = "2026-06-08"

[[r2_buckets]]
binding = "FILE_BUCKET"
bucket_name = "file-server-bucket"

[triggers]
crons = ["0 0,12 * * *"]

[vars]
MAX_UPLOAD_SIZE = 262144000   # 250MB in bytes
RATE_LIMIT_PER_MINUTE = 60
ALLOWED_ORIGIN = "https://kalpha.mmv.kr"

[[d1_databases]] # (선택 사항: 메타데이터 인덱싱용)
```

---

## 에러 코드

| 코드 | HTTP 상태 | 설명 |
|------|-----------|------|
| `UNAUTHORIZED` | 401 | API 키가 없거나 유효하지 않음 |
| `FORBIDDEN` | 403 | 허용되지 않은 오리진 |
| `RATE_LIMITED` | 429 | IP당 분당 요청 한도 초과 |
| `FILE_TOO_LARGE` | 413 | 파일 크기가 250MB 초과 |
| `INVALID_FILE_TYPE` | 415 | 허용되지 않은 MIME 타입 |
| `FILE_NOT_FOUND` | 404 | 요청한 파일이 존재하지 않음 |
| `VALIDATION_ERROR` | 400 | 요청 파라미터 검증 실패 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

---

## 제약 사항

| 항목 | 제한 |
|------|------|
| R2 최대 저장 공간 | 10GB |
| Class A 작업 (월) | 1,000,000회 (쓰기, 삭제) |
| Class B 작업 (월) | 10,000,000회 (읽기) |
| 파일당 최대 크기 | 250MB |
| 파일 보관 기간 | 업로드 후 24시간 |
| Worker CPU 시간 | 요청당 30초 (Paid), 10ms (Free) |
| Cron 간격 | 12시간마다 |
