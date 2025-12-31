const { addRejected } = require("../lib.js");
const { verifyAdmin, setCorsHeaders, jsonBody, sendJson, runCleanup, updateUI } = require("../_utils.js");

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return res.end();

    await runCleanup();

    if (!(await verifyAdmin(req))) {
        return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    }

    try {
        const body = await jsonBody(req);
        await addRejected(body.appId);
        updateUI();
        return sendJson(res, { ok: true });
    } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 500);
    }
};
