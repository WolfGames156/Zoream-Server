const { MongoClient } = require("mongodb");
const https = require("https");

const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// Simple in-memory fallback if no DB connection
const globalMem = {
  active: {}, games: {}, rejected: {}, banned: {}, seen: {}, names: {}
};

console.log('[Zoream] MongoDB:', MONGO_URI ? 'Configured' : 'Missing MONGO_URI');

let client;
let clientPromise;

if (MONGO_URI) {
  if (!global._mongoClientPromise) {
    client = new MongoClient(MONGO_URI);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
}

async function getDb() {
  if (!clientPromise) return null;
  const connectedClient = await clientPromise;
  return connectedClient.db("zoream_db");
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

  (async () => {
    const db = await getDb();
    if (!db) return;

    for (const id of toFetch) {
      await new Promise(r => setTimeout(r, 500)); // 500ms delay
      const name = await fetchSteamName(id);
      if (name) {
        await db.collection('names').updateOne(
          { appId: id },
          { $set: { appId: id, name: name } },
          { upsert: true }
        );
      }
      _fetching.delete(id);
    }
  })();
}

// --- Helper: Get Active Threshold ---
const ACTIVE_THRESHOLD_SEC = 3600; // 1 hour

async function getState() {
  const db = await getDb();
  if (!db) return globalMem;

  const now = nowMs();
  const activeCutoff = now - (ACTIVE_THRESHOLD_SEC * 1000);

  // Use Promise.all for concurrency
  const [activeList, gamesList, rejectedList, bannedList, bannedSerialsList, seenList, namesList] = await Promise.all([
    db.collection('seen_users').find({ lastSeen: { $gt: activeCutoff } }).toArray(),
    db.collection('games').find({}).toArray(),
    db.collection('rejected').find({}).toArray(),
    db.collection('banned_ips').find({}).toArray(),
    db.collection('banned_serials').find({}).toArray(),
    db.collection('seen_users').find({}).toArray(),
    db.collection('names').find({}).toArray()
  ]);

  // Transform activeList (from seen_users) to match expected 'active' structure
  const active = {};
  activeList.forEach(d => {
    // We treat recent seen_users as active sessions
    const { _id, ip, ...rest } = d;
    active[ip] = rest;
  });

  const games = {};
  gamesList.forEach(d => {
    const { _id, appId, ...rest } = d;
    games[appId] = rest;
  });

  const rejected = {};
  rejectedList.forEach(d => {
    const { _id, appId, value, ...rest } = d;
    rejected[appId] = (Object.keys(rest).length > 0) ? rest : (value === undefined ? true : value);
  });

  const banned = {};
  // Create a map of active/seen users for quick lookup of details
  const seenMap = new Map();
  seenList.forEach(d => seenMap.set(d.ip, d));

  bannedList.forEach(d => {
    const seenInfo = seenMap.get(d.ip);
    banned[d.ip] = {
      ip: d.ip,
      serial: seenInfo?.serial || null,
      usernames: seenInfo?.usernames ? Object.keys(seenInfo.usernames) : []
    };
  });

  const bannedSerials = {};
  bannedSerialsList.forEach(d => {
    bannedSerials[d.serial] = true;
  });

  const seen = {};
  seenList.forEach(d => {
    const { _id, ip, ...rest } = d;
    seen[ip] = rest;
  });

  const names = {};
  namesList.forEach(d => {
    names[d.appId] = d.name;
  });

  // Check for missing names
  const allIds = new Set([...Object.keys(games), ...Object.keys(rejected)]);
  const missing = [];
  for (const id of allIds) {
    if (!names[id]) missing.push(id);
  }
  if (missing.length > 0) {
    fetchMissingNames(missing).catch(e => console.error("Bg fetch error:", e));
  }

  return { active, games, rejected, banned, bannedSerials, seen, names };
}

async function cleanupExpired(thresholdSec = 300) {
  return [];
}

// --- In-Memory Caches for Optimization ---
let _bannedCache = null;
let _bannedSerialCache = null;
let _bannedCacheTime = 0;
const BANNED_CACHE_TTL = 30000; // 30 sec

async function isIpBanned(ip) {
  const now = nowMs();
  if (!_bannedCache || (now - _bannedCacheTime > BANNED_CACHE_TTL)) {
    const db = await getDb();
    if (!db) return false;
    const list = await db.collection('banned_ips').find({}).project({ ip: 1 }).toArray();
    _bannedCache = new Set(list.map(d => d.ip));

    // Refresh serial cache too
    const serialList = await db.collection('banned_serials').find({}).project({ serial: 1 }).toArray();
    _bannedSerialCache = new Set(serialList.map(d => d.serial));

    _bannedCacheTime = now;
  }
  return _bannedCache.has(ip);
}

async function isSerialBanned(serial) {
  const now = nowMs();
  if (!_bannedSerialCache || (now - _bannedCacheTime > BANNED_CACHE_TTL)) {
    await isIpBanned('0.0.0.0'); // Triggers refresh
  }
  return serial && _bannedSerialCache && _bannedSerialCache.has(serial);
}

// Write throttling: { ip: lastWriteTime }
const _writeThrottle = new Map();
const WRITE_THROTTLE_MS = 60000; // 1 minute

async function trackVisit(ip, clientId, username, status, serial) {
  if (!ip) throw new Error("no ip");
  const db = await getDb();
  if (!db) return {};

  if (await isIpBanned(ip)) return { banned: true };
  if (serial && await isSerialBanned(serial)) return { banned: true };

  const now = nowMs();
  const activeCutoff = now - (ACTIVE_THRESHOLD_SEC * 1000);

  // Throttle Writes
  let shouldWrite = true;
  const lastWrite = _writeThrottle.get(ip);
  // Force write if going offline, otherwise check throttle
  if (status !== 'offline' && lastWrite && (now - lastWrite < WRITE_THROTTLE_MS)) {
    shouldWrite = false;
  }

  if (shouldWrite) {
    if (status === 'offline') {
      // User is going offline explicitly
      await db.collection('seen_users').deleteOne({ ip });
      // Clear throttle so next login writes immediately
      _writeThrottle.delete(ip);
    } else {
      _writeThrottle.set(ip, now);

      const seenOps = {
        $setOnInsert: { firstSeen: now, ip: ip },
        $set: { lastSeen: now }
      };

      const seenUpdate = {};
      if (username) {
        seenUpdate[`usernames.${username}`] = true;
      }
      if (serial) {
        seenUpdate.serial = serial;
      }

      if (Object.keys(seenUpdate).length > 0) {
        Object.assign(seenOps.$set, seenUpdate);
      }

      await db.collection('seen_users').updateOne(
        { ip },
        seenOps,
        { upsert: true }
      );
    }
  }

  // Count active users (Query seen_users based on time)
  const activeCount = await db.collection('seen_users').countDocuments({
    lastSeen: { $gt: activeCutoff }
  });

  return {
    activeCount,
    active: activeCount,
    banned: false
  };
}

async function banSerial(serial) {
  if (!serial) return false;
  const db = await getDb();
  if (!db) return false;
  await db.collection('banned_serials').updateOne({ serial }, { $set: { serial } }, { upsert: true });
  _bannedSerialCache = null;
  return true;
}

async function unbanSerial(serial) {
  if (!serial) return false;
  const db = await getDb();
  if (!db) return false;
  await db.collection('banned_serials').deleteOne({ serial });
  _bannedSerialCache = null;
  return true;
}

async function banIp(ip) {
  const db = await getDb();
  if (!db) return;

  await db.collection('banned_ips').updateOne({ ip }, { $set: { ip: ip } }, { upsert: true });

  // Propagate to serial and other IPs
  const userNode = await db.collection('seen_users').findOne({ ip });
  if (userNode && userNode.serial) {
    const serial = userNode.serial;
    await banSerial(serial);

    // Find all related IPs (same serial)
    const relatedDocs = await db.collection('seen_users').find({ serial }).toArray();
    const relatedIps = relatedDocs.map(d => d.ip).filter(i => i !== ip);

    if (relatedIps.length > 0) {
      const ops = relatedIps.map(rip => ({ updateOne: { filter: { ip: rip }, update: { $set: { ip: rip } }, upsert: true } }));
      await db.collection('banned_ips').bulkWrite(ops);
    }
  }

  _bannedCache = null;
  return true;
}

async function banIps(ips) {
  if (!Array.isArray(ips) || ips.length === 0) return true;
  for (const ip of ips) {
    await banIp(ip);
  }
  return true;
}

async function unbanIp(ip) {
  const db = await getDb();
  if (!db) return;
  await db.collection('banned_ips').deleteOne({ ip });

  // Clean up serial bans if this IP was the trigger/key
  const userNode = await db.collection('seen_users').findOne({ ip });
  if (userNode && userNode.serial) {
    const serial = userNode.serial;
    await unbanSerial(serial);

    const relatedDocs = await db.collection('seen_users').find({ serial }).toArray();
    const relatedIps = relatedDocs.map(d => d.ip).filter(i => i !== ip);

    if (relatedIps.length > 0) {
      await db.collection('banned_ips').deleteMany({ ip: { $in: relatedIps } });
    }
  }

  _bannedCache = null;
  return true;
}

async function addRejected(appId) {
  const db = await getDb();
  if (!db) return;

  const q = { appId: { $in: [String(appId), Number(appId)] } };

  const game = await db.collection('games').findOne(q);
  let dataToSave = { appId: String(appId), value: true };

  if (game) {
    const { _id, ...rest } = game;
    dataToSave = { ...rest, appId: String(appId) };
    await db.collection('games').deleteMany(q);
  }

  await db.collection('rejected').deleteMany(q);
  await db.collection('rejected').insertOne(dataToSave);

  await db.collection('names').deleteMany(q);
  return true;
}

async function removeRejected(appId) {
  const db = await getDb();
  if (!db) return;

  const q = { appId: { $in: [String(appId), Number(appId)] } };

  const rejected = await db.collection('rejected').findOne(q);
  await db.collection('rejected').deleteMany(q);
  await db.collection('names').deleteMany(q);

  if (rejected) {
    const { _id, value, appId: _aid, ...rest } = rejected;
    if (rest.mode !== undefined) {
      const sAppId = String(appId);
      await db.collection('games').updateOne(
        { appId: sAppId },
        { $set: { ...rest, appId: sAppId, createdAt: nowMs() } },
        { upsert: true }
      );
    }
  }
  return true;
}

async function addGame(appId, mode = undefined) {
  const db = await getDb();
  if (!db) return;

  const doc = {
    appId,
    mode: mode !== undefined ? mode : 1,
    createdAt: nowMs()
  };

  await db.collection('games').updateOne({ appId }, { $set: doc }, { upsert: true });
  return doc;
}

async function removeGame(appId) {
  const db = await getDb();
  if (!db) return;

  const q = { appId: { $in: [String(appId), Number(appId)] } };

  await db.collection('games').deleteMany(q);
  await db.collection('names').deleteMany(q);
  return true;
}

async function getAll() {
  return await getState();
}

async function getDbInfo() {
  const db = await getDb();
  if (!db) return null;
  try {
    const stats = await db.stats();
    return {
      usedStorage: stats.dataSize,
      maxStorage: stats.storageSize,
      usedStorageHuman: formatBytes(stats.dataSize),
      maxStorageHuman: formatBytes(stats.storageSize) + ' (Allocated)'
    };
  } catch (e) {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

module.exports = {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp, banIps,
  addRejected, removeRejected, addGame, removeGame, getAdminPass, getDbInfo
};