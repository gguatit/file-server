import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { verifyAdminPassword, createAdminToken } from '../services/admin'
import { adminPageAuth } from '../middleware/admin-auth'

const app = new Hono<{ Bindings: Env; Variables: { adminToken: string } }>()

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

const loginHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>관리자 로그인 - 파일 서버</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .login-box { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 40px; width: 100%; max-width: 380px; }
    h1 { font-size: 20px; margin-bottom: 8px; color: #f0f6fc; }
    p { font-size: 13px; color: #8b949e; margin-bottom: 24px; }
    label { display: block; font-size: 13px; margin-bottom: 4px; color: #c9d1d9; }
    input { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 14px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #58a6ff; }
    button { width: 100%; padding: 10px; background: #238636; border: none; border-radius: 4px; color: #fff; font-size: 14px; cursor: pointer; font-weight: 600; }
    button:hover { background: #2ea043; }
    .error { color: #f85149; font-size: 13px; margin-bottom: 16px; display: none; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>파일 서버 관리자</h1>
    <p>관리자 계정으로 로그인하세요.</p>
    <div class="error" id="error">아이디 또는 비밀번호가 올바르지 않습니다.</div>
    <form id="loginForm">
      <label for="id">아이디</label>
      <input type="text" id="id" name="id" required autofocus />
      <label for="password">비밀번호</label>
      <input type="password" id="password" name="password" required />
      <button type="submit">로그인</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const error = document.getElementById('error')
      error.style.display = 'none'
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: document.getElementById('id').value,
          password: document.getElementById('password').value,
        }),
      })
      if (res.ok) {
        window.location.href = '/admin'
      } else {
        error.style.display = 'block'
      }
    })
  </script>
</body>
</html>`

app.get('/admin/login', (c) => {
  return c.html(loginHTML)
})

app.post('/admin/login', async (c) => {
  let body: { id?: string; password?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '요청 형식이 올바르지 않습니다.' } }, 400)
  }

  if (!body || typeof body !== 'object' || !body.id || !body.password) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '아이디와 비밀번호를 입력하세요.' } }, 400)
  }

  if (body.id !== c.env.ADMIN_ID) {
    await new Promise((r) => setTimeout(r, 500))
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } }, 401)
  }

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (attempt && now < attempt.resetAt && attempt.count >= 5) {
    return c.json({ success: false, error: { code: 'RATE_LIMITED', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } }, 429)
  }

  const valid = await verifyAdminPassword(body.password, c.env.ADMIN_PW_HASH)
  if (!valid) {
    if (!attempt || now > attempt.resetAt) {
      loginAttempts.set(ip, { count: 1, resetAt: now + 300000 })
    } else {
      attempt.count++
    }
    await new Promise((r) => setTimeout(r, 500))
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } }, 401)
  }

  loginAttempts.delete(ip)

  const token = await createAdminToken(body.id, c.env.ADMIN_TOKEN_SECRET)

  c.header(
    'Set-Cookie',
    `admin_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
  )

  return c.json({ success: true, data: { token } })
})

app.get('/admin/logout', (c) => {
  c.header(
    'Set-Cookie',
    'admin_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
  )
  return c.redirect('/admin/login')
})

