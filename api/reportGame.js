const { addGame, getAll } = require("./lib.js");
const { jsonBody, setCorsHeaders, runCleanup, sendJson } = require("./_utils.js");

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return res.end();

    await runCleanup();

    try {
        const body = await jsonBody(req);
        const { appId, mode } = body;

        if (!appId) {
            return sendJson(res, { ok: false, error: "missing appId" }, 400);
        }

        const all = await getAll();
        if (all.rejected?.[appId]) {
            return sendJson(res, { ok: false, reason: "rejected" });
        }

        const games = all.games || {};
        if (games[appId]) {
            return sendJson(res, { ok: true, game: games[appId] });
        }

        const added = await addGame(appId, mode);
        return sendJson(res, { ok: true, game: added });

    } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 500);
    }
};
