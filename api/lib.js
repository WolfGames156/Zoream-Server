const redis = require("redis");
const https = require("https");

const REDIS_URL = process.env.REDIS_URL;
const USE_REDIS = !!REDIS_URL;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

console.log('[Zoream] Redis:', USE_REDIS ? 'YES' : 'NO');

// Redis client
let redisClient = null;

if (USE_REDIS) {
  redisClient = redis.createClient({ url: REDIS_URL });
  redisClient.on("error", (err) => console.error("[Redis] Client error:", err));
  redisClient.on("connect", () => console.log("[Redis] Connected"));
  redisClient.connect().catch(err => console.error("[Redis] Connection error:", err));
}

const KEY_ACTIVE = "active_ips_v1";
const KEY_GAMES = "games_v1";
const KEY_REJECTED = "rejected_v1";
const KEY_BANNED = "banned_ips_v1";
const KEY_SEEN = "seen_v1";
const KEY_NAMES = "names_v1";

// Redis helper functions
async function redisGet(key) {
  if (!redisClient || !USE_REDIS) {
    if (!global._memkv) global._memkv = new Map();
    const v = global._memkv.get(key);
    return v ? JSON.parse(v) : null;
  }
  try {
    const val = await redisClient.get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) {
    console.error(`[Redis] GET ${key} error:`, e.message);
    return null;
  }
}

async function redisSet(key, obj) {
  if (!redisClient || !USE_REDIS) {
    if (!global._memkv) global._memkv = new Map();
    global._memkv.set(key, JSON.stringify(obj));
    return;
  }
  try {
    await redisClient.set(key, JSON.stringify(obj));
  } catch (e) {
    console.error(`[Redis] SET ${key} error:`, e.message);
  }
}

async function redisDel(key) {
  if (!redisClient || !USE_REDIS) {
    if (global._memkv) global._memkv.delete(key);
    return;
  }
  try {
    await redisClient.del(key);
  } catch (e) {
    console.error(`[Redis] DEL ${key} error:`, e.message);
  }
}

// shallow deepEqual for JSON-able objects
function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) { return false; }
}

function nowMs() { return Date.now(); }
async function getAdminPass() { return ADMIN_PASS; }

