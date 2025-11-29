const {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, setGameAdded,
  removeGame, getAdminPass
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

      const result = await trackVisit(ip, clientId);

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
        global._adminStateCache = { ts: Date.now(), data: state };
        global._adminLastReq[ip] = nowReq;

        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.json({ ok: true, state });

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
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/unban")) {
      await unbanIp(body.ip);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/reject")) {
      await addRejected(body.appId);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/unreject")) {
      await removeRejected(body.appId);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/setadded")) {
      await setGameAdded(body.appId, !!body.added);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/removegame")) {
      await removeGame(body.appId);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/addgame")) {
      await addGame(body.appId, body.mode, true);
      return res.json({ ok: true });
    }
    if (req.url.startsWith("/api/admin/rejectgame")) {
      await removeGame(body.appId);
      await addRejected(body.appId);
      return res.json({ ok: true });
    }

    return res.status(404).json({ ok: false, error: "admin route not found" });
  }

  // fallback
  res.statusCode = 404;
  res.json({ ok: false, error: "unknown route" });
};
