const {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame,
  removeGame, getAdminPass, getRedisInfo
} = require("./lib.js");

// ---- HELPERS ----
function normalizeIp(ip) {
  if (!ip) return "unknown";
  return ip.replace(/^::ffff:/, "");
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", chunk => (s += chunk));
    req.on("end", () => {
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---- MAIN HANDLER ----
module.exports = async function handler(req, res) {
  // res.json helper
  if (!res.json) {
    res.json = (obj) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(obj));
    };
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (Array.isArray(ip)) ip = ip[0];
  if (typeof ip === "string" && ip.includes(",")) ip = ip.split(",")[0].trim();
  ip = normalizeIp(ip);

  // periodic cleanup
  const now = Date.now();
  if (!global._lastCleanup || now - global._lastCleanup > 300000) {
    global._lastCleanup = now;
    await cleanupExpired(300);
  }

  // OPTIONS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-pass");
    res.statusCode = 204;
    return res.end();
  }

  // -------------------------
  // /api/track
  // -------------------------
  if (req.url.startsWith("/api/track")) {
    try {
      const body = req.method === "POST" ? await jsonBody(req) : {};
      const clientId = body.clientId || req.headers["x-client-id"] || null;

      const username = body.username || body.discord || body.name || null;
      const result = await trackVisit(ip, clientId, username);

      // determine if requester provided admin pass so we can include admin-only fields
      const passForTrack = body.admin_pass || req.headers["x-admin-pass"] || url.searchParams.get("admin_pass") || "";
      const correctPass = await getAdminPass();
      const isAdmin = passForTrack === correctPass;

      const appId = body.appId;
      let extra = {};

      if (appId) {
        const state = await getAll();
        const games = state.games || {};
        const rejected = state.rejected || {};

        if (rejected[appId]) extra.gameStatus = "rejected";
        else if (!games[appId]) extra.gameStatus = "unknown";
        else {
          extra.gameStatus = "known";
          extra.game = games[appId];
        }
      }

      // hide active IPs unless admin
      if (!isAdmin && result && typeof result === 'object') {
        delete result.activeIps;
      }

      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, ip, ...result, extra });

    } catch (e) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.statusCode = 500;
      return res.json({ ok: false, error: e.message });
    }
  }

  // -------------------------
  // /api/reportGame
  // -------------------------
  if (req.url.startsWith("/api/reportGame")) {
    try {
      const body = await jsonBody(req);
      const { appId, mode } = body;

      if (!appId) {
        res.statusCode = 400;
        return res.json({ ok: false, error: "missing appId" });
      }

      const all = await getAll();
      if (all.rejected?.[appId]) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: false, reason: "rejected" });
      }

      const games = all.games || {};
      // If game already exists under appId, return existing
      if (games[appId]) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, game: games[appId] });
      }

      // Create new entry using reported mode
      const added = await addGame(appId, mode);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, game: added });

    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: false, error: e.message });
    }
  }

  // -------------------------
  // ADMIN
  // -------------------------
  if (req.url.startsWith("/api/admin/")) {
    const pass =
      req.headers["x-admin-pass"] ||
      url.searchParams.get("admin_pass") ||
      "";

    const correct = await getAdminPass();
    if (pass !== correct) {
      res.statusCode = 401;
      return res.json({ ok: false, error: "unauthorized" });
    }

    // ---- STATE (cached) ----
    if (req.url.startsWith("/api/admin/state")) {
      const CACHE_SEC = Number(process.env.ADMIN_STATE_CACHE_SEC) || 5;
      const MIN_REQ_MS = Number(process.env.ADMIN_MIN_REQUEST_INTERVAL_MS) || 1000;

      if (!global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      if (!global._adminLastReq) global._adminLastReq = {};

      const nowReq = Date.now();
      const lastReq = global._adminLastReq[ip] || 0;

      if (nowReq - lastReq < MIN_REQ_MS && global._adminStateCache.data) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, state: global._adminStateCache.data });
      }

      if (nowReq - global._adminStateCache.ts < CACHE_SEC * 1000 && global._adminStateCache.data) {
        global._adminLastReq[ip] = nowReq;
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, state: global._adminStateCache.data });
      }

      try {
        const state = await getAll();
        const redisInfo = await getRedisInfo();

        const response = { ...state };
        if (redisInfo) {
          response.redisInfo = redisInfo;
        }

        global._adminStateCache = { ts: Date.now(), data: response };
        global._adminLastReq[ip] = nowReq;

        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, state: response });

      } catch (e) {
        if (global._adminStateCache.data) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return res.json({ ok: true, state: global._adminStateCache.data });
        }
        res.statusCode = 500;
        return res.json({ ok: false, error: e.message });
      }
    }

    // ---- Other admin actions ----
    const body = req.method === "POST" ? await jsonBody(req) : {};

    if (req.url.startsWith("/api/admin/ban")) {
      await banIp(body.ip);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/unban")) {
      await unbanIp(body.ip);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/reject")) {
      await addRejected(body.appId);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/unreject")) {
      await removeRejected(body.appId);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/removegame")) {
      await removeGame(body.appId);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/addgame")) {
      await addGame(body.appId, body.mode);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/rejectgame")) {
      // addRejected will preserve existing game metadata (mode) before removing it
      await addRejected(body.appId);
      if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
      return res.json({ ok: true });
    }

    return res.status(404).json({ ok: false, error: "admin route not found" });
  }

  // fallback
  res.statusCode = 404;
  res.json({ ok: false, error: "unknown route" });
};
