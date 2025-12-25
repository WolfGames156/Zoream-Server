const { cleanupExpired, getAdminPass } = require("./lib.js");

function normalizeIp(ip) {
    if (!ip) return "unknown";
    if (Array.isArray(ip)) ip = ip[0];
    if (typeof ip === "string" && ip.includes(",")) ip = ip.split(",")[0].trim();
    return ip.replace(/^::ffff:/, "");
}

function jsonBody(req) {
    return new Promise((resolve, reject) => {
        let s = "";
        req.on("data", chunk => (s += chunk));
        req.on("end", () => {
            if (!s) return resolve({});
            try {
                resolve(JSON.parse(s));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-pass");
}

async function verifyAdmin(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pass =
        req.headers["x-admin-pass"] ||
        url.searchParams.get("admin_pass") ||
        "";
    const correct = await getAdminPass();
    return pass === correct;
}

async function runCleanup() {
    const now = Date.now();
    if (!global._lastCleanup || now - global._lastCleanup > 300000) {
        global._lastCleanup = now;
        await cleanupExpired(300);
    }
}

function sendJson(res, obj, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
}

function getIp(req) {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    return normalizeIp(ip);
}

module.exports = {
    normalizeIp,
    jsonBody,
    setCorsHeaders,
    verifyAdmin,
    runCleanup,
    sendJson,
    getIp
};
