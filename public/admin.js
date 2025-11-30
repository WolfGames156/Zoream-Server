let adminPass = localStorage.getItem('zoream_admin_pass') || '';

async function attemptLogin() {
  const input = document.getElementById('admin-pass');
  const pass = input.value;

  try {
    const res = await fetch('/api/admin/state', {
      headers: { 'x-admin-pass': pass }
    });

    if (res.ok) {
      adminPass = pass;
      localStorage.setItem('zoream_admin_pass', pass);
      document.getElementById('login-overlay').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      loadState();
    } else {
      document.getElementById('login-error').style.display = 'block';
    }
  } catch (e) {
    console.error(e);
    document.getElementById('login-error').innerText = 'Connection Error';
    document.getElementById('login-error').style.display = 'block';
  }
}

function logout() {
  localStorage.removeItem('zoream_admin_pass');
  location.reload();
}

if (adminPass) {
  document.getElementById('admin-pass').value = adminPass;
  attemptLogin();
}

async function loadState() {
  try {
    const res = await fetch('/api/admin/state', {
      headers: { 'x-admin-pass': adminPass }
    });
    if (!res.ok) {
      if (res.status === 401) logout();
      return;
    }
    const data = await res.json();
    if (data.ok) {
      render(data.state);
    }
  } catch (e) {
    console.error(e);
  }
}

function render(state) {
  const { active, games, banned, rejected, seen } = state;

  // Show counts excluding banned IPs
  const activeKeys = Object.keys(active || {}).filter(ip => !banned[ip]);
  document.getElementById('active-count').innerText = activeKeys.length;
  document.getElementById('games-count').innerText = Object.keys(games).length;
  document.getElementById('banned-count').innerText = Object.keys(banned).length;

  // Active Users
  const usersBody = document.querySelector('#users-table tbody');
  usersBody.innerHTML = '';
  Object.entries(active).forEach(([ip, data]) => {
    if (banned && banned[ip]) return; // hide banned IPs from active list
    const row = document.createElement('tr');
    const lastSeen = new Date(data.lastSeen).toLocaleTimeString();
    row.innerHTML = `
      <td>${ip}</td>
      <td>${data.lastUsername || '-'} </td>
      <td>${lastSeen}</td>
      <td>
        <button class="danger" onclick="banIp('${ip}')">Ban</button>
      </td>
    `;
    usersBody.appendChild(row);
  });

  // Games list
  const gamesBody = document.querySelector('#games-table tbody');
  gamesBody.innerHTML = '';
  Object.entries(games).forEach(([appId, info]) => {
    const row = document.createElement('tr');
    const status = info.added ? 'active' : 'inactive';
    // If inactive: show Add and Reject. If active: show Reject only.
    let actions = '';
    if (!info.added) {
      actions = `
        <button onclick="showAddGameConfirm('${appId}')">Add</button>
        <button onclick="rejectGame('${appId}')">Reject</button>
      `;
    } else {
      actions = `<button onclick="rejectGame('${appId}')">Reject</button>`;
    }
    const modeLabel = (info.mode === 1) ? 'Online bypass' : 'lua manifest';
    row.innerHTML = `
      <td>${appId}</td>
      <td>${modeLabel}</td>
      <td><span class="badge ${info.added ? 'status-active' : 'status-inactive'}">${info.added ? 'active' : 'inactive'}</span></td>
      <td>${actions}</td>
    `;
    gamesBody.appendChild(row);
  });

  // Rejected list
  const rejectedBody = document.querySelector('#rejected-table tbody');
  rejectedBody.innerHTML = '';
  Object.keys(rejected || {}).forEach(appId => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${appId}</td>
      <td>
        <button onclick="unRejectGame('${appId}')">Remove</button>
      </td>
    `;
    rejectedBody.appendChild(row);
  });

  // Banned IPs
  const bannedBody = document.querySelector('#banned-table tbody');
  bannedBody.innerHTML = '';
  Object.keys(banned).forEach(ip => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${ip}</td>
      <td>
        <button onclick="unbanIp('${ip}')">Unban</button>
      </td>
    `;
    bannedBody.appendChild(row);
  });

  // Seen IPs - full history
  if (seen) {
    const seenBody = document.querySelector('#seen-table tbody');
    if (seenBody) {
      seenBody.innerHTML = '';
      Object.entries(seen).forEach(([ip, info]) => {
        if (banned && banned[ip]) return; // hide banned IPs from seen/history list
        const row = document.createElement('tr');
        const usernames = info.usernames ? Object.keys(info.usernames).join(', ') : '-';
        const firstSeen = info.firstSeen ? new Date(info.firstSeen).toLocaleString() : '-';
        row.innerHTML = `
          <td>${ip}</td>
          <td>${usernames}</td>
          <td>${firstSeen}</td>
          <td><button class="danger" onclick="banIp('${ip}')">Ban</button></td>
        `;
        seenBody.appendChild(row);
      });
    }
  }
}

async function banIp(ip) {
  if (!confirm(`Ban IP ${ip}?`)) return;
  await fetch('/api/admin/ban', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip })
  });
  loadState();
}

async function unbanIp(ip) {
  await fetch('/api/admin/unban', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip })
  });
  loadState();
}

async function rejectGame(appId) {
  if (!confirm(`Reject game ${appId}?`)) return;
  await fetch('/api/admin/rejectgame', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}

async function unRejectGame(appId) {
  if (!confirm(`Remove ${appId} from rejected?`)) return;
  await fetch('/api/admin/unreject', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}

function showAddGameDialog() {
  const appId = prompt('Enter Steam App ID:');
  if (!appId) return;
  // Do not ask for mode here; activating/adding will preserve existing mode or use default
  addGame(appId);
}

function showAddGameConfirm(appId) {
  // Confirm activation for an existing appId; do not ask mode
  if (!confirm(`Add game ${appId} as active?`)) return;
  addGame(appId);
}

async function addGame(appId, mode) {
  // Send only appId; don't force mode on server (it will preserve existing mode)
  await fetch('/api/admin/addgame', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}
