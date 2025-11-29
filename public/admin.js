// public/admin.js
const adminPassKey = "zoreamserver156_sys0xa7";
const storePass = (p) => { sessionStorage.setItem(adminPassKey, p) };
const getPass = () => sessionStorage.getItem(adminPassKey) || "";

document.getElementById("loginBtn").addEventListener("click", async () => {
  const p = document.getElementById("adminPass").value || "";
  storePass(p);
  const ok = await testAuth();
  document.getElementById("authMsg").innerText = ok ? "Giriş başarılı" : "Giriş Hatalı";
  if (ok) showPanel();
});

async function testAuth() {
  const p = getPass();
  const r = await fetch(`/api/admin/state?admin_pass=${encodeURIComponent(p)}`);
  const j = await r.json();
  return j.ok;
}

async function showPanel() {
  document.getElementById("auth").style.display = "none";
  document.getElementById("panel").style.display = "block";
  loadState();
  setInterval(loadState, 8000);
}

async function loadState() {
  const p = getPass();
  const r = await fetch(`/api/admin/state?admin_pass=${encodeURIComponent(p)}`);
  const j = await r.json();
  if (!j.ok) {
    document.getElementById("stateBox").innerText = "Yetkisiz veya hata";
    return;
  }
  document.getElementById("stateBox").innerText = JSON.stringify(j.state, null, 2);
}

async function postAdmin(path, body) {
  const p = getPass();
  const r = await fetch(`/api/admin/${path}?admin_pass=${encodeURIComponent(p)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

document.getElementById("banBtn").addEventListener("click", async () => {
  const ip = document.getElementById("banIpInput").value.trim();
  await postAdmin("ban", { ip });
  loadState();
});
document.getElementById("unbanBtn").addEventListener("click", async () => {
  const ip = document.getElementById("banIpInput").value.trim();
  await postAdmin("unban", { ip });
  loadState();
});
document.getElementById("rejectBtn").addEventListener("click", async () => {
  const appId = document.getElementById("rejectAppInput").value.trim();
  await postAdmin("reject", { appId });
  loadState();
});
document.getElementById("unrejectBtn").addEventListener("click", async () => {
  const appId = document.getElementById("rejectAppInput").value.trim();
  await postAdmin("unreject", { appId });
  loadState();
});
document.getElementById("setAddedBtn").addEventListener("click", async () => {
  const appId = document.getElementById("setAddedApp").value.trim();
  await postAdmin("setadded", { appId, added: true });
  loadState();
});
