"use strict";

/* 原生能力层：显卡偏好（浏览器不提供 API）与 media-bridge 服务管理。
   所有操作都走本地原生消息宿主 com.we.newtab.gpu，失败时静默降级。 */

/* ---------------- 浏览器与显卡 ---------------- */

const GPU_HOST = "com.we.newtab.gpu";

let rendererCache = null;

// 当前 WebGL 渲染器名（只取一次）
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

/* ---------------- 原生消息通道 ---------------- */

// 与本地宿主通信：浏览器不提供修改显卡偏好的 API，只能走原生消息
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
        /* 已断开 */
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

// 让按钮状态与系统里实际写入的偏好一致（切换后立即回填，重启后也一致）
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

// 读取显卡偏好并刷新 UI
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

// 写入显卡偏好
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

// 下载原生宿主安装包
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

// 绑定显卡相关按钮
function bindGpu() {
  $("gpuHigh").addEventListener("click", () => setGpu(2));
  $("gpuLow").addEventListener("click", () => setGpu(1));
  $("gpuAuto").addEventListener("click", () => setGpu(0));
  $("gpuDownload").addEventListener("click", downloadInstaller);
  $("gpuRetry").addEventListener("click", () => refreshGpu());
  refreshGpu();
}

/* ---------------- media-bridge 服务 ---------------- */

// 桥的基地址
function bridgeBase() {
  return `http://127.0.0.1:${Math.max(1, Number(state.settings.bridgePort) || 8765)}`;
}

// 拉一次 /v1/now
async function bridgeNow() {
  const res = await Promise.race([
    fetch(`${bridgeBase()}/v1/now`, { cache: "no-store" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("超时")), 1500)),
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let bridgeCheckedAt = 0;

// 同步桥运行状态与自启状态
async function syncBridge(autoStart, force) {
  if (!force && Date.now() - bridgeCheckedAt < 10000) return;
  bridgeCheckedAt = Date.now();
  try {
    const now = await bridgeNow();
    const track = now?.track;
    $("bridgeState").textContent = now?.hasMedia
      ? `服务运行中：${track?.title || "未知曲目"}${track?.artist ? " - " + track.artist : ""}`
      : "服务运行中，当前没有正在播放的媒体";
  } catch {
    $("bridgeState").textContent = autoStart
      ? "服务未运行：点「启动 media-bridge」，或勾选开机自启"
      : "服务未运行：点「启动 media-bridge」";
  }
  try {
    const res = await nativeRequest({ cmd: "bridge-status" });
    $("bridgeAuto").checked = !!res.autostart;
  } catch {
    $("bridgeAuto").checked = false;
  }
}

// 通过宿主启动 media-bridge
async function startBridgeService() {
  $("bridgeState").textContent = "正在启动…";
  try {
    const res = await nativeRequest({ cmd: "bridge-start", port: state.settings.bridgePort });
    if (res.ok) {
      await new Promise((r) => setTimeout(r, 1200));
      await syncBridge(false, true);
      if (state.settings.audioSource === "bridge") applyAudioSource();
    } else {
      $("bridgeState").textContent = `启动失败：${res.error || "未知原因"}`;
    }
  } catch (error) {
    $("bridgeState").textContent = `启动失败：${error.message || error}（需要先安装辅助程序）`;
  }
}

// 设置 / 取消开机自启
async function toggleBridgeAutostart() {
  const enabled = $("bridgeAuto").checked;
  try {
    const res = await nativeRequest({ cmd: "bridge-autostart", enabled, port: state.settings.bridgePort });
    $("bridgeState").textContent = res.ok
      ? enabled
        ? "已加入开机启动（登录后自动运行）"
        : "已取消开机启动"
      : `设置失败：${res.error || "未知原因"}`;
  } catch (error) {
    $("bridgeAuto").checked = !enabled;
    $("bridgeState").textContent = `设置失败：${error.message || error}（需要先安装辅助程序）`;
  }
}
