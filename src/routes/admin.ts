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
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
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
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .header h1 { font-size: 16px; color: #f0f6fc; white-space: nowrap; }
    .header-links { display: flex; align-items: center; gap: 10px; }
    .header a { color: #58a6ff; text-decoration: none; font-size: 13px; }
    .header a:hover { text-decoration: underline; }
    .btn-refresh { padding: 5px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 12px; cursor: pointer; }
    .btn-refresh:hover { background: #30363d; }
    .toolbar { padding: 12px 24px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .search-box { flex: 1; min-width: 200px; max-width: 360px; padding: 7px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; outline: none; }
    .search-box:focus { border-color: #58a6ff; }
    .page-size-select { padding: 6px 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
    .stats { padding: 0 24px 12px; display: flex; gap: 12px; flex-wrap: wrap; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; min-width: 140px; }
    .stat-card .label { font-size: 11px; color: #8b949e; margin-bottom: 2px; }
    .stat-card .value { font-size: 18px; color: #f0f6fc; font-weight: 600; }
    .upload-area { margin: 0 24px 12px; padding: 16px; background: #161b22; border: 1px dashed #30363d; border-radius: 6px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .upload-area span { font-size: 13px; color: #8b949e; white-space: nowrap; }
    .upload-area input[type=file] { color: #c9d1d9; font-size: 13px; flex: 1; min-width: 200px; }
    .upload-area input[type=file]::file-selector-button { padding: 5px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; cursor: pointer; margin-right: 8px; }
    .btn-upload { padding: 6px 14px; background: #238636; border: none; border-radius: 4px; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn-upload:hover { background: #2ea043; }
    .btn-upload:disabled { opacity: 0.4; cursor: default; }
    .upload-progress { font-size: 12px; color: #8b949e; }
    .file-list { margin: 0 24px; }
    .table-header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    h3 { font-size: 14px; color: #f0f6fc; }
    .action-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .btn-danger { padding: 5px 12px; background: #da3633; border: none; border-radius: 4px; color: #fff; font-size: 12px; cursor: pointer; }
    .btn-danger:hover { background: #f85149; }
    .btn-danger:disabled { opacity: 0.4; cursor: default; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 7px 10px; font-size: 13px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 600; white-space: nowrap; }
    td { color: #c9d1d9; }
    .filename-link { color: #58a6ff; cursor: pointer; text-decoration: underline; }
    .filename-link:hover { color: #79c0ff; }
    .expiring { color: #f85149 !important; font-weight: 600; }
    .btn-delete { padding: 4px 10px; background: #da3633; border: none; border-radius: 4px; color: #fff; font-size: 12px; cursor: pointer; }
    .btn-delete:hover { background: #f85149; }
    .btn-copy { padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 12px; cursor: pointer; margin-right: 4px; }
    .btn-copy:hover { background: #30363d; }
    .empty { text-align: center; padding: 40px; color: #8b949e; font-size: 14px; }
    .pagination { display: flex; justify-content: center; gap: 8px; margin: 12px 0; }
    .pagination button { padding: 5px 14px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 13px; cursor: pointer; }
    .pagination button:hover { background: #30363d; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; max-width: 480px; width: 90%; }
    .modal h3 { font-size: 16px; color: #f0f6fc; margin-bottom: 16px; }
    .modal dl { display: grid; grid-template-columns: 100px 1fr; gap: 8px 12px; font-size: 13px; }
    .modal dt { color: #8b949e; text-align: right; }
    .modal dd { color: #c9d1d9; word-break: break-all; }
    .modal .modal-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
    .modal .btn { padding: 6px 14px; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; }
    .modal .btn-primary { background: #238636; color: #fff; }
    .modal .btn-secondary { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; }
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
  <div class="upload-area">
    <span>파일 업로드:</span>
    <input type="file" id="uploadFileInput" />
    <button class="btn-upload" id="uploadBtn" onclick="uploadFile()">업로드</button>
    <span class="upload-progress" id="uploadProgress"></span>
  </div>
  <div class="stats">
    <div class="stat-card">
      <div class="label">현재 페이지 파일</div>
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
    <table>
      <thead>
        <tr>
          <th><input type="checkbox" id="selectAll" onchange="toggleSelectAll()" /></th>
          <th>파일명</th>
          <th>크기</th>
          <th>업로드</th>
          <th>만료</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="fileTableBody">
        <tr><td colspan="6" class="empty">불러오는 중...</td></tr>
      </tbody>
    </table>
    <div class="pagination" id="pagination"></div>
  </div>
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <h3>파일 상세 정보</h3>
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
  <script>
    var ADMIN_TOKEN = ${JSON.stringify(token)};
    var cursor = null;
    var prevCursors = [];
    var allItems = [];

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

    function isExpiringSoon(expireAt) {
      if (!expireAt) return false;
      return new Date(expireAt).getTime() - Date.now() < 3600000;
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
            '<button class="btn-copy" onclick=\\'copyUrl(' + safeId + ', ' + safeName + ')\\'">복사</button>' +
            '<button class="btn-delete" onclick=\\'deleteFile(' + safeId + ')\\'">삭제</button>' +
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
      if (errors) alert(errors + '개 파일 삭제 실패');
      refresh();
    }

    async function uploadFile() {
      var input = document.getElementById('uploadFileInput');
      var file = input.files[0];
      if (!file) { alert('파일을 선택하세요.'); return; }
      var btn = document.getElementById('uploadBtn');
      var progress = document.getElementById('uploadProgress');
      btn.disabled = true;
      progress.textContent = '업로드 중...';
      try {
        var form = new FormData();
        form.append('file', file);
        var res = await api('/api/files', { method: 'POST', body: form });
        var data = await res.json();
        if (data.success) {
          progress.textContent = '업로드 완료: ' + file.name;
          input.value = '';
          refresh();
        } else {
          progress.textContent = '실패: ' + (data.error && data.error.message || '');
        }
      } catch (e) {
        progress.textContent = '업로드 오류';
      }
      btn.disabled = false;
    }

    function refresh() {
      cursor = null;
      prevCursors = [];
      loadFiles(null);
    }

    function changePageSize() {
      refresh();
    }

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
      if (data.success) { refresh(); }
      else { alert('실패: ' + (data.error && data.error.message || '오류')); }
    }

    function copyUrl(id, name) {
      var url = 'https://file.kalpha.kr/api/files/' + id;
      navigator.clipboard.writeText(url).then(function() {
        alert('URL 복사됨\\n' + name);
      }).catch(function() {
        prompt('URL 복사:', url);
      });
    }

    var currentFileId = null;

    async function showFileInfo(id) {
      currentFileId = id;
      document.getElementById('modalOverlay').classList.add('show');
      document.getElementById('modalId').textContent = id;
      document.getElementById('modalName').textContent = '불러오는 중...';
      document.getElementById('modalType').textContent = '-';
      document.getElementById('modalSize').textContent = '-';
      document.getElementById('modalUploaded').textContent = '-';
      document.getElementById('modalExpire').textContent = '-';
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

    loadFiles(null);
  </script>
</body>
</html>`

app.get('/admin', adminPageAuth(), (c) => {
  const token = c.get('adminToken')
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  return c.html(dashboardHTML(token))
})

export default app
