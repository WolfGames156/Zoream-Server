const fetch = require("node-fetch");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = !!UPSTASH_URL && !!UPSTASH_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

console.log('[Zoream] Upstash:', USE_UPSTASH ? 'YES' : 'NO');

const KEY_ACTIVE = "active_ips_v1";
const KEY_GAMES = "games_v1";
const KEY_REJECTED = "rejected_v1";
const KEY_BANNED = "banned_ips_v1";
const KEY_SEEN = "seen_v1";

// Upstash REST API - Direct endpoint calls
async function upstashGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  return data.result;
}

async function upstashSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "text/plain" },
    body: value
  });
}

async function upstashDel(key) {
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
}

// KV cache & debounce flushing to reduce Upstash requests
const KV_CACHE_TTL = Number(process.env.KV_CACHE_TTL_SECONDS) || 60; // seconds
const KV_FLUSH_DEBOUNCE_MS = Number(process.env.KV_FLUSH_DEBOUNCE_MS) || 5000; // flush writes after this delay
const KV_PERIODIC_FLUSH_MS = Number(process.env.KV_PERIODIC_FLUSH_MS) || 30000; // periodic flush interval

// In-memory cache structure: { [key]: { value, ts, dirty, timer } }
if (!global._kvCache) global._kvCache = {};

async function kvGet(key) {
  // non-Upstash: use ephemeral in-memory Map as before
  if (!USE_UPSTASH) {
    if (!global._memkv) global._memkv = new Map();
    const v = global._memkv.get(key);
    return v ? JSON.parse(v) : null;
  }

  const entry = global._kvCache[key];
  const now = Date.now();
  if (entry && (now - entry.ts) < KV_CACHE_TTL * 1000) {
    return entry.value;
  }

  try {
    const raw = await upstashGet(key);
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
    // update cache
    global._kvCache[key] = { value: parsed, ts: Date.now(), dirty: false, timer: null };
    return parsed;
  } catch (e) {
    console.error(`[KV] GET ${key}:`, e.message);
    // If network fails, fallback to cache if available
    if (entry) return entry.value;
    return null;
  }
}

async function _flushKeyToUpstash(key) {
  const entry = global._kvCache[key];
  if (!entry || !entry.dirty) return;
  try {
    await upstashSet(key, JSON.stringify(entry.value));
    entry.dirty = false;
    entry.ts = Date.now();
  } catch (e) {
    console.error(`[KV] FLUSH ${key}:`, e.message);
  }
}

function _scheduleFlush(key) {
  const entry = global._kvCache[key];
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    _flushKeyToUpstash(key);
  }, KV_FLUSH_DEBOUNCE_MS);
}

// Periodic flush of all dirty keys
if (USE_UPSTASH && !global._kvFlushInterval) {
  global._kvFlushInterval = setInterval(async () => {
    const keys = Object.keys(global._kvCache);
    for (const k of keys) {
      try { await _flushKeyToUpstash(k); } catch (e) { /* noop */ }
    }
  }, KV_PERIODIC_FLUSH_MS);
}

async function kvSet(key, obj) {
  if (!USE_UPSTASH) {
    if (!global._memkv) global._memkv = new Map();
    global._memkv.set(key, JSON.stringify(obj));
    return;
  }

  const prev = global._kvCache[key];
  const serialized = obj;
  // avoid unnecessary writes: if cached value equals new value, just update timestamp
  if (prev && deepEqual(prev.value, serialized)) {
    prev.ts = Date.now();
    prev.dirty = false;
    if (prev.timer) { clearTimeout(prev.timer); prev.timer = null; }
    return;
  }

  // update cache and mark dirty
  global._kvCache[key] = { value: serialized, ts: Date.now(), dirty: true, timer: null };
  _scheduleFlush(key);
}

