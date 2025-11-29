let adminPass = localStorage.getItem('zoream_admin_pass') || '';

async function attemptLogin() {
  const input = document.getElementById('admin-pass');
  const pass = input.value;

  // Verify pass by trying to fetch state
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
      setInterval(loadState, 5000); // Refresh every 5s
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

// Auto-login if pass exists
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
  const { active, games, banned } = state;

  // Stats
  document.getElementById('active-count').innerText = Object.keys(active).length;
  document.getElementById('games-count').innerText = Object.keys(games).length;
  document.getElementById('banned-count').innerText = Object.keys(banned).length;

  // Active Users
  const usersBody = document.querySelector('#users-table tbody');
  usersBody.innerHTML = '';
  Object.entries(active).forEach(([ip, data]) => {
    const row = document.createElement('tr');
    const lastSeen = new Date(data.lastSeen).toLocaleTimeString();
    row.innerHTML = `
      <td>${ip}</td>
      <td>${lastSeen}</td>
      <td>
        <button class="danger" onclick="banIp('${ip}')">Ban</button>
      </td>
    `;
    usersBody.appendChild(row);
  });

  // Games
  const gamesBody = document.querySelector('#games-table tbody');
  gamesBody.innerHTML = '';
  Object.entries(games).forEach(([appId, data]) => {
    const row = document.createElement('tr');
    const status = data.added ? '<span class="badge success">Active</span>' : '<span class="badge warning">Pending</span>';
    row.innerHTML = `
      <td>${appId}</td>
      <td>${data.mode === 1 ? 'Online Bypass' : 'Lua Manifest'}</td>
      <td>${status}</td>
      <td>
        <button class="danger" onclick="deleteGame('${appId}')">Reject</button>
      </td>
    `;
    gamesBody.appendChild(row);
  });

  // Banned
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

async function deleteGame(appId) {
  if (!confirm(`Reject game ${appId}? This will block it.`)) return;
  await fetch('/api/admin/reject', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}
