/* 原生宿主桥：显卡偏好、本地网页服务、media-bridge 生命周期。 */
"use strict";

let webPortAt = 0;

async function ensureWebService(force) {
  if (!force && state.webPort && Date.now() - webPortAt < 30000) return state.webPort;
  try {
    const res = await nativeRequest({ cmd: "web-serve", roots: [] });
    if (res && res.ok && res.port) {
      state.webPort = res.port;
      webPortAt = Date.now();
      return res.port;
    }
  } catch {

  }
  state.webPort = 0;
  return 0;
}

const GPU_HOST = "com.we.newtab.gpu";

let rendererCache = null;

function rendererName() {
  if (rendererCache) return rendererCache;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return (rendererCache = "不可用");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "未知";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    rendererCache = name;
    return name;
  } catch {
    return (rendererCache = "未知");
  }
}

function nativeRequest(message) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(GPU_HOST);
    } catch (error) {
      reject(new Error("未安装辅助程序"));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {

      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("辅助程序无响应")), 5000);
    port.onMessage.addListener((res) => finish(resolve, res));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish(reject, new Error(err ? err.message : "辅助程序已退出"));
    });
    try {
      port.postMessage(message);
    } catch (error) {
      finish(reject, error);
    }
  });
}

const GPU_OPTIONS = [
  [2, "gpuHigh", "独显"],
  [1, "gpuLow", "核显"],
  [0, "gpuAuto", "自动"],
];