async function kvDelete(key) {
  if (!USE_UPSTASH) {
    if (global._memkv) global._memkv.delete(key);
    return;
  }

  // remove from cache and attempt delete from Upstash
  if (global._kvCache[key]) {
    delete global._kvCache[key];
  }
  try {
    await upstashDel(key);
  } catch (e) {
    console.error(`[KV] DEL ${key}:`, e.message);
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
  const active = (await kvGet(KEY_ACTIVE)) || {};
  const games = (await kvGet(KEY_GAMES)) || {};
  const rejected = (await kvGet(KEY_REJECTED)) || {};
  const banned = (await kvGet(KEY_BANNED)) || {};
  const seen = (await kvGet(KEY_SEEN)) || {};
  return { active, games, rejected, banned, seen };
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
  await kvSet(KEY_ACTIVE, active);
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
  await kvSet(KEY_ACTIVE, active);

  // update seen mapping
  const seen = state.seen || {};
  const s = seen[ip] || { firstSeen: nowMs(), usernames: {} };
  if (username) s.usernames[username] = true;
  seen[ip] = s;
  await kvSet(KEY_SEEN, seen);

  let uniqueClients = new Set();
  for (const k of Object.keys(active)) {
    const ids = active[k].clientIds || {};
    for (const id of Object.keys(ids)) uniqueClients.add(id);
  }
  const activeCount = uniqueClients.size || Object.keys(active).length;

  return { newIp: !wasPresent, activeCount, activeIps: Object.keys(active), banned: false };
}

async function banIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  banned[ip] = true;
  await kvSet(KEY_BANNED, banned);
  const active = state.active || {};
  delete active[ip];
  await kvSet(KEY_ACTIVE, active);
  return true;
}

async function unbanIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  delete banned[ip];
  await kvSet(KEY_BANNED, banned);
  return true;
}

async function addRejected(appId) {
  const rej = (await kvGet(KEY_REJECTED)) || {};
  const games = (await kvGet(KEY_GAMES)) || {};
  if (games[appId]) {
    // preserve the game object (mode, createdAt, etc.) in rejected map
    rej[appId] = games[appId];
    delete games[appId];
    await kvSet(KEY_GAMES, games);
  } else {
    // store a simple flag if we don't have previous metadata
    rej[appId] = true;
  }
  await kvSet(KEY_REJECTED, rej);
  return true;
}

async function removeRejected(appId) {
  const rej = (await kvGet(KEY_REJECTED)) || {};
  const prev = rej[appId];
  delete rej[appId];
  await kvSet(KEY_REJECTED, rej);
  // when un-rejecting, restore previous game metadata if available
  const games = (await kvGet(KEY_GAMES)) || {};
  if (!games[appId]) {
    if (prev && typeof prev === 'object' && prev.mode !== undefined) {
      games[appId] = { mode: Number(prev.mode), added: false, createdAt: nowMs() };
    } else {
      games[appId] = { mode: 0, added: false, createdAt: nowMs() };
    }
    await kvSet(KEY_GAMES, games);
  }
  return true;
}

async function addGame(appId, mode = undefined, added = undefined) {
  const games = (await kvGet(KEY_GAMES)) || {};
  const exists = !!games[appId];
  let finalAdded;
  if (exists) {
    finalAdded = (added === undefined) ? !!games[appId].added : !!added;
    // Only overwrite mode if caller provided a mode value
    if (mode !== undefined) {
      games[appId].mode = Number(mode);
    }
    // keep createdAt as-is
  } else {
    finalAdded = !!added;
    games[appId] = { mode: (mode === undefined ? 0 : Number(mode)), added: finalAdded, createdAt: nowMs() };
  }
  games[appId].added = finalAdded;
  await kvSet(KEY_GAMES, games);
  return games[appId];
}

async function setGameAdded(appId, added) {
  const games = (await kvGet(KEY_GAMES)) || {};
  if (!games[appId]) return null;
  games[appId].added = !!added;
  await kvSet(KEY_GAMES, games);
  return games[appId];
}

async function removeGame(appId) {
  const games = (await kvGet(KEY_GAMES)) || {};
  delete games[appId];
  await kvSet(KEY_GAMES, games);
  return true;
}

async function getAll() {
  return await getState();
}

module.exports = {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, setGameAdded, removeGame, getAdminPass
};