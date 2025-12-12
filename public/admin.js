let adminPass = localStorage.getItem('zoream_admin_pass') || '';

// Collapse state management
const collapseSections = ['active-users', 'game-library', 'rejected-games', 'seen-ips', 'banned-ips'];
let collapseState = {};

function loadCollapseState() {
  const saved = localStorage.getItem('zoream_collapse_state');
  if (saved) {
    try {
      collapseState = JSON.parse(saved);
    } catch (e) {
      collapseState = {};
    }
  }
  // Apply saved state
  collapseSections.forEach(section => {
    if (collapseState[section] === true) {
      const content = document.getElementById(`content-${section}`);
      const arrow = document.getElementById(`toggle-${section}`);
      if (content) content.classList.add('collapsed');
      if (arrow) arrow.textContent = '▶';
    }
  });
}

function saveCollapseState() {
  localStorage.setItem('zoream_collapse_state', JSON.stringify(collapseState));
}

function toggleSection(section) {
  const content = document.getElementById(`content-${section}`);
  const arrow = document.getElementById(`toggle-${section}`);

  if (!content || !arrow) return;

  const isCollapsed = content.classList.contains('collapsed');

  if (isCollapsed) {
    content.classList.remove('collapsed');
    arrow.textContent = '▼';
    collapseState[section] = false;
  } else {
    content.classList.add('collapsed');
    arrow.textContent = '▶';
    collapseState[section] = true;
  }

  saveCollapseState();
}

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