// --- Steam Name Fetching ---
function fetchSteamName(appId) {
  return new Promise((resolve) => {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && json[appId] && json[appId].success && json[appId].data) {
            resolve(json[appId].data.name);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

const _fetching = new Set();
async function fetchMissingNames(missing) {
  const toFetch = missing.filter(id => !_fetching.has(id));
  if (toFetch.length === 0) return;

  toFetch.forEach(id => _fetching.add(id));

  // Run in background
  (async () => {
    let updates = {};
    for (const id of toFetch) {
      await new Promise(r => setTimeout(r, 500)); // 500ms delay to be nice to Steam
      const name = await fetchSteamName(id);
      if (name) updates[id] = name;
      _fetching.delete(id);
    }

    if (Object.keys(updates).length > 0) {
      const current = (await redisGet(KEY_NAMES)) || {};
      Object.assign(current, updates);
      await redisSet(KEY_NAMES, current);
    }
  })();
}

async function getState() {
  const active = (await redisGet(KEY_ACTIVE)) || {};
  const games = (await redisGet(KEY_GAMES)) || {};
  const rejected = (await redisGet(KEY_REJECTED)) || {};
  const banned = (await redisGet(KEY_BANNED)) || {};
  const seen = (await redisGet(KEY_SEEN)) || {};
  const names = (await redisGet(KEY_NAMES)) || {};

  // Check for missing names
  const allIds = new Set([...Object.keys(games), ...Object.keys(rejected)]);
  const missing = [];
  for (const id of allIds) {
    if (!names[id]) missing.push(id);
  }
  if (missing.length > 0) {
    fetchMissingNames(missing).catch(e => console.error("Bg fetch error:", e));
  }

  return { active, games, rejected, banned, seen, names };
}

async function cleanupExpired(thresholdSec = 300) {
  const state = await getState();
  const active = state.active || {};
  const now = nowMs();
  const removed = [];
  for (const ip of Object.keys(active)) {
    if ((now - active[ip].lastSeen) > thresholdSec * 1000) {
      removed.push(ip);
      delete active[ip];
    }
  }
  await redisSet(KEY_ACTIVE, active);
  return removed;
}

async function trackVisit(ip, clientId, username) {
  if (!ip) throw new Error("no ip");
  const state = await getState();
  if (state.banned && state.banned[ip]) return { banned: true };

  const active = state.active || {};
  const entry = active[ip] || { lastSeen: 0, clientIds: {}, usernames: {} };
  const wasPresent = !!active[ip];

  if (clientId) entry.clientIds[clientId] = true;
  if (username) entry.usernames[username] = true;
  // also keep a 'lastUsername' for quick display
  if (username) entry.lastUsername = username;
  entry.lastSeen = nowMs();
  active[ip] = entry;
  await redisSet(KEY_ACTIVE, active);

  // update seen mapping
  const seen = state.seen || {};
  const s = seen[ip] || { firstSeen: nowMs(), usernames: {} };
  if (username) s.usernames[username] = true;
  seen[ip] = s;
  await redisSet(KEY_SEEN, seen);

  // Filter out banned IPs for the count and list
  const bannedIps = state.banned || {};
  const activeKeys = Object.keys(active).filter(ip => !bannedIps[ip]);


  const activeCount = activeKeys.length;


  // Provide legacy `active` field for older clients that expect `active` key
  return { newIp: !wasPresent, activeCount, active: activeCount, activeIps: activeKeys, banned: false };
}

async function banIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  banned[ip] = true;
  await redisSet(KEY_BANNED, banned);
  const active = state.active || {};
  delete active[ip];
  await redisSet(KEY_ACTIVE, active);
  return true;
}

async function unbanIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  delete banned[ip];
  await redisSet(KEY_BANNED, banned);
  return true;
}

async function addRejected(appId) {
  const rej = (await redisGet(KEY_REJECTED)) || {};
  const games = (await redisGet(KEY_GAMES)) || {};
  // move any existing game metadata under the numeric appId key into rejected
  if (games[appId]) {
    rej[appId] = games[appId];
    delete games[appId];
    // also set a simple flag under numeric appId for compatibility
    rej[appId] = true;
    await redisSet(KEY_GAMES, games);
  } else {
    rej[appId] = true;
  }
  await redisSet(KEY_REJECTED, rej);

  // Clean up game name from storage
  const names = (await redisGet(KEY_NAMES)) || {};
  if (names[appId]) {
    delete names[appId];
    await redisSet(KEY_NAMES, names);
  }

  return true;
}

async function removeRejected(appId) {
  const rej = (await redisGet(KEY_REJECTED)) || {};
  const prev = rej[appId];
  delete rej[appId];
  await redisSet(KEY_REJECTED, rej);

  // Clean up game name from storage
  const names = (await redisGet(KEY_NAMES)) || {};
  if (names[appId]) {
    delete names[appId];
    await redisSet(KEY_NAMES, names);
  }

  // when un-rejecting, restore previous game metadata if available
  const games = (await redisGet(KEY_GAMES)) || {};
  if (prev && typeof prev === 'object' && !games[appId]) {
    games[appId] = { ...prev, createdAt: nowMs() };
    await redisSet(KEY_GAMES, games);
  }
  return true;
}

async function addGame(appId, mode = undefined) {
  // "Add game" now means remove it from the list (similar to removeGame)
  const games = (await redisGet(KEY_GAMES)) || {};
  delete games[appId];
  await redisSet(KEY_GAMES, games);

  // Clean up game name from storage
  const names = (await redisGet(KEY_NAMES)) || {};
  if (names[appId]) {
    delete names[appId];
    await redisSet(KEY_NAMES, names);
  }

  return { removed: true };
}

// setGameAdded is no longer needed since we removed the added field

async function removeGame(appId) {
  const games = (await redisGet(KEY_GAMES)) || {};
  delete games[appId];
  await redisSet(KEY_GAMES, games);

  // Clean up game name from storage
  const names = (await redisGet(KEY_NAMES)) || {};
  if (names[appId]) {
    delete names[appId];
    await redisSet(KEY_NAMES, names);
  }

  return true;
}

async function getAll() {
  return await getState();
}

module.exports = {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, removeGame, getAdminPass
};