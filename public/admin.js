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
      setInterval(loadState, 1000); // Refresh every 1s
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
        <button onclick="removeGame('${appId}')">Remove</button>
        <button class="danger" onclick="deleteGame('${appId}')">Reject</button>
      </td>
    `;
    gamesBody.appendChild(row);
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

  // Rejected Games (shown in a separate section)
  const rejectedGames = state.rejected || {};
  if (Object.keys(rejectedGames).length > 0) {
    // We'll add them to the banned table for now, or you can create a new table
    Object.keys(rejectedGames).forEach(appId => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>Game: ${appId}</td>
        <td>
          <button onclick="unRejectGame('${appId}')">Add to Games</button>
        </td>
      `;
      bannedBody.appendChild(row);
    });
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

async function deleteGame(appId) {
  if (!confirm(`Reject game ${appId}? This will block it and remove from games list.`)) return;

  // First remove from games
  await fetch('/api/admin/removegame', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });

  // Then add to rejected list
  await fetch('/api/admin/reject', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });

  loadState();
}

async function removeGame(appId) {
  if (!confirm(`Remove game ${appId} from database?`)) return;
  await fetch('/api/admin/removegame', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}

async function unRejectGame(appId) {
  if (!confirm(`Add game ${appId} back to games?`)) return;

  // Remove from rejected list
  await fetch('/api/admin/unreject', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });

  loadState();
}
