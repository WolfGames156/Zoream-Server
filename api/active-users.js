const { trackVisit, cleanupExpired, getAll } = require("./lib.js");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // POST: accept an optional { ip, clientId } ping from Electron
  if (req.method === "POST") {
    try {
      const body = await jsonBody(req);
      const ip = body.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
      const clientId = body.clientId || null;
      await trackVisit(normalizeIp(ip), clientId);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET: return current active users derived from authoritative KV state
  if (req.method === "GET") {
    try {
      // cleanup stale entries first (default 300s)
      await cleanupExpired(300);
      const state = await getAll();
      const active = state.active || {};
      const banned = state.banned || {};

      // Filter out banned IPs
      const activeIps = Object.keys(active).filter(ip => !banned[ip]);

      // compute unique clients if available
      const uniqueClients = new Set();
      for (const ip of activeIps) {
        const ids = active[ip].clientIds || {};
        for (const id of Object.keys(ids)) uniqueClients.add(id);
      }
      const count = uniqueClients.size || activeIps.length;
      return res.status(200).json({ active: count, activeIps });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).json({ error: "Method Not Allowed" });
};

function normalizeIp(ip) {
  if (!ip) return "unknown";
  return String(ip).replace(/^::ffff:/, "");
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => s += c);
    req.on("end", () => { if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
