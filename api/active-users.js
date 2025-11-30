const { trackVisit, cleanupExpired, getAll } = require("./lib.js");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "POST") {
      const body = await jsonBody(req);
      const ip = body.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
      const clientId = body.clientId || null;

      await trackVisit(normalizeIp(ip), clientId);

      // Başarılı kayıt
      return res.status(200).json({ ok: true, ip: normalizeIp(ip), clientId });
    }

    if (req.method === "GET") {
      // Stale kayıtları temizle (default 300 saniye)
      await cleanupExpired(300);
      const state = await getAll();
      const active = state.active || {};
      const banned = state.banned || {};

      // Banlı IPleri filtrele
      const activeIps = Object.keys(active).filter(ip => !banned[ip]);

      // Benzersiz clientId sayısı
      const uniqueClients = new Set();
      for (const ip of activeIps) {
        const ids = active[ip].clientIds || {};
        for (const id of Object.keys(ids)) uniqueClients.add(id);
      }

      const count = activeIps.length;
      return res.status(200).json({ ok: true, active: count, activeIps });
    }

    // Method desteklenmiyor
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  } catch (e) {
    console.error("API handler error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

function normalizeIp(ip) {
  if (!ip) return "unknown";
  return String(ip).replace(/^::ffff:/, "");
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
