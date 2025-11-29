// api/index.js

const {
  trackVisit, cleanupExpired, getAll, banIp, unbanIp,
  addRejected, removeRejected, addGame, setGameAdded, getAdminPass
} = require("./lib.js");

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/^\/+/, "").split("/").slice(1).join("/");
  // Note: Vercel will map /api/* to this file; we'll branch on req.url
  const route = req.url.split("?")[0] || req.url;

  // get IP (Vercel/Proxy support)
  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (Array.isArray(ip)) ip = ip[0];
  // x-forwarded-for may be comma list
  if (typeof ip === "string" && ip.includes(",")) ip = ip.split(",")[0].trim();

  // Basic cleanup each request
  await cleanupExpired(60);

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-pass");
    return res.status(204).end();
  }

  // /api/track -> body: { clientId, appId? }  (clientId from localStorage)
  if (req.url.startsWith("/api/track")) {
    try {
      const body = req.method === "POST" ? await jsonBody(req) : {};
      const clientId = body.clientId || req.headers["x-client-id"] || null;
      const result = await trackVisit(normalizeIp(ip), clientId);
      // if client included appId and it's unknown, respond instructing to send appId check
      const appId = body.appId;
      let extra = {};
      if (appId) {
        const state = await getAll();
        const games = state.games || {};
        const rejected = state.rejected || {};
        if (rejected[appId]) {
          extra.gameStatus = "rejected";
        } else if (!games[appId]) {
          extra.gameStatus = "unknown"; // ask client to send appId checking result
        } else {
          extra.gameStatus = "known";
          extra.game = games[appId];
        }
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, ip: normalizeIp(ip), ...result, extra });
    } catch (e) {
      console.error(e);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // /api/reportGame -> body { appId, mode } mode: 0 -> lua manifest, 1 -> online bypass
  if (req.url.startsWith("/api/reportGame")) {
    try {
      const body = await jsonBody(req);
      const { appId, mode } = body;
      if (!appId) return res.status(400).json({ ok: false, error: "missing appId" });
      // If the app is in rejected list, ignore
      const games = (await getAll()).games || {};
      const rejected = (await getAll()).rejected || {};
      if (rejected[appId]) return res.json({ ok: false, reason: "rejected" });
      // add game with mode and mark added=true (auto approved as per user request)
      const added = await addGame(appId, mode || 0, true);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, game: added });
    } catch (e) {
      console.error(e);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ADMIN actions (require header x-admin-pass)
  if (req.url.startsWith("/api/admin/")) {
    const pass = req.headers["x-admin-pass"] || req.query?.admin_pass || "";
    const correct = await getAdminPass();
    if (pass !== correct) return res.status(401).json({ ok: false, error: "unauthorized" });

    // GET /api/admin/state
    if (req.url.startsWith("/api/admin/state")) {
      const state = await getAll();
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true, state });
    }
    // POST /api/admin/ban { ip }
    if (req.url.startsWith("/api/admin/ban") && req.method === "POST") {
      const body = await jsonBody(req);
      await banIp(body.ip);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true });
    }
    // POST /api/admin/unban { ip }
    if (req.url.startsWith("/api/admin/unban") && req.method === "POST") {
      const body = await jsonBody(req);
      await unbanIp(body.ip);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true });
    }
    // POST /api/admin/reject { appId }
    if (req.url.startsWith("/api/admin/reject") && req.method === "POST") {
      const body = await jsonBody(req);
      await addRejected(body.appId);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true });
    }
    // POST /api/admin/unreject { appId }
    if (req.url.startsWith("/api/admin/unreject") && req.method === "POST") {
      const body = await jsonBody(req);
      await removeRejected(body.appId);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true });
    }
    // POST /api/admin/setadded { appId, added }
    if (req.url.startsWith("/api/admin/setadded") && req.method === "POST") {
      const body = await jsonBody(req);
      await setGameAdded(body.appId, !!body.added);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({ ok: true });
    }

    return res.status(404).json({ ok: false, error: "admin route not found" });
  }

  // fallback
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(404).json({ ok: false, error: "unknown route" });
}

// helpers
function normalizeIp(ip) {
  if (!ip) return "unknown";
  return ip.replace(/^::ffff:/, "");
}
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", chunk => s += chunk);
    req.on("end", () => {
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// convenience res.json for serverless env
Object.defineProperty(Object.prototype, "json", {
  value: function (obj) {
    this.setHeader("Content-Type", "application/json");
    this.end(JSON.stringify(obj));
  },
  enumerable: false
});
