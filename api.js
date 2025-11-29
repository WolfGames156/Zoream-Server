const fetch = require('node-fetch');

// API URL - Vercel deployment adresiniz
const BASE_URL = "https://zoream-server.vercel.app/api";

/**
 * Genel API istek fonksiyonu
 */
async function callApi(endpoint, body = {}) {
    try {
        const url = `${BASE_URL}${endpoint}`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': body.clientId || ''
            },
            body: JSON.stringify(body)
        };

        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`API Error ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Zoream API Error (${endpoint}):`, error.message);
        return { ok: false, error: error.message };
    }
}

/**
 * Ziyaretçi takibi ve Active User ping'i.
 * @param {string} clientId - Benzersiz istemci ID'si (HWID veya UUID)
 * @param {string|null} appId - (Opsiyonel) O an çalıştırılan oyun ID'si
 */
async function trackVisit(clientId, appId = null) {
    return await callApi('/track', { clientId, appId });
}

/**
 * Yeni oyun raporlama (Otomatik ekleme için)
 * @param {string} appId - Oyunun Steam ID'si
 * @param {number} mode - 0: Lua Manifest, 1: Online Bypass
 */
async function reportGame(appId, mode = 0) {
    return await callApi('/reportGame', { appId, mode });
}

// ---------------------------------------------------------
// BACKGROUND PING SYSTEM (Worker Logic)
// ---------------------------------------------------------

let pingInterval = null;

/**
 * Arka planda her 60 saniyede bir sunucuya "Ben buradayım" sinyali gönderir.
 * Node.js Event Loop kullandığı için ana işlemi (Main Process) dondurmaz.
 * 
 * @param {string} clientId - İstemci ID'si
 */
function startActiveUserPing(clientId) {
    if (pingInterval) clearInterval(pingInterval);

    console.log('[Zoream] Active User Ping servisi başlatıldı.');

    // İlk ping'i hemen at
    trackVisit(clientId).then(res => {
        if (res.ok) console.log(`[Zoream] Connected. Active Users: ${res.activeCount}`);
    });

    // Her 60 saniyede bir ping at
    pingInterval = setInterval(() => {
        trackVisit(clientId).catch(() => { }); // Hataları yut, logu kirletmesin
    }, 60 * 1000);

    // Uygulama kapanırken interval'in process'i tutmasını engelle (opsiyonel)
    if (pingInterval.unref) pingInterval.unref();
}

/**
 * Ping servisini durdurur.
 */
function stopActiveUserPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
        console.log('[Zoream] Active User Ping servisi durduruldu.');
    }
}

module.exports = {
    trackVisit,
    reportGame,
    startActiveUserPing,
    stopActiveUserPing
};
