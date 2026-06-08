# file-server

Cloudflare Workers + R2 기반 파일 서버. 최대 250MB 파일 업로드, 24시간 보관 후 자동 삭제.

## 배포 주소

- 운영 서버: [https://file.kalpha.kr](https://file.kalpha.kr)
- CORS 허용 도메인: [https://kalpha.mmv.kr](https://kalpha.mmv.kr)

## 기술 스택

- Cloudflare Workers
- Cloudflare R2 (10GB 저장소)
- Hono + @hono/zod-openapi
- TypeScript

## 환경 변수

| 변수명 | 설명 |
|--------|------|
| `API_KEY` | 파일 업로드 및 다운로드용 API 키 |
| `ADMIN_ID` | 관리자 로그인 아이디 (`kalpha`) |
| `ADMIN_PW_HASH` | 관리자 비밀번호 SHA-256 해시 |
| `ALLOWED_ORIGIN` | CORS 허용 출처 |
| `MAX_UPLOAD_SIZE` | 파일당 최대 업로드 크기 (기본: 262144000) |
| `RATE_LIMIT_PER_MINUTE` | IP당 분당 요청 제한 (기본: 60) |

## 로컬 개발

```bash
npm install
npx wrangler dev
```

## 배포

```bash
npx wrangler deploy
```

## 권한 체계

| 권한 | API_KEY | 관리자 토큰 |
|------|---------|------------|
| 파일 업로드 | O | O |
| 파일 다운로드 | O | O |
| 파일 목록 조회 | X | O |
| 파일 메타데이터 조회 | X | O |
| 파일 삭제 | X | O |

## 관리자 접근

1. [https://file.kalpha.kr/admin/login](https://file.kalpha.kr/admin/login) 접속
2. 관리자 아이디와 비밀번호로 로그인
3. 대시보드에서 파일 목록 확인, 다운로드 URL 복사, 파일 삭제 가능

## API 엔드포인트

모든 파일 API는 `Authorization: Bearer <token>` 인증 필요.
API 문서는 [https://file.kalpha.kr/api/docs](https://file.kalpha.kr/api/docs) (관리자 로그인 필요).

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| POST | `/api/files` | API_KEY 또는 관리자 | 파일 업로드 (multipart) |
| GET | `/api/files/:id` | API_KEY 또는 관리자 | 파일 다운로드 |
| GET | `/api/files` | 관리자 | 파일 목록 조회 |
| GET | `/api/files/:id/info` | 관리자 | 파일 메타데이터 |
| DELETE | `/api/files/:id` | 관리자 | 파일 삭제 |

## 제한 사항

- 파일당 최대 크기: 250MB
- 보관 기간: 업로드 후 24시간 (매 12시간마다 만료 파일 자동 삭제)
- IP당 분당 60회 요청 제한
- 차단된 MIME 타입: text/html, application/x-httpd-php 등
