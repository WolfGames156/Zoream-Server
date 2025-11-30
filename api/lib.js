const fetch = require("node-fetch");
const redis = require("redis");

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
const KEY_GAMES_INDEX = "games_index_v1";
const KEY_BANNED = "banned_ips_v1";
const KEY_SEEN = "seen_v1";

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

async function getState() {
  const active = (await redisGet(KEY_ACTIVE)) || {};
  const games = (await redisGet(KEY_GAMES)) || {};
  const rejected = (await redisGet(KEY_REJECTED)) || {};
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};
  const banned = (await redisGet(KEY_BANNED)) || {};
  const seen = (await redisGet(KEY_SEEN)) || {};
  return { active, games, rejected, index, banned, seen };
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

  let uniqueClients = new Set();
  for (const k of activeKeys) {
    const ids = active[k].clientIds || {};
    for (const id of Object.keys(ids)) uniqueClients.add(id);
  }
  const activeCount = uniqueClients.size || activeKeys.length;

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
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};
  // If we have a display key for this appId, move that entry into rejected under its display key
  const displayKey = index[appId] || appId;
  if (games[displayKey]) {
    rej[displayKey] = games[displayKey];
    delete games[displayKey];
    // also set a simple flag under numeric appId for compatibility
    rej[appId] = true;
    await redisSet(KEY_GAMES, games);
  } else {
    // store a simple flag if we don't have previous metadata
    rej[appId] = true;
  }
  await redisSet(KEY_REJECTED, rej);
  return true;
}

async function removeRejected(appId) {
  const rej = (await redisGet(KEY_REJECTED)) || {};
  const prev = rej[appId];
  delete rej[appId];
  // also remove any displayKey version if present
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};
  const displayKey = index[appId];
  if (displayKey && rej[displayKey]) delete rej[displayKey];
  await redisSet(KEY_REJECTED, rej);
  // when un-rejecting, restore previous game metadata if available under displayKey
  const games = (await redisGet(KEY_GAMES)) || {};
  if (displayKey && !games[displayKey]) {
    if (prev && typeof prev === 'object' && prev.mode !== undefined) {
      games[displayKey] = { ...prev, added: false, createdAt: nowMs() };
    } else {
      games[displayKey] = { mode: 0, added: false, createdAt: nowMs() };
    }
    await redisSet(KEY_GAMES, games);
  }
  return true;
}

async function addGame(appId, mode = undefined, added = undefined) {
  const games = (await redisGet(KEY_GAMES)) || {};
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};

  // If we already have an index mapping, use it
  let displayKey = index[appId];
  // Helper to attempt to fetch Steam store name
  async function fetchSteamName(aid) {
    try {
      const res = await fetch(`https://store.steampowered.com/app/${aid}`);
      if (!res.ok) return aid;
      const txt = await res.text();
      const m = txt.match(/<div[^>]*class=["']apphub_AppName["'][^>]*>([^<]+)<\/div>/i);
      if (m && m[1]) return m[1].trim();
      // fallback to <title>
      const t = txt.match(/<title>([^<]+)<\/title>/i);
      if (t && t[1]) return t[1].replace(/\s*-\s*Steam\s*Store.*$/i, '').trim();
      return aid;
    } catch (e) {
      return aid;
    }
  }

  if (!displayKey) {
    const name = await fetchSteamName(appId);
    const safeName = String(name).replace(/[\r\n]+/g, ' ').trim();
    displayKey = `${safeName}(${appId})`;
    // create index mapping
    index[appId] = displayKey;
  }

  const exists = !!games[displayKey];
  let finalAdded;
  if (exists) {
    finalAdded = (added === undefined) ? !!games[displayKey].added : !!added;
    if (mode !== undefined) {
      games[displayKey].mode = Number(mode);
    }
  } else {
    finalAdded = !!added;
    games[displayKey] = { appId, name: displayKey.replace(new RegExp(`\\(${appId}\\)$`), '').trim(), mode: (mode === undefined ? 0 : Number(mode)), added: finalAdded, createdAt: nowMs() };
  }
  games[displayKey].added = finalAdded;
  await redisSet(KEY_GAMES, games);
  await redisSet(KEY_GAMES_INDEX, index);
  return games[displayKey];
}

async function setGameAdded(appId, added) {
  const games = (await redisGet(KEY_GAMES)) || {};
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};
  const displayKey = index[appId] || appId;
  if (!games[displayKey]) return null;
  games[displayKey].added = !!added;
  await redisSet(KEY_GAMES, games);
  return games[displayKey];
}

async function removeGame(appId) {
  const games = (await redisGet(KEY_GAMES)) || {};
  const index = (await redisGet(KEY_GAMES_INDEX)) || {};
  const displayKey = index[appId] || appId;
  delete games[displayKey];
  // remove index mapping if it pointed to this displayKey
  if (index[appId]) delete index[appId];
  await redisSet(KEY_GAMES, games);
  await redisSet(KEY_GAMES_INDEX, index);
  return true;
}

async function getAll() {
  return await getState();
}

module.exports = {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, setGameAdded, removeGame, getAdminPass
};