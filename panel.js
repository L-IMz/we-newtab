"use strict";

/* 设置面板：选项卡、控件绑定、显卡偏好、空状态 */

/* ---------------- 面板选项卡 ---------------- */

// 两个大选项卡：壁纸 / 自定义。切到自定义时主视图换成组件面板。
function setTab(tab) {
  const next = tab === "custom" ? "custom" : "wall";
  state.tab = next;
  $("tabWall").hidden = next !== "wall";
  $("tabCustom").hidden = next !== "custom";
  for (const button of document.querySelectorAll("#panelTabs button")) {
    button.classList.toggle("on", button.dataset.tab === next);
  }
  boardSetVisible(next === "custom");
  chrome.storage.local.set({ tab: next });
}

// 打开设置面板时切到「壁纸」页；关闭时也回到壁纸页，避免停留在自定义页出不来
function setPanelOpen(open, tab) {
  const panel = $("panel");
  const willOpen = open === undefined ? !panel.classList.contains("open") : open;
  panel.classList.toggle("open", willOpen);

  if (willOpen) {
    if (tab) setTab(tab);
    refreshGpu();
    // 面板刚展开时布局才可测，补一次行高对齐
    requestAnimationFrame(() => {
      alignAllWallLists();
      // 滚动条出现后列宽会变，第二次对齐才准
      setTimeout(alignAllWallLists, 120);
    });
  } else {
    setTab("wall");
  }
}

function bindPanelTabs() {
  for (const button of document.querySelectorAll("#panelTabs button")) {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  }
  $("gear").addEventListener("click", () => setPanelOpen());
  $("close").addEventListener("click", () => setPanelOpen(false));
}
/* ---------------- 显卡偏好 ---------------- */

const GPU_HOST = "com.we.newtab.gpu";

function rendererName() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return "不可用";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "未知";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "未知";
  }
}

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

async function refreshGpu(keepMessage) {
  $("gpuRenderer").textContent = `当前渲染器：${rendererName()}`;
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
    status("显卡偏好已更新，重启浏览器后生效");
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
    status("已下载到「下载/we-newtab-gpu」：右键 install.ps1 → 使用 PowerShell 运行");
  } catch (error) {
    status(`下载失败：${error.message || error}`);
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
/* ---------------- UI ---------------- */

let statusTimer = 0;
function status(text) {
  const el = $("status");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.hidden = true), 5200);
}

function reportError(error) {
  status(String(error?.message || error));
}

