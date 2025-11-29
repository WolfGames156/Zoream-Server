// api/lib.js
const fetch = require("node-fetch");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = !!UPSTASH_URL && !!UPSTASH_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

console.log('[Zoream] Upstash configured:', USE_UPSTASH ? 'YES' : 'NO (using memory)');

// Key names in Redis
const KEY_ACTIVE = "active_ips_v1";
const KEY_GAMES = "games_v1";
const KEY_REJECTED = "rejected_v1";
const KEY_BANNED = "banned_ips_v1";

// helper for Upstash REST
async function upstashRequest(body) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function kvGet(key) {
  if (USE_UPSTASH) {
    try {
      const r = await upstashRequest({ "commands": [["GET", key]] });
      console.log(`[KV GET] ${key}:`, JSON.stringify(r).substring(0, 200));

      // Upstash pipeline response: [{"result": "value"}]
      let val = null;
      if (Array.isArray(r) && r.length > 0) {
        val = r[0].result;
      }

      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    } catch (e) {
      console.error(`[KV Error] GET ${key}:`, e.message);
      return null;
    }
  } else {
    if (!global._memkv) global._memkv = new Map();
    const v = global._memkv.get(key);
    return v ? JSON.parse(v) : null;
  }
}

async function kvSet(key, obj) {
  if (USE_UPSTASH) {
    const r = await upstashRequest({ "commands": [["SET", key, JSON.stringify(obj)]] });
    console.log(`[KV SET] ${key}:`, JSON.stringify(r));
  } else {
    if (!global._memkv) global._memkv = new Map();
    global._memkv.set(key, JSON.stringify(obj));
  }
}

async function kvDelete(key) {
  if (USE_UPSTASH) {
    await upstashRequest({ "commands": [["DEL", key]] });
  } else {
    if (global._memkv) global._memkv.delete(key);
  }
}

function nowMs() { return Date.now(); }
async function getAdminPass() { return ADMIN_PASS; }

async function getState() {
  const active = (await kvGet(KEY_ACTIVE)) || {};
  const games = (await kvGet(KEY_GAMES)) || {};
  const rejected = (await kvGet(KEY_REJECTED)) || {};
  const banned = (await kvGet(KEY_BANNED)) || {};
  return { active, games, rejected, banned };
}

async function cleanupExpired(thresholdSec = 60) {
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

async function trackVisit(ip, clientId) {
  if (!ip) throw new Error("no ip");
  const state = await getState();
  if (state.banned && state.banned[ip]) return { banned: true };

  const active = state.active || {};
  const entry = active[ip] || { lastSeen: 0, clientIds: {} };
  const wasPresent = !!active[ip];

  if (clientId) entry.clientIds[clientId] = true;
  entry.lastSeen = nowMs();
  active[ip] = entry;
  await kvSet(KEY_ACTIVE, active);

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
  rej[appId] = true;
  await kvSet(KEY_REJECTED, rej);
  return true;
}

async function removeRejected(appId) {
  const rej = (await kvGet(KEY_REJECTED)) || {};
  delete rej[appId];
  await kvSet(KEY_REJECTED, rej);
  return true;
}

async function addGame(appId, mode = 0, added = false) {
  const games = (await kvGet(KEY_GAMES)) || {};
  games[appId] = { mode: Number(mode), added: !!added, createdAt: nowMs() };
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

async function getAll() {
  return await getState();
}

module.exports = {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, setGameAdded, getAdminPass
};