const dashboardHTML = (token: string) => `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>파일 서버 관리자</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 16px; color: #f0f6fc; }
    .header a { color: #58a6ff; text-decoration: none; font-size: 13px; }
    .header a:hover { text-decoration: underline; }
    .stats { padding: 16px 24px; display: flex; gap: 16px; flex-wrap: wrap; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px 20px; min-width: 160px; }
    .stat-card .label { font-size: 12px; color: #8b949e; margin-bottom: 4px; }
    .stat-card .value { font-size: 20px; color: #f0f6fc; font-weight: 600; }
    .upload-area { margin: 0 24px 16px; padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; }
    .upload-area h3 { font-size: 14px; margin-bottom: 12px; color: #f0f6fc; }
    .upload-area input[type=file] { margin-bottom: 8px; color: #c9d1d9; }
    .upload-area button { padding: 8px 16px; background: #238636; border: none; border-radius: 4px; color: #fff; font-size: 13px; cursor: pointer; }
    .upload-area button:hover { background: #2ea043; }
    .upload-area .progress { color: #8b949e; font-size: 12px; margin-top: 8px; }
    .file-list { margin: 0 24px; }
    .file-list h3 { font-size: 14px; margin-bottom: 12px; color: #f0f6fc; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 600; }
    td { color: #c9d1d9; }
    td a { color: #58a6ff; text-decoration: none; }
    td a:hover { text-decoration: underline; }
    .btn-delete { padding: 4px 10px; background: #da3633; border: none; border-radius: 4px; color: #fff; font-size: 12px; cursor: pointer; }
    .btn-delete:hover { background: #f85149; }
    .btn-copy { padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 12px; cursor: pointer; margin-right: 4px; }
    .btn-copy:hover { background: #30363d; }
    .empty { text-align: center; padding: 40px; color: #8b949e; font-size: 14px; }
    .pagination { display: flex; justify-content: center; gap: 8px; margin: 16px 0; }
    .pagination button { padding: 6px 14px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
    .pagination button:hover { background: #30363d; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
  </style>
</head>
<body>
  <div class="header">
    <h1>파일 서버 관리자</h1>
    <div>
      <a href="/api/docs">API 문서</a>
      <span style="color:#30363d;margin:0 8px">|</span>
      <a href="/admin/logout">로그아웃</a>
    </div>
  </div>
  <div class="stats">
    <div class="stat-card">
      <div class="label">총 파일 수</div>
      <div class="value" id="fileCount">-</div>
    </div>
    <div class="stat-card">
      <div class="label">총 저장 용량</div>
      <div class="value" id="totalSize">-</div>
    </div>
  </div>
  <div class="file-list">
    <h3>저장된 파일</h3>
    <table>
      <thead>
        <tr>
          <th>파일명</th>
          <th>크기</th>
          <th>업로드 시간</th>
          <th>만료 시간</th>
          <th>작업</th>
        </tr>
      </thead>
      <tbody id="fileTableBody">
        <tr><td colspan="5" class="empty">불러오는 중...</td></tr>
      </tbody>
    </table>
    <div class="pagination" id="pagination"></div>
  </div>
  <script>
    var ADMIN_TOKEN = ${JSON.stringify(token)};
    var cursor = null;
    var prevCursors = [];

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatTime(iso) {
      if (!iso) return '-';
      return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    }

    async function api(path, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      opts.headers['Authorization'] = 'Bearer ' + ADMIN_TOKEN;
      opts.credentials = 'same-origin';
      return fetch(path, opts);
    }

    async function loadFiles(c) {
      var url = '/api/files?limit=20';
      if (c) url += '&cursor=' + encodeURIComponent(c);
      var tbody = document.getElementById('fileTableBody');
      try {
        var res = await api(url);
        var data = await res.json();
        if (!data.success) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">API 오류: ' + esc(JSON.stringify(data.error)) + '</td></tr>';
          return;
        }
        if (!data.data) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">응답 데이터가 없습니다.</td></tr>';
          return;
        }
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">요청 실패: ' + esc(e.message || '') + '</td></tr>';
        return;
      }

      var tbody = document.getElementById('fileTableBody');
      if (!data.data.items.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">저장된 파일이 없습니다.</td></tr>';
        document.getElementById('fileCount').textContent = '0';
        document.getElementById('totalSize').textContent = '0 B';
        return;
      }

      var totalSize = 0;
      var rows = data.data.items.map(function(f) {
        totalSize += f.size;
        var safeName = JSON.stringify(f.originalFilename);
        var safeId = JSON.stringify(f.id);
        return '<tr>' +
          '<td>' + esc(f.originalFilename) + '</td>' +
          '<td>' + formatSize(f.size) + '</td>' +
          '<td>' + formatTime(f.uploadedAt) + '</td>' +
          '<td>' + formatTime(f.expireAt) + '</td>' +
          '<td>' +
            '<button class="btn-copy" onclick="copyUrl(' + safeId + ', ' + safeName + ')">복사</button>' +
            '<button class="btn-delete" onclick="deleteFile(' + safeId + ')">삭제</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      document.getElementById('fileCount').textContent = data.data.items.length;
      document.getElementById('totalSize').textContent = formatSize(totalSize);

      cursor = data.data.cursor;
      var hasMore = data.data.hasMore;
      var pagDiv = document.getElementById('pagination');
      var html = '';
      if (prevCursors.length > 0) {
        html += '<button onclick="goBack()">이전</button>';
      }
      if (hasMore) {
        html += '<button onclick="goNext()">다음</button>';
      }
      pagDiv.innerHTML = html;
    }

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function goNext() {
      if (cursor) {
        prevCursors.push(cursor);
        loadFiles(cursor);
      }
    }

    function goBack() {
      var prev = prevCursors.pop();
      loadFiles(prev || null);
    }

    async function deleteFile(id) {
      if (!confirm('이 파일을 삭제하시겠습니까?')) return;
      var res = await api('/api/files/' + id, { method: 'DELETE' });
      var data = await res.json();
      if (data.success) {
        loadFiles(cursor ? prevCursors[prevCursors.length - 1] || null : null);
      } else {
        alert('삭제 실패: ' + (data.error && data.error.message || '알 수 없는 오류'));
      }
    }

    function copyUrl(id, name) {
      var url = 'https://file.kalpha.kr/api/files/' + id;
      navigator.clipboard.writeText(url).then(function() {
        alert('다운로드 URL이 복사되었습니다.\\n파일명: ' + name);
      }).catch(function() {
        prompt('아래 URL을 복사하세요:', url);
      });
    }

    loadFiles(null);
  </script>
</body>
</html>`

app.get('/admin', adminPageAuth(), (c) => {
  const token = c.get('adminToken')
  return c.html(dashboardHTML(token))
})

export default app
