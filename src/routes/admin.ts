import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { verifyAdminPassword, createAdminToken } from '../services/admin'
import { adminPageAuth } from '../middleware/admin-auth'
import { logEvent } from '../services/logger'

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
    .login-box { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 40px; width: 100%; max-width: 380px; margin: 16px; }
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
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
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

  const ip = c.req.header('CF-Connecting-IP') || 'unknown'

  if (body.id !== c.env.ADMIN_ID) {
    logEvent('login_failed', ip, { adminId: body.id })
    await new Promise((r) => setTimeout(r, 500))
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } }, 401)
  }

  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (attempt && now < attempt.resetAt && attempt.count >= 5) {
    logEvent('login_failed', ip, { adminId: body.id, details: 'rate_limited' })
    return c.json({ success: false, error: { code: 'RATE_LIMITED', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } }, 429)
  }

  const valid = await verifyAdminPassword(body.password, c.env.ADMIN_PW_HASH)
  if (!valid) {
    if (!attempt || now > attempt.resetAt) {
      loginAttempts.set(ip, { count: 1, resetAt: now + 300000 })
    } else {
      attempt.count++
    }
    logEvent('login_failed', ip, { adminId: body.id })
    await new Promise((r) => setTimeout(r, 500))
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: '아이디 또는 비밀번호가 올바르지 않습니다.' } }, 401)
  }

  loginAttempts.delete(ip)

  const token = await createAdminToken(body.id, c.env.ADMIN_TOKEN_SECRET)
  logEvent('login', ip, { adminId: body.id })

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
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .header h1 { font-size: 16px; color: #f0f6fc; white-space: nowrap; }
    .header-links { display: flex; align-items: center; gap: 10px; }
    .header a { color: #58a6ff; text-decoration: none; font-size: 13px; }
    .header a:hover { text-decoration: underline; }
    .btn-refresh { padding: 5px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 12px; cursor: pointer; }
    .btn-refresh:hover { background: #30363d; }
    .toolbar { padding: 12px 24px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .search-box { flex: 1; min-width: 160px; max-width: 360px; padding: 7px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; outline: none; }
    .search-box:focus { border-color: #58a6ff; }
    .page-size-select { padding: 6px 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
    .stats { padding: 0 24px 12px; display: flex; gap: 12px; flex-wrap: wrap; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; min-width: 130px; flex: 1; }
    .stat-card .label { font-size: 11px; color: #8b949e; margin-bottom: 2px; }
    .stat-card .value { font-size: 18px; color: #f0f6fc; font-weight: 600; }
    .stat-card .sub { font-size: 11px; color: #8b949e; margin-top: 2px; }
    .upload-area { margin: 0 24px 12px; padding: 20px; background: #161b22; border: 2px dashed #30363d; border-radius: 6px; text-align: center; transition: border-color 0.2s; }
    .upload-area.drag-over { border-color: #58a6ff; background: #1a2332; }
    .upload-area span { font-size: 13px; color: #8b949e; display: block; margin-bottom: 6px; }
    .upload-area input[type=file] { color: #c9d1d9; font-size: 13px; }
    .upload-area input[type=file]::file-selector-button { padding: 5px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; cursor: pointer; margin-right: 8px; }
    .btn-upload { padding: 6px 14px; background: #238636; border: none; border-radius: 4px; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; margin-left: 8px; }
    .btn-upload:hover { background: #2ea043; }
    .btn-upload:disabled { opacity: 0.4; cursor: default; }
    .upload-progress { font-size: 12px; color: #8b949e; margin-top: 8px; }
    .file-list { margin: 0 24px; }
    .table-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
    h3 { font-size: 14px; color: #f0f6fc; }
    .action-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .btn-danger { padding: 5px 12px; background: #da3633; border: none; border-radius: 4px; color: #fff; font-size: 12px; cursor: pointer; }
    .btn-danger:hover { background: #f85149; }
    .btn-danger:disabled { opacity: 0.4; cursor: default; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 700px; }
    th, td { text-align: left; padding: 7px 10px; font-size: 13px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 600; white-space: nowrap; }
    td { color: #c9d1d9; }
    .filename-link { color: #58a6ff; cursor: pointer; text-decoration: underline; }
    .filename-link:hover { color: #79c0ff; }
    .expiring { color: #f85149 !important; font-weight: 600; }
    .btn-sm { padding: 3px 8px; border: none; border-radius: 3px; color: #fff; font-size: 11px; cursor: pointer; margin-right: 2px; }
    .btn-sm:hover { opacity: 0.85; }
    .btn-copy-sm { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; }
    .btn-share-sm { background: #1f6feb; }
    .btn-extend-sm { background: #9e6a03; }
    .btn-delete-sm { background: #da3633; }
    .empty { text-align: center; padding: 40px; color: #8b949e; font-size: 14px; }
    .pagination { display: flex; justify-content: center; gap: 8px; margin: 12px 0; }
    .pagination button { padding: 5px 14px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
    .pagination button:hover { background: #30363d; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; max-width: 520px; width: 90%; max-height: 90vh; overflow-y: auto; }
    .modal h3 { font-size: 16px; color: #f0f6fc; margin-bottom: 16px; }
    .modal dl { display: grid; grid-template-columns: 90px 1fr; gap: 8px 12px; font-size: 13px; }
    .modal dt { color: #8b949e; text-align: right; }
    .modal dd { color: #c9d1d9; word-break: break-all; }
    .modal .modal-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .modal .btn { padding: 6px 14px; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; }
    .modal .btn-primary { background: #238636; color: #fff; }
    .modal .btn-secondary { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; }
    .preview-img { max-width: 100%; max-height: 300px; display: block; margin: 12px auto; border-radius: 4px; }
    .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toast-container { position: fixed; bottom: 16px; right: 16px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
    .toast { padding: 10px 16px; border-radius: 6px; font-size: 13px; color: #fff; min-width: 200px; max-width: 360px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); animation: slideIn 0.25s ease; }
    .toast-success { background: #238636; }
    .toast-error { background: #da3633; }
    .toast-info { background: #1f6feb; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @media (max-width: 768px) {
      .header { padding: 10px 16px; }
      .header h1 { font-size: 14px; }
      .toolbar { padding: 12px 16px; }
      .stats { padding: 0 16px 12px; gap: 8px; }
      .stat-card { min-width: 100px; padding: 10px 12px; }
      .stat-card .value { font-size: 15px; }
      .upload-area { margin: 0 16px 12px; padding: 14px; }
      .file-list { margin: 0 16px; }
      th, td { padding: 5px 8px; font-size: 12px; }
      .btn-sm { padding: 3px 6px; font-size: 10px; }
      .modal { padding: 16px; }
    }
    @media (max-width: 480px) {
      .header-links { width: 100%; justify-content: flex-end; }
      .upload-area { text-align: left; }
      .upload-area input[type=file] { width: 100%; }
      .btn-upload { margin-left: 0; margin-top: 6px; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>파일 서버 관리자</h1>
    <div class="header-links">
      <button class="btn-refresh" onclick="refresh()">새로고침</button>
      <a href="/api/docs">API 문서</a>
      <a href="/admin/logout">로그아웃</a>
    </div>
  </div>
  <div class="toolbar">
    <input class="search-box" id="searchBox" type="text" placeholder="파일명 검색..." oninput="applyFilter()" />
    <select class="page-size-select" id="pageSizeSelect" onchange="changePageSize()">
      <option value="20">20개</option>
      <option value="50">50개</option>
      <option value="100">100개</option>
    </select>
  </div>
  <div class="upload-area" id="uploadArea">
    <span>파일을 여기에 끌어다 놓거나 클릭하여 선택하세요 (여러 파일 가능)</span>
    <input type="file" id="uploadFileInput" multiple />
    <button class="btn-upload" id="uploadBtn" onclick="uploadFiles()">업로드</button>
    <div class="upload-progress" id="uploadProgress"></div>
  </div>
  <div class="stats">
    <div class="stat-card">
      <div class="label">전체 파일</div>
      <div class="value" id="totalFileCount">-</div>
      <div class="sub" id="expiringCount"></div>
    </div>
    <div class="stat-card">
      <div class="label">전체 용량</div>
      <div class="value" id="totalStorageSize">-</div>
      <div class="sub" id="avgSize"></div>
    </div>
    <div class="stat-card">
      <div class="label">페이지 파일</div>
      <div class="value" id="fileCount">-</div>
    </div>
    <div class="stat-card">
      <div class="label">페이지 용량</div>
      <div class="value" id="totalSize">-</div>
    </div>
  </div>
  <div class="file-list">
    <div class="table-header-row">
      <h3>파일 목록</h3>
      <div class="action-bar">
        <button class="btn-danger" id="deleteSelectedBtn" disabled onclick="deleteSelected()">선택 삭제</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="selectAll" onchange="toggleSelectAll()" /></th>
            <th>파일명</th>
            <th>크기</th>
            <th>업로드</th>
            <th>만료</th>
            <th>작업</th>
          </tr>
        </thead>
        <tbody id="fileTableBody">
          <tr><td colspan="6" class="empty"><span class="spinner"></span>불러오는 중...</td></tr>
        </tbody>
      </table>
    </div>
    <div class="pagination" id="pagination"></div>
  </div>
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <h3>파일 상세 정보</h3>
      <div id="previewContainer"></div>
      <dl>
        <dt>파일 ID</dt><dd id="modalId">-</dd>
        <dt>파일명</dt><dd id="modalName">-</dd>
        <dt>MIME 타입</dt><dd id="modalType">-</dd>
        <dt>파일 크기</dt><dd id="modalSize">-</dd>
        <dt>업로드 시간</dt><dd id="modalUploaded">-</dd>
        <dt>만료 예정</dt><dd id="modalExpire">-</dd>
      </dl>
      <div class="modal-actions">
        <button class="btn btn-primary" id="modalCopyBtn">URL 복사</button>
        <button class="btn btn-secondary" onclick="closeModal()">닫기</button>
      </div>
    </div>
  </div>
  <div class="toast-container" id="toastContainer"></div>
  <script>
    var ADMIN_TOKEN = ${JSON.stringify(token)};
    var cursor = null;
    var prevCursors = [];
    var allItems = [];
    var statsCache = null;

    function formatSize(bytes) {
      if (bytes == null) return '-';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatTime(iso) {
      if (!iso) return '-';
      return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    }

    function isExpiringSoon(expireAt) {
      if (!expireAt) return false;
      return new Date(expireAt).getTime() - Date.now() < 3600000;
    }

    function showToast(msg, type) {
      type = type || 'info';
      var container = document.getElementById('toastContainer');
      var el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.textContent = msg;
      container.appendChild(el);
      setTimeout(function() { el.remove(); }, 3000);
    }

    async function api(path, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      opts.headers['Authorization'] = 'Bearer ' + ADMIN_TOKEN;
      opts.credentials = 'same-origin';
      return fetch(path, opts);
    }

    function getPageLimit() {
      return parseInt(document.getElementById('pageSizeSelect').value, 10) || 20;
    }

    async function loadStats() {
      try {
        var res = await api('/api/stats');
        var data = await res.json();
        if (data.success && data.data) {
          statsCache = data.data;
          document.getElementById('totalFileCount').textContent = data.data.totalFiles;
          document.getElementById('totalStorageSize').textContent = formatSize(data.data.totalSize);
          document.getElementById('avgSize').textContent = '평균 ' + formatSize(data.data.averageSize);
          if (data.data.expiringSoon > 0) {
            document.getElementById('expiringCount').textContent = data.data.expiringSoon + '개 1시간 이내 만료';
            document.getElementById('expiringCount').style.color = '#f85149';
          } else {
            document.getElementById('expiringCount').textContent = '';
          }
        }
      } catch (e) {}
    }

    async function loadFiles(c) {
      var limit = getPageLimit();
      var url = '/api/files?limit=' + limit;
      if (c) url += '&cursor=' + encodeURIComponent(c);
      var tbody = document.getElementById('fileTableBody');
      document.getElementById('selectAll').checked = false;
      document.getElementById('deleteSelectedBtn').disabled = true;
      try {
        var res = await api(url);
        var data = await res.json();
        if (!data.success) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty">오류: ' + esc(JSON.stringify(data.error || '')) + '</td></tr>';
          return;
        }
        if (!data.data) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty">데이터 없음</td></tr>';
          return;
        }
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">요청 실패: ' + esc(e.message || '') + '</td></tr>';
        return;
      }

      allItems = data.data.items.slice();
      renderTable(allItems);

      cursor = data.data.cursor;
      var pagDiv = document.getElementById('pagination');
      var html = '';
      if (prevCursors.length > 0) html += '<button onclick="goBack()">이전</button>';
      if (data.data.hasMore) html += '<button onclick="goNext()">다음</button>';
      pagDiv.innerHTML = html;
    }

    function renderTable(items) {
      var tbody = document.getElementById('fileTableBody');
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">파일이 없습니다.</td></tr>';
        document.getElementById('fileCount').textContent = '0';
        document.getElementById('totalSize').textContent = '0 B';
        return;
      }
      var totalSize = 0;
      var rows = items.map(function(f) {
        totalSize += f.size;
        var safeName = JSON.stringify(f.originalFilename).replace(/'/g, '&#39;');
        var safeId = JSON.stringify(f.id).replace(/'/g, '&#39;');
        var expClass = isExpiringSoon(f.expireAt) ? ' class="expiring"' : '';
        return '<tr>' +
          '<td><input type="checkbox" class="row-checkbox" value="' + esc(f.id) + '" onchange="updateDeleteBtn()" /></td>' +
          '<td><span class="filename-link" onclick=\\'showFileInfo(' + safeId + ')\\'">' + esc(f.originalFilename) + '</span></td>' +
          '<td>' + formatSize(f.size) + '</td>' +
          '<td>' + formatTime(f.uploadedAt) + '</td>' +
          '<td' + expClass + '>' + formatTime(f.expireAt) + '</td>' +
          '<td>' +
            '<button class="btn-sm btn-copy-sm" onclick=\\'copyUrl(' + safeId + ', ' + safeName + ')\\'" title="URL 복사">URL</button>' +
            '<button class="btn-sm btn-share-sm" onclick=\\'shareFile(' + safeId + ')\\'" title="공유 링크">공유</button>' +
            '<button class="btn-sm btn-extend-sm" onclick=\\'extendFile(' + safeId + ')\\'" title="만료 연장">연장</button>' +
            '<button class="btn-sm btn-delete-sm" onclick=\\'deleteFile(' + safeId + ')\\'" title="삭제">삭제</button>' +
          '</td>' +
        '</tr>';
      }).join('');
      tbody.innerHTML = rows;
      document.getElementById('fileCount').textContent = items.length;
      document.getElementById('totalSize').textContent = formatSize(totalSize);
    }

    function applyFilter() {
      var q = document.getElementById('searchBox').value.toLowerCase();
      var filtered = q ? allItems.filter(function(f) { return f.originalFilename.toLowerCase().indexOf(q) !== -1; }) : allItems;
      renderTable(filtered);
    }

    function toggleSelectAll() {
      var checked = document.getElementById('selectAll').checked;
      var boxes = document.querySelectorAll('.row-checkbox');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
      updateDeleteBtn();
    }

    function updateDeleteBtn() {
      var any = document.querySelectorAll('.row-checkbox:checked').length > 0;
      document.getElementById('deleteSelectedBtn').disabled = !any;
    }

    async function deleteSelected() {
      var boxes = document.querySelectorAll('.row-checkbox:checked');
      if (!boxes.length) return;
      if (!confirm(boxes.length + '개 파일을 삭제하시겠습니까?')) return;
      var btn = document.getElementById('deleteSelectedBtn');
      btn.disabled = true;
      btn.textContent = '삭제 중...';
      var errors = 0;
      for (var i = 0; i < boxes.length; i++) {
        var res = await api('/api/files/' + boxes[i].value, { method: 'DELETE' });
        var data = await res.json();
        if (!data.success) errors++;
      }
      btn.textContent = '선택 삭제';
      if (errors) showToast(errors + '개 파일 삭제 실패', 'error');
      else showToast('삭제 완료', 'success');
      refresh();
    }

    var CHUNK_SIZE = 50 * 1024 * 1024;

    function formatUploadProgress(uploaded, total) {
      if (total < 1048576) return formatSize(uploaded) + ' / ' + formatSize(total);
      return (uploaded / 1048576).toFixed(1) + 'MB / ' + (total / 1048576).toFixed(1) + 'MB';
    }

    async function uploadChunked(file) {
      console.log('[upload] 청크 업로드 시작:', file.name, formatSize(file.size));
      var initRes = await api('/api/files/chunked/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, totalSize: file.size, contentType: file.type }),
      });
      console.log('[upload] init 응답:', initRes.status, initRes.statusText);
      var initData = await initRes.json();
      console.log('[upload] init 데이터:', JSON.stringify(initData));
      if (!initData.success) throw new Error(initData.error && initData.error.message || '초기화 실패');
      var uploadId = initData.data.uploadId;
      var fileId = initData.data.fileId;
      console.log('[upload] uploadId:', uploadId, 'fileId:', fileId);
      var totalParts = Math.ceil(file.size / CHUNK_SIZE);
      console.log('[upload] 총 청크 수:', totalParts);
      var uploadedBytes = 0;
      for (var p = 0; p < totalParts; p++) {
        var start = p * CHUNK_SIZE;
        var end = Math.min(start + CHUNK_SIZE, file.size);
        var chunk = file.slice(start, end);
        var chunkSize = end - start;
        var partUrl = '/api/files/chunked/' + uploadId + '/part?partNumber=' + (p + 1) + '&fileId=' + fileId;
        console.log('[upload] 청크 ' + (p + 1) + '/' + totalParts, '크기:', formatSize(chunkSize));
        var partRes = await api(partUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
        });
        console.log('[upload] 청크 ' + (p + 1) + ' 응답:', partRes.status, partRes.statusText);
        var partData = await partRes.json();
        console.log('[upload] 청크 ' + (p + 1) + ' 데이터:', JSON.stringify(partData));
        if (!partData.success) throw new Error('청크 업로드 실패 (part ' + (p + 1) + '): ' + (partData.error && partData.error.message || ''));
        uploadedBytes += chunkSize;
        var progEl = document.getElementById('uploadProgress');
        progEl.innerHTML = '<span class="spinner"></span>' + formatUploadProgress(uploadedBytes, file.size);
      }
      console.log('[upload] complete 요청...');
      var compRes = await api('/api/files/chunked/' + uploadId + '/complete?fileId=' + fileId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log('[upload] complete 응답:', compRes.status, compRes.statusText);
      var compData = await compRes.json();
      console.log('[upload] complete 데이터:', JSON.stringify(compData));
      if (!compData.success) throw new Error('완료 실패: ' + (compData.error && compData.error.message || ''));
      console.log('[upload] 청크 업로드 완료:', file.name);
    }

    async function uploadOneFile(file, idx, total) {
      console.log('[upload] 파일 ' + idx + '/' + total + ':', file.name, formatSize(file.size), 'type:', file.type);
      if (file.size > CHUNK_SIZE) {
        console.log('[upload] ' + formatSize(file.size) + ' > ' + formatSize(CHUNK_SIZE) + ' → 청크 업로드 사용');
        return uploadChunked(file);
      }
      console.log('[upload] 일반 업로드 사용');
      var form = new FormData();
      form.append('file', file);
      var res = await api('/api/files', { method: 'POST', body: form });
      console.log('[upload] 응답:', res.status, res.statusText);
      var data = await res.json();
      console.log('[upload] 데이터:', JSON.stringify(data));
      if (!data.success) throw new Error(data.error && data.error.message || '업로드 실패');
      console.log('[upload] 완료:', data.data && data.data.id);
    }

    async function uploadFiles() {
      var input = document.getElementById('uploadFileInput');
      var files = input.files;
      console.log('[upload] 시작: 파일 ' + files.length + '개');
      if (!files.length) { showToast('파일을 선택하세요.', 'error'); return; }
      var btn = document.getElementById('uploadBtn');
      var progress = document.getElementById('uploadProgress');
      btn.disabled = true;
      var total = files.length;
      var successCount = 0;
      var failCount = 0;
      for (var i = 0; i < total; i++) {
        progress.innerHTML = '<span class="spinner"></span>업로드 중... (' + (i + 1) + '/' + total + ')';
        try {
          await uploadOneFile(files[i], i + 1, total);
          successCount++;
        } catch (e) {
          console.error('[upload] 실패:', e.message || e);
          showToast((i + 1) + '번 파일 실패: ' + (e.message || '오류'), 'error');
          failCount++;
        }
      }
      btn.disabled = false;
      progress.textContent = '';
      input.value = '';
      console.log('[upload] 완료: ' + successCount + ' 성공, ' + failCount + ' 실패');
      if (failCount === 0) showToast(successCount + '개 파일 업로드 완료', 'success');
      else showToast(successCount + '개 성공, ' + failCount + '개 실패', failCount === total ? 'error' : 'info');
      refresh();
    }

    function refresh() {
      cursor = null;
      prevCursors = [];
      loadFiles(null);
      loadStats();
    }

    function changePageSize() {
      refresh();
    }

    function esc(s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function goNext() {
      if (cursor) { prevCursors.push(cursor); loadFiles(cursor); }
    }

    function goBack() {
      var prev = prevCursors.pop();
      loadFiles(prev || null);
    }

    async function deleteFile(id) {
      if (!confirm('삭제하시겠습니까?')) return;
      var res = await api('/api/files/' + id, { method: 'DELETE' });
      var data = await res.json();
      if (data.success) { showToast('삭제 완료', 'success'); refresh(); }
      else { showToast('실패: ' + (data.error && data.error.message || '오류'), 'error'); }
    }

    function copyUrl(id, name) {
      var url = 'https://file.kalpha.kr/api/files/' + id;
      navigator.clipboard.writeText(url).then(function() {
        showToast('URL 복사됨: ' + name, 'success');
      }).catch(function() {
        prompt('URL 복사:', url);
      });
    }

    async function shareFile(id) {
      var hours = prompt('공유 링크 유효 시간 (시간, 기본 1시간):', '1');
      if (!hours) return;
      try {
        var res = await api('/api/files/' + id + '/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiryHours: parseInt(hours, 10) || 1 }),
        });
        var data = await res.json();
        if (data.success && data.data) {
          navigator.clipboard.writeText(data.data.url).then(function() {
            showToast('공유 링크 복사됨 (유효: ' + hours + '시간)', 'success');
          }).catch(function() {
            prompt('공유 링크:', data.data.url);
          });
        } else {
          showToast('공유 링크 생성 실패', 'error');
        }
      } catch (e) {
        showToast('공유 링크 생성 실패', 'error');
      }
    }

    async function extendFile(id) {
      var hours = prompt('연장할 시간 (최대 168시간):', '24');
      if (!hours) return;
      try {
        var res = await api('/api/files/' + id + '/extend', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hours: parseInt(hours, 10) || 24 }),
        });
        var data = await res.json();
        if (data.success) { showToast('만료 시간 ' + hours + '시간 연장됨', 'success'); refresh(); }
        else { showToast('연장 실패: ' + (data.error && data.error.message || '오류'), 'error'); }
      } catch (e) {
        showToast('연장 실패', 'error');
      }
    }

    var currentFileId = null;

    async function showFileInfo(id) {
      currentFileId = id;
      document.getElementById('modalOverlay').classList.add('show');
      document.getElementById('modalId').textContent = id;
      document.getElementById('modalName').textContent = '<span class="spinner"></span>불러오는 중...';
      document.getElementById('modalType').textContent = '-';
      document.getElementById('modalSize').textContent = '-';
      document.getElementById('modalUploaded').textContent = '-';
      document.getElementById('modalExpire').textContent = '-';
      document.getElementById('previewContainer').innerHTML = '';
      try {
        var res = await api('/api/files/' + id + '/info');
        var data = await res.json();
        if (data.success && data.data) {
          var m = data.data;
          document.getElementById('modalName').textContent = m.originalFilename;
          document.getElementById('modalType').textContent = m.contentType || 'application/octet-stream';
          document.getElementById('modalSize').textContent = formatSize(m.size);
          document.getElementById('modalUploaded').textContent = formatTime(m.uploadedAt);
          document.getElementById('modalExpire').textContent = formatTime(m.expireAt);
          if (isExpiringSoon(m.expireAt)) document.getElementById('modalExpire').className = 'expiring';
          else document.getElementById('modalExpire').className = '';
          if (m.contentType && m.contentType.indexOf('image/') === 0) {
            var img = document.createElement('img');
            img.className = 'preview-img';
            img.src = '/api/files/' + id;
            img.onerror = function() { img.style.display = 'none'; };
            document.getElementById('previewContainer').appendChild(img);
          }
        } else {
          document.getElementById('modalName').textContent = '오류';
        }
      } catch (e) {
        document.getElementById('modalName').textContent = '실패';
      }
    }

    function closeModal() {
      document.getElementById('modalOverlay').classList.remove('show');
    }

    document.getElementById('modalCopyBtn').addEventListener('click', function() {
      if (currentFileId) copyUrl(currentFileId, document.getElementById('modalName').textContent);
    });

    document.getElementById('modalOverlay').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });

    var uploadArea = document.getElementById('uploadArea');
    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.add('drag-over');
    });
    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
    });
    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        document.getElementById('uploadFileInput').files = dt.files;
        uploadFiles();
      }
    });

    loadFiles(null);
    loadStats();
  </script>
</body>
</html>`

app.get('/admin', adminPageAuth(), (c) => {
  const token = c.get('adminToken')
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Permissions-Policy', 'interest-cohort=()')
  return c.html(dashboardHTML(token))
})

export default app
