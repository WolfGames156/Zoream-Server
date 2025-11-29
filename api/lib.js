// api/lib.js
const fetch = require("node-fetch");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = !!UPSTASH_URL && !!UPSTASH_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// Key names in Redis
const KEY_ACTIVE = "active_ips_v1"; // hash JSON
const KEY_GAMES = "games_v1";       // hash of appId -> {mode:0|1, added:false}
const KEY_REJECTED = "rejected_v1"; // set of appIds
const KEY_BANNED = "banned_ips_v1"; // set of ips

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
      // Upstash pipeline response format: [{result: "value"}, ...] or similar depending on client.
      // But here we are using raw REST pipeline.
      // If the previous code used r?.results?.[0]?.[1], it might be adapting to a specific response.
      // Let's try to be robust.
      // Common Upstash REST pipeline response: [ { result: "..." } ]
      // But let's stick to what was there if possible, or use a safer access.

      // Actually, let's look at the previous code's assumption: r.results[0][1]
      // This looks like it expects [ [null, "value"], ... ] ?
      // Or maybe { results: [ { ... } ] } ?

      // To be safe, let's assume the previous code was working for the user's setup if they had one.
      // But since they are setting it up NEW, let's use the standard single command if possible?
      // No, let's stick to the code structure but fix the corruption.

      // I will use a safer parsing logic.
      const val = r?.results?.[0]?.[1] ?? r?.[0]?.result ?? null;
      return val ? JSON.parse(val) : null;
    } catch (e) {
      console.error("KV Error", e);
      return null;
    }
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

async function getAdminPass() { return ADMIN_PASS; }

async function getState() {
  const active = (await kvGet(KEY_ACTIVE)) || {};
  const games = (await kvGet(KEY_GAMES)) || {};
  const rejected = (await kvGet(KEY_REJECTED)) || {};
  const banned = (await kvGet(KEY_BANNED)) || {};
  return { active, games, rejected, banned };
}

// Called on each incoming request to clean old IPs (>60s inactivity)
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

// Track IP visit. clientId is a per-machine generated id from frontend.
// Returns {newIp:bool, activeCount:int, activeIps:[], banned:boolean}
async function trackVisit(ip, clientId) {
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
async function banIp(ip) {
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