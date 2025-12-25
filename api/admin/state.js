const { getAll, getDbInfo } = require("../lib.js");
const { verifyAdmin, setCorsHeaders, runCleanup, sendJson, getIp } = require("../_utils.js");

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return res.end();

    await runCleanup();

    if (!(await verifyAdmin(req))) {
        return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    }

    const ip = getIp(req);
    const CACHE_SEC = Number(process.env.ADMIN_STATE_CACHE_SEC) || 5;
    const MIN_REQ_MS = Number(process.env.ADMIN_MIN_REQUEST_INTERVAL_MS) || 1000;

    if (!global._adminStateCache) global._adminStateCache = { ts: 0, data: null };
    if (!global._adminLastReq) global._adminLastReq = {};

    const nowReq = Date.now();
    const lastReq = global._adminLastReq[ip] || 0;

    if (nowReq - lastReq < MIN_REQ_MS && global._adminStateCache.data) {
        return sendJson(res, { ok: true, state: global._adminStateCache.data });
    }

    if (nowReq - global._adminStateCache.ts < CACHE_SEC * 1000 && global._adminStateCache.data) {
        global._adminLastReq[ip] = nowReq;
        return sendJson(res, { ok: true, state: global._adminStateCache.data });
    }

    try {
        const state = await getAll();
        const redisInfo = await getDbInfo();

        const response = { ...state };
        if (redisInfo) {
            response.dbInfo = redisInfo;
        }

        global._adminStateCache = { ts: Date.now(), data: response };
        global._adminLastReq[ip] = nowReq;

        return sendJson(res, { ok: true, state: response });

    } catch (e) {
        if (global._adminStateCache.data) {
            return sendJson(res, { ok: true, state: global._adminStateCache.data });
        }
        return sendJson(res, { ok: false, error: e.message }, 500);
    }
};
