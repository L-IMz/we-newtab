/* 设置面板：设置项绑定、壁纸列表、属性面板与服务状态展示。 */
"use strict";

function setPanelOpen(open) {
  const panel = $("panel");
  const willOpen = open === undefined ? !panel.classList.contains("open") : open;
  panel.classList.toggle("open", willOpen);
  if (!willOpen) return;
  refreshGpu();
  syncBridge();
  syncCollapses();
  syncRatingFilter();

  requestAnimationFrame(() => {
    alignAllWallLists();
    setTimeout(alignAllWallLists, 120);
  });
}

let statusTimer = 0;

function status(text) {
  const el = $("status");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.hidden = true), 2000);
}

function notice(text) {
}

function reportError(error) {
  console.error("[error]", error?.message || error);
}

function renderRoots() {
  const box = $("roots");
  box.textContent = "";
  const roots = state.hostRoots || [];
  if (!roots.length) {
    const tip = document.createElement("p");
    tip.className = "hint";
    tip.textContent = "宿主尚未发现壁纸目录。";
    box.appendChild(tip);
    return;
  }
  for (const path of roots) {
    const row = document.createElement("div");
    row.className = "root";
    const name = document.createElement("span");
    name.textContent = path;
    name.title = path;
    row.appendChild(name);
    box.appendChild(row);
  }
}

let volumeSaveTimer = 0;

const NUMERIC_SETTINGS = new Set([
  "fps", "dpr", "brightness", "volume", "rotateEvery", "bridgePort",
  "hitokotoSize", "clockSize", "clockWeight", "clockX", "clockY", "occludeThreshold",
]);

function syncRatingFilter() {
  const allow = ratingAllowSet();
  document.querySelectorAll(".ratingFilter").forEach((el) => {
    el.checked = allow.has(el.value);
  });
}

function bindRatingFilter() {
  syncRatingFilter();
  document.querySelectorAll(".ratingFilter").forEach((el) => {
    el.addEventListener("change", async () => {
      const picked = [...document.querySelectorAll(".ratingFilter")].filter((x) => x.checked).map((x) => x.value);
      state.settings.ratingFilter = picked.length ? picked : ["everyone"];
      saveSettings();
      await renderWalls();
      scheduleRotation();
    });
  });
}

function syncCollapse(sectionId, buttonId, textId, settingKey, title) {
  const section = $(sectionId);
  const btn = $(buttonId);
  if (!section || !btn) return;
  const collapsed = !!state.settings[settingKey];
  section.classList.toggle("collapsed", collapsed);
  const text = $(textId);
  if (text) text.textContent = collapsed ? "展开" : "收起";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.title = (collapsed ? "展开" : "收起") + title;
}

function bindCollapse(sectionId, buttonId, textId, settingKey, title) {
  const btn = $(buttonId);
  if (!btn) return;
  syncCollapse(sectionId, buttonId, textId, settingKey, title);
  btn.addEventListener("click", () => {
    state.settings[settingKey] = !state.settings[settingKey];
    saveSettings();
    syncCollapse(sectionId, buttonId, textId, settingKey, title);
  });
}

function syncPropsCollapse() {
  syncCollapse("propsSection", "propsToggle", "propsToggleText", "propsCollapsed", "壁纸自带设置");
  const count = $("propsCount");
  if (count) count.textContent = String(document.querySelectorAll("#props .prop").length);
}

function bindPropsCollapse() {
  const btn = $("propsToggle");
  if (!btn) return;
  syncPropsCollapse();
  btn.addEventListener("click", () => {
    state.settings.propsCollapsed = !state.settings.propsCollapsed;
    saveSettings();
    syncPropsCollapse();
  });
}

const COLLAPSES = [
  ["extSection", "extToggle", "extToggleText", "extSettingsCollapsed", "扩展自带设置"],
  ["timeSection", "timeToggle", "timeToggleText", "timeCollapsed", "时间显示"],
  ["hitokotoSection", "hitokotoToggle", "hitokotoToggleText", "hitokotoCollapsed", "一言显示"],
  ["serviceSection", "serviceToggle", "serviceToggleText", "serviceCollapsed", "本地服务"],
];

function syncCollapses() {
  syncPropsCollapse();
  for (const args of COLLAPSES) syncCollapse(...args);
}

