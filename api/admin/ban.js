const { banIp, banIps } = require("../lib.js");
const { verifyAdmin, setCorsHeaders, jsonBody, sendJson, runCleanup } = require("../_utils.js");

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return res.end();

    await runCleanup();

    if (!(await verifyAdmin(req))) {
        return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    }

    try {
        const body = await jsonBody(req);
        if (body.ips && Array.isArray(body.ips)) {
            await banIps(body.ips);
        } else {
            await banIp(body.ip);
        }
        if (global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
        return sendJson(res, { ok: true });
    } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 500);
    }
};
