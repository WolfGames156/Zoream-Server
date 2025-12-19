const { trackVisit, getAll, getAdminPass } = require("./lib.js");
const { jsonBody, setCorsHeaders, runCleanup, sendJson, getIp } = require("./_utils.js");

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
    }

    await runCleanup();

    try {
        const ip = getIp(req);
        const body = req.method === "POST" ? await jsonBody(req) : {};
        const clientId = body.clientId || req.headers["x-client-id"] || null;
        const username = body.username || body.discord || body.name || null;

        const result = await trackVisit(ip, clientId, username);

        const url = new URL(req.url, `http://${req.headers.host}`);
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

        if (!isAdmin && result && typeof result === 'object') {
            delete result.activeIps;
        }

        return sendJson(res, { ok: true, ip, ...result, extra });
    } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 500);
    }
}