function bindSettings() {
  applyClock();

  const map = {
    fps: "fps", dpr: "dpr", aa: "aa", particles: "particles", post: "post",
    fit: "fit", rate: "rate", scripts: "scripts", audioSource: "audioSource", bridgePort: "bridgePort",
    parallax: "parallax", monet: "monet",
    brightness: "brightness", volume: "volume", audioEnabled: "audioEnabled", rotate: "rotate",
    rotateEvery: "rotateEvery", rotateRandom: "rotateRandom",
    occludePause: "occludePause", occludeThreshold: "occludeThreshold",
    hitokotoShow: "hitokotoShow", hitokotoSize: "hitokotoSize", hitokotoFont: "hitokotoFont",
    clockShow: "clockShow", clockSize: "clockSize", clockWeight: "clockWeight", clockFont: "clockFont", clockX: "clockX", clockY: "clockY",
  };

  for (const [key, id] of Object.entries(map)) {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!state.settings[key];
    else el.value = String(state.settings[key]);
    el.addEventListener(el.type === "range" || el.type === "checkbox" ? "input" : "change", async () => {
      state.settings[key] = el.type === "checkbox" ? el.checked : el.value;
      if (NUMERIC_SETTINGS.has(key)) state.settings[key] = Number(state.settings[key]) || 0;
      if (key === "rate") {
        state.settings.rate = Number(state.settings.rate) || 1;
        vid.playbackRate = state.settings.rate;
      }
      if (key === "occludeThreshold") {
        const label = $("occludeVal");
        if (label) label.textContent = `${state.settings.occludeThreshold}%`;
      }
      if (key === "fit") applyFit();
      if (key === "parallax") {

        const pkey = state.parallaxPropKey;
        if (pkey && state.propValues) {
          state.propValues[pkey] = state.settings.parallax;
          propView?.refresh(state.propValues);
          pushProps(state.propValues);

          await saveWallProps(propWallId, state.propValues);
          state.parallaxDirty = false;
        }
        remountScene();
      }
      if (key === "monet") applyMonet();
      if (key.startsWith("hitokoto")) renderHitokoto();
      if (key.startsWith("clock")) applyClock();
      if (key === "brightness") applyBrightness();
      if (key === "audioEnabled") applyVolume();
      if (key === "volume") {
        applyVolume();
        clearTimeout(volumeSaveTimer);
        volumeSaveTimer = setTimeout(() => saveSettings(), 150);
        return;
      }
      if (key === "rotate" || key === "rotateEvery" || key === "rotateRandom") scheduleRotation();
      if (key === "audioSource" || key === "bridgePort") applyAudioSource();
      if (key === "dpr") state.effectiveDpr = null;
      saveSettings();
      applyLiveSettings();
    });
  }

}

function applyFit() {
  const map = { cover: "cover", contain: "contain", stretch: "fill" };
  vid.style.objectFit = map[state.settings.fit] || "cover";
  img.style.objectFit = map[state.settings.fit] || "cover";

  webFrame.contentWindow?.postMessage({ __weFit: { mode: state.settings.fit } }, "*");
}

const DPR_LADDER = [2, 1.5, 1, 0.75, 0.5];
let lowFpsTicks = 0;

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
    notice(`帧率偏低（${state.fps} FPS），已自动降到 ${next}× 渲染分辨率`);
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
  $("gear").addEventListener("click", () => setPanelOpen());
  $("close").addEventListener("click", () => setPanelOpen(false));
  $("rescan").addEventListener("click", () => rescan(true).catch(reportError));
  $("bridgeScanPort").addEventListener("click", async () => {
    const scan = await bridgePortScan();
    if (scan && scan.port) {
      state.settings.bridgePort = scan.port;
      $("bridgePort").value = String(scan.port);
      saveSettings();
      notice(`发现 media-bridge 端口 ${scan.port}`);
      await syncBridge(true);
    } else {
      notice("未发现运行中的 media-bridge 端口（8765–8772）");
    }
  });
  $("openWorkshop").addEventListener("click", openSteamWorkshop);
  $("clockImport").addEventListener("click", () => $("clockFile").click());
  $("clockFile").addEventListener("change", (event) => importClockFont(event.target.files?.[0]));
  $("clockClear").addEventListener("click", () => clearClockFont().catch(reportError));
  $("hitokotoImport").addEventListener("click", () => $("hitokotoFile").click());
  $("hitokotoFile").addEventListener("change", (event) => importHitokotoFont(event.target.files?.[0]));
  $("hitokotoClear").addEventListener("click", () => clearHitokotoFont().catch(reportError));
  $("hitokotoNext").addEventListener("click", () => renderHitokoto(true));
  bindGpu();
  bindRatingFilter();
  bindPropsCollapse();
  for (const args of COLLAPSES) bindCollapse(...args);

  $("addRoot").addEventListener("click", async () => {
    const path = prompt("输入壁纸根目录绝对路径（Steam 库或 WE projects 上级目录）");
    if (!path) return;
    const res = await nativeRequest({ cmd: "add-root", path });
    if (!res || !res.ok) return notice(res && res.error ? res.error : "添加失败");
    notice(`已添加目录：${res.path}`);
    await rescan(true);
  });
}

let idleTimer = 0;

function startIdle() {
  const wake = () => {
    document.body.classList.remove("bare");
    clearTimeout(idleTimer);
    if ($("panel").classList.contains("open")) return;
    idleTimer = setTimeout(() => {
      document.body.classList.add("bare");
    }, 4000);
  };
  for (const ev of ["mousemove", "keydown", "mousedown", "wheel"]) window.addEventListener(ev, wake, { passive: true });
  wake();
}