function renderRoots() {
  const box = $("roots");
  box.textContent = "";
  if (!state.roots.length) {
    const tip = document.createElement("p");
    tip.className = "hint";
    tip.textContent = "尚未添加目录。";
    box.appendChild(tip);
    return;
  }
  state.roots.forEach((item, index) => {
    const { handle, label } = rootEntry(item);
    if (!handle) return;
    const row = document.createElement("div");
    row.className = "root";

    const name = document.createElement("span");
    name.textContent = label || handle.name;
    name.title = label || handle.name;
    row.appendChild(name);

    const grant = document.createElement("button");
    grant.textContent = "授权";
    grant.addEventListener("click", async () => {
      const ok = await ensurePermission(handle);
      status(ok ? `${label || handle.name} 已授权` : `${label || handle.name} 未授权`);
      await rescan();
    });
    row.appendChild(grant);

    const del = document.createElement("button");
    del.textContent = "移除";
    del.addEventListener("click", async () => {
      state.roots.splice(index, 1);
      await kvSet("roots", state.roots);
      renderRoots();
      await rescan();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

function bindSettings() {
  const map = {
    fps: "fps", dpr: "dpr", aa: "aa", particles: "particles", post: "post",
    fit: "fit", rate: "rate", scripts: "scripts", audioSource: "audioSource", bridgePort: "bridgePort",
    brightness: "brightness", volume: "volume", rotate: "rotate",
    rotateEvery: "rotateEvery", rotateRandom: "rotateRandom",
  };

  for (const [key, id] of Object.entries(map)) {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!state.settings[key];
    else el.value = String(state.settings[key]);
    el.addEventListener(el.type === "range" || el.type === "checkbox" ? "input" : "change", () => {
      state.settings[key] = el.type === "checkbox" ? el.checked : el.value;
      if (key === "fps" || key === "dpr" || key === "brightness" || key === "volume" || key === "rotateEvery" || key === "bridgePort")
        state.settings[key] = Number(state.settings[key]) || 0;
      if (key === "rate") {
        state.settings.rate = Number(state.settings.rate) || 1;
        vid.playbackRate = state.settings.rate;
      }
      if (key === "fit") applyFit();
      if (key === "brightness") applyBrightness();
      if (key === "volume") applyVolume();
      if (key === "rotate" || key === "rotateEvery" || key === "rotateRandom") scheduleRotation();
      if (key === "audioSource" || key === "bridgePort") applyAudioSource();
      if (key === "dpr")
        { state.effectiveDpr = null; }
      saveSettings();
      applyLiveSettings();
    });
  }

}

function applyFit() {
  const map = { cover: "cover", contain: "contain", stretch: "fill" };
  vid.style.objectFit = map[state.settings.fit] || "cover";
  img.style.objectFit = map[state.settings.fit] || "cover";
}

const DPR_LADDER = [2, 1.5, 1, 0.75, 0.5];
let lowFpsTicks = 0;

// 实测：场景壁纸的瓶颈几乎全在渲染分辨率（dpr 1→0.5 可让重场景从 ~12fps 升到 ~41fps），
// 关后处理/粒子几乎无收益。所以帧率持续偏低时只降分辨率。
function watchPerformance() {
  setInterval(() => {
    if (!state.current || state.current.type !== "scene" || !state.fps) return;
    const target = Number(state.settings.fps) || 30;
    if (state.fps >= target * 0.6) {
      lowFpsTicks = 0;
      return;
    }
    if (++lowFpsTicks < 3) return;
    lowFpsTicks = 0;

    const current = state.effectiveDpr ?? (Number(state.settings.dpr) || 1);
    const index = DPR_LADDER.findIndex((value) => value <= current + 0.01);
    const next = DPR_LADDER[Math.min(index + 1, DPR_LADDER.length - 1)];
    if (!next || next >= current) return;

    state.effectiveDpr = next;
    applyLiveSettings();
    status(`帧率偏低（${state.fps} FPS），已自动降到 ${next}× 渲染分辨率`);
  }, 2000);
}

function applyLiveSettings() {
  if (!state.sceneReady) return;
  const s = state.settings;
  sceneFrame.contentWindow?.postMessage(
    {
      t: "update",
      opts: {
        fps: Number(s.fps) || 60,
        dpr: state.effectiveDpr ?? (Number(s.dpr) || 0),
        fit: s.fit,
        quality: { antiAliasing: s.aa, particles: s.particles, postProcessing: s.post },
      },
    },
    "*"
  );
}

function bindPanel() {

  $("rescan").addEventListener("click", () => rescan().catch(reportError));
  bindGpu();
  initSources();


  $("addRoot").addEventListener("click", async () => {
    try {
      const picked = await window.showDirectoryPicker({ mode: "read", id: "we-roots" });
      if (!(await ensurePermission(picked))) return status("未获得目录读取权限");

      // 选中的可能是 Steam 库、WE 安装目录，或壁纸目录本身：先识别真实布局
      const detected = await detectRoots(picked);
      const additions = detected.length ? detected : [{ handle: picked, label: picked.name }];

      let added = 0;
      for (const candidate of additions) {
        let exists = false;
        for (const item of state.roots) {
          try {
            if (await rootEntry(item).handle.isSameEntry(candidate.handle)) {
              exists = true;
              break;
            }
          } catch {
            /* 句柄失效，忽略 */
          }
        }
        if (!exists) {
          state.roots.push(candidate);
          added++;
        }
      }

      await kvSet("roots", state.roots);
      renderRoots();
      startWatcher();
      await rescan();
      if (detected.length) status(`已识别并添加 ${added} 个壁纸目录`);
    } catch (error) {
      if (error?.name !== "AbortError") reportError(error);
    }
  });
}

function startClock() {
  const time = $("time");
  const date = $("date");
  const paint = () => {
    const now = new Date();
    time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    date.textContent = now.toLocaleDateString("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  };
  paint();
  setInterval(paint, 15000);
}

let idleTimer = 0;
function startIdle() {
  const wake = () => {
    document.body.classList.remove("bare");
    clearTimeout(idleTimer);
    if ($("panel").classList.contains("open") || state.tab === "custom") return;
    idleTimer = setTimeout(() => {
      if (state.tab !== "custom") document.body.classList.add("bare");
    }, 4000);
  };
  for (const ev of ["mousemove", "keydown", "mousedown", "wheel"]) window.addEventListener(ev, wake, { passive: true });
  wake();
}
