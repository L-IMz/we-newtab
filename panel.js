"use strict";

/* 设置面板：开关动画、底部提示、目录列表与所有设置项绑定。
   原生能力（显卡/桥服务）在 native.js，时钟在 clock.js。 */

/* ---------------- 面板开关 ---------------- */

// 齿轮打开设置面板；关闭后主视图仍是壁纸
function setPanelOpen(open) {
  const panel = $("panel");
  const willOpen = open === undefined ? !panel.classList.contains("open") : open;
  panel.classList.toggle("open", willOpen);
  if (!willOpen) return;
  refreshGpu();
  syncBridge();
  // 面板刚展开时量不到行高，等一帧再对齐滚动区高度
  requestAnimationFrame(() => {
    alignAllWallLists();
    setTimeout(alignAllWallLists, 120);
  });
}

/* ---------------- UI ---------------- */

let statusTimer = 0;
// 底部只在切换壁纸时露一下名字，其它过程信息一律只进控制台
function status(text) {
  const el = $("status");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.hidden = true), 2000);
}

// 过程信息只进控制台
function notice(text) {
  console.log("[notice]", text);
}

// 错误只进控制台
function reportError(error) {
  console.error("[error]", error?.message || error);
}

// 渲染已授权目录列表
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
      notice(ok ? `${label || handle.name} 已授权` : `${label || handle.name} 未授权`);
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

// 绑定所有设置项
function bindSettings() {
  applyClock();

  const map = {
    fps: "fps", dpr: "dpr", aa: "aa", particles: "particles", post: "post",
    fit: "fit", rate: "rate", scripts: "scripts", audioSource: "audioSource", bridgePort: "bridgePort",
    parallax: "parallax", monet: "monet",
    brightness: "brightness", volume: "volume", rotate: "rotate",
    rotateEvery: "rotateEvery", rotateRandom: "rotateRandom",
    hitokotoShow: "hitokotoShow", hitokotoSize: "hitokotoSize", hitokotoFont: "hitokotoFont",
    clockShow: "clockShow", clockSize: "clockSize", clockWeight: "clockWeight", clockFont: "clockFont", clockX: "clockX", clockY: "clockY",
  };

  for (const [key, id] of Object.entries(map)) {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!state.settings[key];
    else el.value = String(state.settings[key]);
    el.addEventListener(el.type === "range" || el.type === "checkbox" ? "input" : "change", async () => {
      state.settings[key] = el.type === "checkbox" ? el.checked : el.value;
      if (key === "fps" || key === "dpr" || key === "brightness" || key === "volume" || key === "rotateEvery" || key === "bridgePort" || key === "hitokotoSize" || key === "clockSize" || key === "clockWeight" || key === "clockX" || key === "clockY")
        state.settings[key] = Number(state.settings[key]) || 0;
      if (key === "rate") {
        state.settings.rate = Number(state.settings.rate) || 1;
        vid.playbackRate = state.settings.rate;
      }
      if (key === "fit") applyFit();
      if (key === "parallax") {
        // 同步壁纸自己的「视差」属性，两边始终一致；再重新装配让深度生效
        const pkey = state.parallaxPropKey;
        if (pkey && state.propValues) {
          state.propValues[pkey] = state.settings.parallax;
          propView?.refresh(state.propValues);
          pushProps(state.propValues);
          // 重新装配会从存储里读属性值，必须先落盘再重装
          await saveWallProps(propWallId, state.propValues);
          state.parallaxDirty = false;
        }
        remountScene();
      }
      if (key === "monet") applyMonet();
      if (key.startsWith("hitokoto")) renderHitokoto();
      if (key.startsWith("clock")) applyClock();
      if (key === "brightness") applyBrightness();
      if (key === "volume") applyVolume();
      if (key === "rotate" || key === "rotateEvery" || key === "rotateRandom") scheduleRotation();
      if (key === "audioSource" || key === "bridgePort") applyAudioSource();
      if (key === "dpr") state.effectiveDpr = null;
      saveSettings();
      applyLiveSettings();
    });
  }

}

// 应用填充模式
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
    notice(`帧率偏低（${state.fps} FPS），已自动降到 ${next}× 渲染分辨率`);
  }, 2000);
}

// 把画质类设置热更新到引擎
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

// 绑定面板上的所有按钮
function bindPanel() {
  $("gear").addEventListener("click", () => setPanelOpen());
  $("close").addEventListener("click", () => setPanelOpen(false));
  $("rescan").addEventListener("click", () => rescan().catch(reportError));
  $("openWorkshop").addEventListener("click", openSteamWorkshop);
  $("bridgeStart").addEventListener("click", startBridgeService);
  $("bridgeAuto").addEventListener("change", toggleBridgeAutostart);
  $("clockImport").addEventListener("click", () => $("clockFile").click());
  $("clockFile").addEventListener("change", (event) => importClockFont(event.target.files?.[0]));
  $("clockClear").addEventListener("click", () => clearClockFont().catch(reportError));
  $("hitokotoImport").addEventListener("click", () => $("hitokotoFile").click());
  $("hitokotoFile").addEventListener("change", (event) => importHitokotoFont(event.target.files?.[0]));
  $("hitokotoClear").addEventListener("click", () => clearHitokotoFont().catch(reportError));
  $("hitokotoNext").addEventListener("click", () => renderHitokoto(true));
  bindGpu();


  $("addRoot").addEventListener("click", async () => {
    try {
      const picked = await window.showDirectoryPicker({ mode: "read", id: "we-roots" });
      if (!(await ensurePermission(picked))) return notice("未获得目录读取权限");

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
      if (detected.length) notice(`已识别并添加 ${added} 个壁纸目录`);
    } catch (error) {
      if (error?.name !== "AbortError") reportError(error);
    }
  });
}


let idleTimer = 0;
// 鼠标静止后隐藏界面元素
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
