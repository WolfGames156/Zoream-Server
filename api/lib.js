// api/lib.js
import fetch from "node-fetch";

const USE_UPSTASH = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// Key names in Redis
const KEY_ACTIVE = "active_ips_v1"; // hash JSON
const KEY_GAMES = "games_v1";       // hash of appId -> {mode:0|1, added:false}
const KEY_REJECTED = "rejected_v1"; // set of appIds
const KEY_BANNED = "banned_ips_v1"; // set of ips

// helper for Upstash REST
async function upstashRequest(body) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function kvGet(key) {
  if (USE_UPSTASH) {
    const r = await upstashRequest({ "commands": [["GET", key]] });
    // r.results[0] might be null or string
    const val = r?.results?.[0]?.[1] ?? null;
    return val ? JSON.parse(val) : null;
  } else {
    // fallback (ephemeral)
    if (!global._memkv) global._memkv = new Map();
    const v = global._memkv.get(key);
    return v ? JSON.parse(v) : null;
  }
}

async function kvSet(key, obj) {
  if (USE_UPSTASH) {
    await upstashRequest({ "commands": [["SET", key, JSON.stringify(obj)]] });
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

// Utilities
function nowMs() { return Date.now(); }

export async function getAdminPass() { return ADMIN_PASS; }

export async function getState() {
  const active = (await kvGet(KEY_ACTIVE)) || {};
  const games = (await kvGet(KEY_GAMES)) || {};
  const rejected = (await kvGet(KEY_REJECTED)) || {};
  const banned = (await kvGet(KEY_BANNED)) || {};
  return { active, games, rejected, banned };
}

// Called on each incoming request to clean old IPs (>60s inactivity)
export async function cleanupExpired(thresholdSec = 60) {
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

// Track IP visit. clientId is a per-machine generated id from frontend.
// Returns {newIp:bool, activeCount:int, activeIps:[], banned:boolean}
export async function trackVisit(ip, clientId) {
  if (!ip) throw new Error("no ip");
  const state = await getState();
  if (state.banned && state.banned[ip]) return { banned: true };

  const active = state.active || {};
  const entry = active[ip] || { lastSeen: 0, clientIds: {} }; // clientIds map to true
  const wasPresent = !!active[ip];

  // if this clientId hasn't been seen for this ip, increment clientIds (prevent duplicates per-machine)
  if (clientId) entry.clientIds[clientId] = true;
  entry.lastSeen = nowMs();
  active[ip] = entry;
  await kvSet(KEY_ACTIVE, active);

  // compute active count as number of distinct unique clientIds across IPs (best-effort)
  let uniqueClients = new Set();
  for (const k of Object.keys(active)) {
    const ids = active[k].clientIds || {};
    for (const id of Object.keys(ids)) uniqueClients.add(id);
  }
  // fallback: if no clientIds were provided by clients, count distinct IPs
  const activeCount = uniqueClients.size || Object.keys(active).length;

  return { newIp: !wasPresent, activeCount, activeIps: Object.keys(active), banned: false };
}

// Admin actions
export async function banIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  banned[ip] = true;
  await kvSet(KEY_BANNED, banned);
  // remove from active
  const active = state.active || {};
  delete active[ip];
  await kvSet(KEY_ACTIVE, active);
  return true;
}
export async function unbanIp(ip) {
  const state = await getState();
  const banned = state.banned || {};
  delete banned[ip];
  await kvSet(KEY_BANNED, banned);
  return true;
}
export async function addRejected(appId) {
  const rej = (await kvGet(KEY_REJECTED)) || {};
  rej[appId] = true;
  await kvSet(KEY_REJECTED, rej);
  return true;
}
export async function removeRejected(appId) {
  const rej = (await kvGet(KEY_REJECTED)) || {};
  delete rej[appId];
  await kvSet(KEY_REJECTED, rej);
  return true;
}
export async function addGame(appId, mode = 0, added = false) {
  const games = (await kvGet(KEY_GAMES)) || {};
  games[appId] = { mode: Number(mode), added: !!added, createdAt: nowMs() };
  await kvSet(KEY_GAMES, games);
  return games[appId];
}
export async function setGameAdded(appId, added) {
  const games = (await kvGet(KEY_GAMES)) || {};
  if (!games[appId]) return null;
  games[appId].added = !!added;
  await kvSet(KEY_GAMES, games);
  return games[appId];
}
export async function getAll() {
  return await getState();
}
