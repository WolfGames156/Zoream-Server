import { kv } from "@vercel/kv";

export default async function handler(req, res) {
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
}
