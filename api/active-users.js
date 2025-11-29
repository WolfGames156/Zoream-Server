const { kv } = require("@vercel/kv");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "POST") {
    // Electron uygulamasından ping atılıyor
    await kv.incr("active_users");
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const count = (await kv.get("active_users")) || 0;
    return res.status(200).json({ active: count });
  }

  res.status(405).json({ error: "Method Not Allowed" });
};