function applyGpuSelection(pref) {
  for (const [value, id] of GPU_OPTIONS) {
    const button = $(id);
    if (!button) continue;
    const active = Number(value) === Number(pref);
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

let gpuCheckedAt = 0;

async function refreshGpu(keepMessage) {
  $("gpuRenderer").textContent = `当前渲染器：${rendererName()}`;
  if (!keepMessage && Date.now() - gpuCheckedAt < 5000) return;
  gpuCheckedAt = Date.now();
  try {
    const res = await nativeRequest({ cmd: "status" });
    const browser = (res.browsers || [])[0];
    const pref = browser ? Number(browser.pref) : 0;
    state.gpuPref = pref;
    applyGpuSelection(pref);
    $("gpuState").textContent = pref === 2 ? "独显" : pref === 1 ? "核显" : "自动";
    $("gpuInstall").hidden = true;
    if (!keepMessage) $("gpuMsg").textContent = "";
  } catch (error) {
    state.gpuPref = null;
    applyGpuSelection(-1);
    $("gpuState").textContent = "未安装";
    $("gpuInstall").hidden = false;
    if (!keepMessage) $("gpuMsg").textContent = "";
  }
}

async function setGpu(pref) {
  try {
    const res = await nativeRequest({ cmd: "set", pref });
    if (!res.ok) {
      $("gpuMsg").textContent = res.error || "写入失败";
      return;
    }
    state.gpuPref = pref;
    applyGpuSelection(pref);
    $("gpuState").textContent = pref === 2 ? "独显" : pref === 1 ? "核显" : "自动";
    $("gpuMsg").textContent = "已写入系统设置，完全退出并重新打开浏览器后生效。";
    notice("显卡偏好已更新，重启浏览器后生效");
  } catch (error) {
    $("gpuMsg").textContent = `${error.message || error} —— 先安装辅助程序`;
    $("gpuInstall").hidden = false;
  }
}

async function downloadInstaller() {
  try {
    for (const name of ["install.ps1", "WeGpuHost.cs"]) {
      await chrome.downloads.download({
        url: chrome.runtime.getURL(`native/${name}`),
        filename: `we-newtab-gpu/${name}`,
        conflictAction: "overwrite",
      });
    }
    notice("已下载到「下载/we-newtab-gpu」：右键 install.ps1 → 使用 PowerShell 运行");
  } catch (error) {
    notice(`下载失败：${error.message || error}`);
  }
}

function bindGpu() {
  $("gpuHigh").addEventListener("click", () => setGpu(2));
  $("gpuLow").addEventListener("click", () => setGpu(1));
  $("gpuAuto").addEventListener("click", () => setGpu(0));
  $("gpuDownload").addEventListener("click", downloadInstaller);
  $("gpuRetry").addEventListener("click", () => refreshGpu());
  refreshGpu();
}

function bridgeBase() {
  return `http://127.0.0.1:${Math.max(1, Number(state.settings.bridgePort) || 8765)}`;
}

async function bridgeNow() {
  const res = await Promise.race([
    fetch(`${bridgeBase()}/v1/now`, { cache: "no-store" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("超时")), 1500)),
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let bridgeCheckedAt = 0;

// 其它窗口对浏览器标签页的遮挡（宿主演算并集面积，返回 0–1 覆盖率）
// 宿主侧壁纸扫描（Steam / WE projects），失败返回 null 交给 FSA 回退
async function videoPrepare(hostId, path, fps) {
  try {
    return await nativeRequest({ cmd: "video-prepare", id: hostId, path, fps });
  } catch {
    return { ok: false };
  }
}

async function bridgePortScan() {
  try {
    return await nativeRequest({ cmd: "bridge-port-scan" });
  } catch {
    return { ok: false, ports: [], port: 0 };
  }
}

async function scanWalls() {
  try {
    const res = await nativeRequest({ cmd: "wall-scan" });
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}

async function windowCoverage(rect) {
  try {
    return await nativeRequest({
      cmd: "window-coverage",
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      dpr: window.devicePixelRatio || 1,
    });
  } catch {
    return { ok: false };
  }
}

async function syncBridge(force) {
  if (!force && Date.now() - bridgeCheckedAt < 10000) return;
  bridgeCheckedAt = Date.now();
  if (await dshAvailable()) {
    $("bridgeState").textContent = "与 DSH 共用 media-bridge";
    return;
  }
  let status = null;
  try {
    status = await nativeRequest({ cmd: "bridge-status", port: state.settings.bridgePort, path: state.settings.bridgePath });
  } catch {
    status = null;
  }
  const others = Number(status?.others) || 0;
  try {
    const now = await bridgeNow();
    const track = now?.track;
    const base = now?.hasMedia
      ? `运行中：${track?.title || "未知曲目"}${track?.artist ? " - " + track.artist : ""}`
      : "运行中，当前没有正在播放的媒体";
    $("bridgeState").textContent = others > 0 ? `${base} · 另有 ${others} 个其它实例（可能是 DSH 插件）` : base;
  } catch {
    $("bridgeState").textContent =
      others > 0 ? `未运行（检测到 ${others} 个其它 media-bridge，可能被 DSH 等占用）` : "未运行";
  }
}

async function startBridgeService() {
  $("bridgeState").textContent = "正在启动…";
  try {
    const res = await nativeRequest({ cmd: "bridge-start", port: state.settings.bridgePort });
    if (!res.ok) {
      $("bridgeState").textContent = `启动失败：${res.error || "未知原因"}`;
      return false;
    }
    await new Promise((r) => setTimeout(r, 1200));
    await syncBridge(true);
    if (state.settings.audioSource === "bridge") applyAudioSource();
    return true;
  } catch (error) {
    $("bridgeState").textContent = `启动失败：${error.message || error}（需要先安装辅助程序）`;
    return false;
  }
}

let bridgeHealthTimer = 0;

async function dshAvailable() {
  try {
    const port = state.webPort || 43197;
    const res = await fetch(`http://127.0.0.1:${port}/dsh/spectrum`, { cache: "no-store" });
    if (!res.ok) return false;
    const json = await res.json();
    // 关键：DSH 在 media-bridge 未起来时会回 legacy，仍返回 64 个 0 且 running=false。
    // 只有 running=true 才算真正可共用，否则必须启动本机桥，不能把静音当成可用。
    return Boolean(json && json.ok !== false && json.running === true && Array.isArray(json.bands));
  } catch {
    return false;
  }
}

async function superviseBridge() {
  try {
    if (await dshAvailable()) {
      await nativeRequest({ cmd: "bridge-stop" }).catch(() => {});
      $("bridgeState").textContent = "与 DSH 共用 media-bridge";
      return;
    }
    const status = await nativeRequest({ cmd: "bridge-status", port: state.settings.bridgePort });
    if (status && status.running) return;
    await startBridgeService();
  } catch {
    /* 忽略 */
  }
}

async function applyLocalServices() {
  await ensureWebService(true);
  if (await dshAvailable()) {
    // DSH 的 media-bridge 确实在跑：共用；只停自己 PID 的实例
    await nativeRequest({ cmd: "bridge-stop" }).catch(() => {});
    $("bridgeState").textContent = "与 DSH 共用 media-bridge";
  } else {
    // 先扫描本机已存在的 media-bridge 端口，能复用就不重开
    const scan = await bridgePortScan();
    if (scan && scan.port) {
      state.settings.bridgePort = scan.port;
      saveSettings();
      const input = $("bridgePort");
      if (input) input.value = String(scan.port);
      await syncBridge(true);
    } else {
      await startBridgeService();
    }
  }
  await syncBridge(true);
  if (!bridgeHealthTimer) bridgeHealthTimer = setInterval(superviseBridge, 30000);
  const web = state.webPort ? `网页壁纸 127.0.0.1:${state.webPort}` : "网页壁纸未启用";
  $("serviceState").textContent = `${web} · media-bridge 后台常驻`;
  $("bridgeState").hidden = false;
  syncBridge();
}

async function cleanLegacyAutostart() {
  try {
    const done = await chrome.storage.local.get("legacyAutostartCleaned");
    if (done.legacyAutostartCleaned) return;
    await nativeRequest({ cmd: "autostart-clean" });
    await chrome.storage.local.set({ legacyAutostartCleaned: true });
  } catch {

  }
}