// Load collapse state on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadCollapseState);
} else {
  loadCollapseState();
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
  const { active, games, banned, rejected, seen, names, redisInfo } = state;

  // Process User Activity Grouping
  const userMap = {}; // username -> { ips: Set, firstSeen: Infinity }
  const anonIps = []; // items with no username

  if (seen) {
    Object.entries(seen).forEach(([ip, info]) => {
      if (banned && banned[ip]) return;

      const userList = info.usernames ? Object.keys(info.usernames) : [];
      if (userList.length > 0) {
        userList.forEach(u => {
          if (!userMap[u]) userMap[u] = { ips: new Set(), firstSeen: Infinity };
          userMap[u].ips.add(ip);
          if (info.firstSeen && info.firstSeen < userMap[u].firstSeen) {
            userMap[u].firstSeen = info.firstSeen;
          }
        });
      } else {
        anonIps.push({ ip, firstSeen: info.firstSeen });
      }
    });
  }

  const userCount = Object.keys(userMap).length + anonIps.length;

  document.getElementById('active-count').innerText = Object.keys(active || {}).filter(ip => !banned[ip]).length;
  document.getElementById('games-count').innerText = Object.keys(games).length;
  document.getElementById('banned-count').innerText = Object.keys(banned).length;
  document.getElementById('seen-count').innerText = userCount;
  document.getElementById('rejected-count').innerText = Object.keys(rejected || {}).length;

  // Redis storage - only show used storage
  if (redisInfo && redisInfo.usedStorageHuman) {
    const card = document.getElementById('redis-usage-card');
    const usage = document.getElementById('redis-usage');
    card.style.display = 'flex';
    // Just show the used amount, no max
    usage.innerText = redisInfo.usedStorageHuman;
  }

  // Active Users
  const usersBody = document.querySelector('#users-table tbody');
  usersBody.innerHTML = '';
  Object.entries(active).forEach(([ip, data]) => {
    if (banned && banned[ip]) return;
    const row = document.createElement('tr');

    // Collect all usernames for this active session
    const usernames = data.usernames ? Object.keys(data.usernames) : [];
    if (data.lastUsername && !usernames.includes(data.lastUsername)) {
      usernames.push(data.lastUsername);
    }
    const usernameDisplay = usernames.length > 0 ? usernames.join(', ') : '-';

    // Gather all linked IPs for these usernames from the global userMap
    let linkedIps = new Set([ip]);
    usernames.forEach(u => {
      if (userMap[u] && userMap[u].ips) {
        userMap[u].ips.forEach(i => linkedIps.add(i));
      }
    });
    const ipList = Array.from(linkedIps);
    const ipListAttr = JSON.stringify(ipList).replace(/"/g, '&quot;');
    const lastSeen = new Date(data.lastSeen).toLocaleTimeString();

    // Decision: If we have usernames, use the Multi-IP ban function
    let banAction = `banIp('${ip}')`;
    if (usernames.length > 0) {
      banAction = `banUser('${usernames[0]}', ${ipListAttr})`;
    }

    row.innerHTML = `
      <td>${ip}</td>
      <td>${usernameDisplay}</td>
      <td>${lastSeen}</td>
      <td>
        <button class="danger" onclick="${banAction}">Ban</button>
      </td>
    `;
    usersBody.appendChild(row);
  });

  // Games list
  const gamesBody = document.querySelector('#games-table tbody');
  gamesBody.innerHTML = '';
  Object.entries(games).forEach(([appId, info]) => {
    const row = document.createElement('tr');

    const modeLabel = (info.mode === 1) ? 'Online bypass' : 'lua manifest';
    const name = names && names[appId] ? `${names[appId]} (${appId})` : appId;

    row.innerHTML = `
      <td>${name}</td>
      <td>${modeLabel}</td>
      <td>
        <button onclick="addGame('${appId}')">Add</button>
        <button onclick="rejectGame('${appId}')">Reject</button>
      </td>
    `;
    gamesBody.appendChild(row);
  });

  // Rejected list
  const rejectedBody = document.querySelector('#rejected-table tbody');
  rejectedBody.innerHTML = '';
  Object.keys(rejected || {}).forEach(appId => {
    const row = document.createElement('tr');
    const name = names && names[appId] ? `${names[appId]} (${appId})` : appId;
    row.innerHTML = `
      <td>${name}</td>
      <td><button onclick="unRejectGame('${appId}')">Remove</button></td>
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
      <td><button onclick="unbanIp('${ip}')">Unban</button></td>
    `;
    bannedBody.appendChild(row);
  });

  // User Activity (formerly Seen IPs) - Grouped
  const seenBody = document.querySelector('#seen-table tbody');
  if (seenBody) {
    seenBody.innerHTML = '';

    // Render Named Users first
    Object.entries(userMap).forEach(([username, data]) => {
      const row = document.createElement('tr');
      const ips = Array.from(data.ips).join(', ');
      const ipListAttr = JSON.stringify(Array.from(data.ips)).replace(/"/g, '&quot;');
      const firstSeen = (data.firstSeen !== Infinity) ? new Date(data.firstSeen).toLocaleString() : '-';

      // Check online status: user is online if ANY of their IPs are in the 'active' list
      const isOnline = Array.from(data.ips).some(ip => active && active[ip]);
      const statusBadge = isOnline
        ? '<span class="badge success">Online</span>'
        : '<span class="badge status-inactive">Offline</span>';

      row.innerHTML = `
        <td>${username}</td>
        <td>${statusBadge}</td>
        <td>${ips}</td>
        <td>${firstSeen}</td>
        <td><button class="danger" onclick="banUser('${username}', ${ipListAttr})">Ban User</button></td>
      `;
      seenBody.appendChild(row);
    });

    // Render Anonymous IPs
    anonIps.forEach(item => {
      const row = document.createElement('tr');
      const firstSeen = item.firstSeen ? new Date(item.firstSeen).toLocaleString() : '-';

      const isOnline = active && active[item.ip];
      const statusBadge = isOnline
        ? '<span class="badge success">Online</span>'
        : '<span class="badge status-inactive">Offline</span>';

      row.innerHTML = `
        <td>-</td>
        <td>${statusBadge}</td>
        <td>${item.ip}</td>
        <td>${firstSeen}</td>
        <td><button class="danger" onclick="banIp('${item.ip}')">Ban</button></td>
      `;
      seenBody.appendChild(row);
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

async function banUser(username, ips) {
  if (!confirm(`Ban user ${username} and all associated IPs (${ips.length})?`)) return;
  await fetch('/api/admin/ban', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ips })
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
  addGame(appId);
}

async function addGame(appId) {
  if (!confirm(`Add/Update game ${appId}?`)) return;
  await fetch('/api/admin/addgame', {
    method: 'POST',
    headers: { 'x-admin-pass': adminPass, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId })
  });
  loadState();
}
