// public/app.js
const API = "/api/track";
const CLIENT_KEY = "vc_client_id_v1";
function genId() {
  return 'c_' + Math.random().toString(36).slice(2, 12);
}
const clientId = localStorage.getItem(CLIENT_KEY) || (() => { const id = genId(); localStorage.setItem(CLIENT_KEY, id); return id; })();

async function ping(appId) {
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, appId })
    });
    return r.json();
  } catch (e) {
    console.error(e);
    return null;
  }
}

async function updateUI() {
  const resp = await ping(); // send periodic ping w/o appId
  if (!resp) return;
  document.getElementById("activeCount").innerText = resp.activeCount || 0;
  document.getElementById("ipList").innerText = (resp.activeIps || []).join(", ") || "-";
}

document.getElementById("checkBtn").addEventListener("click", async () => {
  const appId = document.getElementById("appId").value.trim();
  if (!appId) return alert("App ID gir");
  // First ping to see if server knows the game
  const resp = await ping(appId);
  if (!resp) return alert("Sunucuya bağlanamadı");
  const extra = resp.extra || {};
  const resultEl = document.getElementById("gameResult");
  if (extra.gameStatus === "rejected") {
    resultEl.innerText = "Bu oyun reddedilmiş (panelde göremezsin).";
    return;
  }
  if (extra.gameStatus === "known") {
    const modeLabel = (extra.game && extra.game.mode === 1) ? 'Online bypass' : 'lua manifest';
    resultEl.innerText = `Oyun zaten kayıtlı. Mode: ${modeLabel}`;
    return;
  }
  // unknown -> client should determine mode (0 or 1)
  // Here we ask user: simulate check: prompt for mode
  const mode = prompt("Sunucu oyunu bilmiyor. Bu oyun için mod (0 = lua manifest, 1 = online bypass) gir (0/1):", "0");
  if (mode === null) return;
  const parsed = Number(mode) === 1 ? 1 : 0;
  // send report
  const r2 = await fetch("/api/reportGame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, mode: parsed })
  });
  const j2 = await r2.json();
  if (j2.ok) {
    resultEl.innerText = "Oyun bildirildi. Admin panelinde onay bekliyor.";
  } else {
    resultEl.innerText = "Bildirilemedi: " + (j2.reason || j2.error || JSON.stringify(j2));
  }
});

// auto update every 15s, also immediately
updateUI();
setInterval(updateUI, 15000);
