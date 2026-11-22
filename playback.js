/* 播放核心：场景/视频/网页/图片切换、属性下发、音量、音频总线、轮播与性能自适应。 */
"use strict";

let propView = null;
let propWallId = null;

async function readAllProps() {
  return (await chrome.storage.local.get("wallProps")).wallProps || {};
}

let wallPropsTimer = 0;

window.addEventListener("pagehide", () => {
  if (!wallPropsTimer || !propWallId || !state.propValues) return;
  clearTimeout(wallPropsTimer);
  wallPropsTimer = 0;
  saveWallProps(propWallId, state.propValues).catch(() => {});
});

function scheduleWallPropsSave(id, values) {
  clearTimeout(wallPropsTimer);
  const snapshot = { ...values };
  wallPropsTimer = setTimeout(() => {
    saveWallProps(id, snapshot).catch(() => {});
  }, 400);
}

async function saveWallProps(id, values) {
  const all = await readAllProps();
  all[id] = values;
  await chrome.storage.local.set({ wallProps: all });
}

let propsQueued = false;

function pushProps(values) {

  const pkey = state.parallaxPropKey;
  if (pkey && values[pkey] !== undefined) {
    const on = values[pkey] !== false;
    if (on !== state.settings.parallax) {
      state.settings.parallax = on;
      const box = $("parallax");
      if (box) box.checked = on;
      saveSettings();
      state.parallaxDirty = true;
    }
  }
  state.propValues = { ...values };
  if (state.current?.type === "web") {
    pushWebProps(state.propValues);
    return;
  }
  if (!state.current || state.current.type !== "scene") return;

  state.pendingProps = state.propValues;
  if (propsQueued) return;
  propsQueued = true;
  requestAnimationFrame(() => {
    propsQueued = false;
    const props = state.pendingProps;
    if (props) sceneFrame.contentWindow?.postMessage({ t: "props", props }, "*");
  });
}

async function prepareProps(wall) {
  const defs = propDefs(wall);
  const section = $("propsSection");
  const box = $("props");
  propView = null;

  const pending = state.propWallId === wall.id ? state.propValues || {} : {};
  propWallId = wall.id;
  state.propWallId = wall.id;
  state.propValues = {};

  if (!defs.length) {
    section.hidden = true;
    box.textContent = "";
    return;
  }

  state.propTypes = {};
  for (const { name, def } of defs) state.propTypes[name] = def.type;

  const defaults = defaultValues(defs);
  const saved = (await readAllProps())[wall.id] || {};
  const values = { ...defaults, ...saved, ...pending };

  const parallaxDef = defs.find((entry) => entry.def.type === "bool" && /视差/.test(entry.def.text || ""));
  state.parallaxPropKey = parallaxDef ? parallaxDef.name : null;
  if (state.parallaxPropKey && values[state.parallaxPropKey] !== undefined) {
    state.settings.parallax = values[state.parallaxPropKey] !== false;
    const box = $("parallax");
    if (box) box.checked = state.settings.parallax;
    saveSettings();
  }

  section.hidden = false;
  propView = renderProperties(box, defs, values, async (name, value) => {
    values[name] = value;
    propView?.refresh(values);
    pushProps(values);
    scheduleWallPropsSave(propWallId, values);
    if (state.parallaxDirty) {
      state.parallaxDirty = false;

      await saveWallProps(propWallId, values);
      remountScene();
    }
  });
  propView.refresh(values);
  state.propValues = values;

  $("propsReset").onclick = async () => {
    const all = await readAllProps();
    delete all[propWallId];
    await chrome.storage.local.set({ wallProps: all });
    state.propValues = {};
    await prepareProps(wall);
    pushProps(state.propValues);
    notice("已恢复该壁纸的默认选项");
  };
}

let pendingScene = null;
let pendingWeb = null;

function waitSceneReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScene = null;
      reject(new Error("场景加载超时"));
    }, 20000);
    pendingScene = {
      resolve: () => {
        clearTimeout(timer);
        pendingScene = null;
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingScene = null;
        reject(error);
      },
    };
  });
}

function waitWebReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWeb = null;
      reject(new Error("网页壁纸加载超时"));
    }, 10000);
    pendingWeb = {
      resolve: () => {
        clearTimeout(timer);
        pendingWeb = null;
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingWeb = null;
        reject(error);
      },
    };
  });
}

function hideAll() {
  for (const el of [vid, img, sceneFrame, webFrame]) el.classList.remove("on");
  vid.removeAttribute("src");
}

function stopAll() {
  vid.pause();
  if (state.mediaUrl) {
    URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null;
  }
  hideAll();

  if (webFrame.getAttribute("src") && webFrame.getAttribute("src") !== "about:blank") webFrame.src = "about:blank";
  if (state.sceneReady) sceneFrame.contentWindow?.postMessage({ t: "stop" }, "*");
  state.sceneAudioReady = false;
  clearTimeout(state.sceneAudioTimer);
  state.sceneAudioTimer = 0;
  pendingScene?.reject(new Error("已切换壁纸"));
  pendingWeb?.reject(new Error("已切换壁纸"));
  stopOcclusionWatch();
}

let occlusionTimer = 0;
let occlusionPaused = false;

function startOcclusionWatch() {
  if (occlusionTimer) return;
  occlusionTimer = setInterval(pollOcclusion, 1000);
}

function stopOcclusionWatch() {
  clearInterval(occlusionTimer);
  occlusionTimer = 0;
  if (occlusionPaused) resumeForOcclusion();
}

async function pollOcclusion() {
  if (!state.current || document.hidden || !state.settings.occludePause) return;
  const rect = {
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + (window.outerHeight - window.innerHeight),
    w: window.innerWidth,
    h: window.innerHeight,
  };
  const res = await windowCoverage(rect);
  if (!res || !res.ok) return;
  const coverage = Math.max(0, Math.min(1, Number(res.coverage) || 0));
  if (state.current?.type === "scene" && Array.isArray(res.rects)) {
    sceneFrame.contentWindow?.postMessage({ t: "occlusion", payload: { occluders: res.rects, epoch: "win", gen: Date.now() } }, "*");
  }
  const threshold = Math.max(0.5, Math.min(0.95, (Number(state.settings.occludeThreshold) || 75) / 100));
  if (coverage >= threshold && !occlusionPaused) pauseForOcclusion();
  else if (coverage < threshold - 0.05 && occlusionPaused) resumeForOcclusion();
}

function pauseForOcclusion() {
  if (occlusionPaused || !state.current) return;
  occlusionPaused = true;
  if (state.current.type === "scene") sceneFrame.contentWindow?.postMessage({ t: "pause" }, "*");
  else if (state.current.type === "video") vid.pause();
  else if (state.current.type === "web") webFrame.contentWindow?.postMessage({ __wePause: true }, "*");
}

function resumeForOcclusion() {
  if (!occlusionPaused) return;
  occlusionPaused = false;
  if (state.current?.type === "scene") sceneFrame.contentWindow?.postMessage({ t: "resume" }, "*");
  else if (state.current?.type === "video" && state.current) vid.play().catch(() => {});
  else if (state.current?.type === "web") webFrame.contentWindow?.postMessage({ __weResume: true }, "*");
}

function remountScene() {
  const wall = state.walls.find((item) => item.id === state.current?.id);
  if (!wall || wall.type !== "scene") return;
  play(wall).catch(() => {});
}

async function play(wall, attempt = 0) {
  const token = (state.playToken = (state.playToken || 0) + 1);
  try {
    await playOnce(wall);
    if (token !== state.playToken) return;
    state.fallbackQuality = false;
  } catch (error) {
    if (token !== state.playToken) return;
    if (attempt === 0) {
      notice(`加载失败，正在重试：${wall.title}`);
      state.fallbackQuality = true;
      await new Promise((r) => setTimeout(r, 600));
      return play(wall, 1);
    }
    state.current = null;
    notice(`壁纸加载失败：${error.message || error}`);
  }
}

function hostAssetUrl(wall, path) {
  const port = state.webPort;
  if (!port || !wall || !wall.hostId) return "";
  const tail = String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `http://127.0.0.1:${port}/asset/${encodeURIComponent(wall.hostId)}/${tail}`;
}

async function playOnce(wall) {
  stopAll();
  state.effectiveDpr = null;
  lowFpsTicks = 0;

  state.current = { id: wall.id, hostId: wall.hostId || "", type: wall.type, title: wall.title, dir: wall.dir };
  state.sceneAudioReady = false;
  clearTimeout(state.sceneAudioTimer);
  state.sceneAudioTimer = 0;
  state.playStart = performance.now();
  await prepareProps(wall);

  if (wall.type === "scene") {
    await playScene(wall);
  } else if (wall.type === "video") {
    await playMedia(wall, "video");
  } else if (wall.type === "web") {
    await playWeb(wall);
  } else if (wall.type === "image" || wall.type === "gif") {
    await playMedia(wall, "image");
  } else {
    state.current = null;
    notice("该类型暂不支持（仅支持场景 / 视频 / 图片）");
    return;
  }

  saveSettings();
  document.querySelectorAll("#walls .card").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === wall.id);
  });
  chrome.storage.local.set({ lastWall: wall.id });
  applyMonet(wall);
  applyBrightness();
  applyVolume();
  scheduleRotation();
  applyAudioSource();
  startOcclusionWatch();
}

let displayHzCache = 0;

// 实测显示器刷新率：rAF 间隔中位数；一次性缓存
async function displayHz() {
  if (displayHzCache) return displayHzCache;
  const samples = [];
  await new Promise((resolve) => {
    let last = 0;
    let count = 0;
    const tick = (now) => {
      if (last) samples.push(now - last);
      last = now;
      count += 1;
      if (count < 90) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  if (!samples.length) return 60;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const hz = Math.round(1000 / Math.max(1, median));
  displayHzCache = Math.max(24, Math.min(240, hz || 60));
  return displayHzCache;
}

// 视频壁纸先播原片，后台转码好后再无缝换到限帧版（保持 currentTime）
async function warmVideoTranscode(wall, fileName, originalUrl) {
  if (state.settings.videoTranscode === false) return;
  const hz = await displayHz();
  for (let i = 0; i < 120; i++) {
    const prep = await videoPrepare(wall.hostId, fileName, hz);
    if (prep && prep.state === "original") return;
    if (state.current?.id !== wall.id) return;
    if (prep && prep.state === "ready" && prep.url) {
      if (prep.url === originalUrl) return;
      const at = vid.currentTime || 0;
      const wasPlaying = !vid.paused;
      vid.src = prep.url;
      vid.currentTime = at;
      if (wasPlaying) vid.play().catch(() => {});
      return;
    }
    if (!prep || prep.ok === false) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function playMedia(wall, kind) {
  const fileName = String(wall.project.file || "");
  let url;
  if (wall.hostId) {
    url = hostAssetUrl(wall, fileName);
    state.hostMedia = true;
    if (kind === "video") warmVideoTranscode(wall, fileName, url);
  } else {
    throw new Error("缺少宿主壁纸标识");
  }

  if (kind === "video") {
    const level = volumeLevel();
    vid.src = url;
    vid.playbackRate = Number(state.settings.rate) || 1;
    vid.volume = level;
    vid.muted = level <= 0;
    vid.classList.add("on");
    vid.play().catch(() => {

      vid.muted = true;
      vid.play().catch(() => notice("视频自动播放被拦截，请点击页面"));
      window.addEventListener(
        "pointerdown",
        () => {
          vid.muted = level <= 0;
          vid.volume = level;
        },
        { once: true }
      );
    });
  } else {
    img.src = url;
    img.classList.add("on");
  }
  status(wall.title);
}

async function playWeb(wall) {
  const port = await ensureWebService();
  if (!port) {
    status("网页壁纸需要本地服务");
    notice("本地服务启动失败：请先安装 native 辅助程序，或检查 43197 端口是否被占用");
    return;
  }
  const name = String(wall.name || String(wall.id).split("/").pop());
  const entry = String(wall.project.file || "index.html").replace(/^\/+/, "");
  const tail = entry.split("/").map(encodeURIComponent).join("/");
  state.webSent = {};
  const ready = waitWebReady();
  webFrame.onload = () => {
    state.webSent = {};
    pushWebProps(state.propValues || {});
    webFrame.contentWindow?.postMessage({ __weFit: { mode: state.settings.fit } }, "*");
    webFrame.contentWindow?.postMessage({ __weVolume: { value: volumeLevel() } }, "*");
  };
  webFrame.src = wall.hostId
    ? `http://127.0.0.1:${port}/asset/${encodeURIComponent(wall.hostId)}/${tail}`
    : `http://127.0.0.1:${port}/wall/${encodeURIComponent(name)}/${tail}`;
  webFrame.classList.add("on");
  status(wall.title);
  await ready;
}

function pushWebProps(values) {
  if (!webFrame.classList.contains("on")) return;
  const sent = state.webSent || {};
  const payload = {};
  let changed = 0;
  for (const [name, raw] of Object.entries(values || {})) {
    const json = JSON.stringify(raw);
    if (sent[name] === json) continue;
    sent[name] = json;
    payload[name] = { value: raw };
    changed++;
  }
  if (!changed) return;
  state.webSent = sent;
  try {
    webFrame.contentWindow?.postMessage({ __weProps: payload }, "*");
  } catch {

  }
}

const webAudioLeft = new Float32Array(64);
const webAudioRight = new Float32Array(64);
let audioTimer = 0;

function pushWebAudio(left, right) {
  if (!webFrame.classList.contains("on") || state.current?.type !== "web") return;
  for (let i = 0; i < 64; i++) {
    webAudioLeft[i] = Math.max(0, Math.min(1, left[i] || 0));
    webAudioRight[i] = Math.max(0, Math.min(1, right[i] || 0));
  }
  try {
    webFrame.contentWindow?.postMessage({ __weAudio: { left: webAudioLeft, right: webAudioRight } }, "*");
  } catch {

  }
}

function currentBins() {
  if (mic.timer && mic.bins) return mic.bins;
  if (bridge.alive) return bridgeBins;
  return null;
}

function startAudioLoop() {
  if (audioTimer) return;
  audioTimer = setInterval(() => {
    if (document.hidden) return;
    const bins = currentBins();
    if (!bins) return;
    if (state.current?.type === "web") pushWebAudio(bins, bins);
    if (state.current?.type === "scene" && state.sceneAudioReady) {
      sceneFrame.contentWindow?.postMessage({ t: "audio", left: bins, right: bins }, "*");
    }
  }, 33);
}

const SCENE_BOOT_TIMEOUT = 8000;

function waitSceneBoot() {
  return new Promise((resolve) => {
    if (state.sceneReady) return resolve(true);

    const started = Date.now();
    const timer = setInterval(() => {
      if (state.sceneReady) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > SCENE_BOOT_TIMEOUT) {
        clearInterval(timer);
        resolve(false);
      } else {
        sceneFrame.contentWindow?.postMessage({ t: "ping" }, "*");
      }
    }, 250);
    sceneFrame.contentWindow?.postMessage({ t: "ping" }, "*");
  });
}

async function scenePayload(wall) {
  if (wall.hostId) {
    const declared = String(wall.project.file || "");
    let entry = null;
    if (declared.toLowerCase().endsWith(".json")) {
      try {
        const res = await fetch(hostAssetUrl(wall, declared));
        if (res.ok) entry = declared;
      } catch {
        entry = null;
      }
    }
    let pkgFile = null;
    if (!entry) {
      const res = await fetch(hostAssetUrl(wall, "scene.pkg"));
      if (!res.ok) throw new Error("缺少 scene.pkg");
      pkgFile = new File([await res.blob()], "scene.pkg");
    }
    return {
      t: "mount",
      key: `host/${wall.hostId}`,
      title: wall.title,
      pkgFile,
      entry,
      project: wall.project,
      props: state.propValues || {},
      opts: {
        fps: Number(state.settings.fps) || 30,
        dpr: state.fallbackQuality ? 0.75 : state.effectiveDpr ?? (Number(state.settings.dpr) || 0),
        fit: state.settings.fit,
        scripts: !!state.settings.scripts,
        parallax: state.settings.parallax !== false,
        volume: volumeLevel(),
        webPort: state.webPort || 0,
        quality: state.fallbackQuality
          ? { antiAliasing: false, particles: false, postProcessing: false }
          : { antiAliasing: state.settings.aa, particles: state.settings.particles, postProcessing: state.settings.post },
      },
    };
  }

}

async function playScene(wall) {

  const alive = await waitSceneBoot();
  if (!alive) {
    notice("场景渲染器未启动（sandbox 页加载失败）");
    return;
  }

  notice(`正在加载：${wall.title}…`);
  const msg = await scenePayload(wall);
  sceneFrame.classList.add("on");
  const ready = waitSceneReady();
  sceneFrame.contentWindow.postMessage(msg, "*");
  await ready;
}

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.t !== "read") return;

  const reqId = data.id;
  let file = null;
  if (state.current?.hostId && data.path) {
    try {
      const res = await fetch(hostAssetUrl(state.current, data.path));
      if (res.ok) file = new File([await res.blob()], String(data.path).split("/").pop());
    } catch {
      /* 忽略 */
    }
  }
  if (!file && data.path && /^fonts\//i.test(data.path) && state.webPort) {
    try {
      const name = data.path.split("/").pop();
      const res = await fetch(`http://127.0.0.1:${state.webPort}/wefonts/${encodeURIComponent(name)}`);
      if (res.ok) file = new File([await res.blob()], name);
    } catch {

    }
  }
  event.source?.postMessage({ t: "read:res", id: reqId, file }, "*");
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.t === "boot" || data.t === "pong" || data.t === "ready" || data.t === "stats") state.sceneReady = true;
  if (data.t === "stats") {
    state.fps = Math.round(Number(data.fps) || 0);
    state.sceneRunning = data.running !== false;
    if (state.sceneRunning && state.current?.type === "scene" && !state.sceneAudioReady && !state.sceneAudioTimer) {

      state.sceneAudioTimer = setTimeout(() => {
        state.sceneAudioTimer = 0;
        if (state.current?.type === "scene" && state.sceneRunning) state.sceneAudioReady = true;
      }, 800);
    }
    const meter = $("fpsNow");
    if (meter) meter.textContent = state.current ? `${state.fps} FPS` : "—";
  }

  if (data.t === "diag" && data.level === "error") notice(data.msg);
  if (data.t === "error") {
    pendingScene?.reject(new Error(data.msg));
    notice(`壁纸加载失败：${data.msg}`);
  }
  if (data.__weWeb) {
    state.webInfo = data.__weWeb;
    if (data.__weWeb.kind === "ready") pendingWeb?.resolve();
    if (data.__weWeb.kind === "error") pendingWeb?.reject(new Error(data.__weWeb.msg || "网页壁纸加载失败"));

    if (data.__weWeb.kind === "error") console.warn("[web]", data.__weWeb.msg, data.__weWeb.st || "");
    return;
  }
  if (data.t === "ready") pendingScene?.resolve();
  if (data.t === "ready" && state.current) {
      status(state.current.title);
  }
});

function applyBrightness() {
  const value = Math.max(0, Math.min(100, Number(state.settings.brightness) || 100));
  $("dim").style.opacity = (value >= 100 ? 0 : (100 - value) / 100).toFixed(2);

  $("stage").style.filter = "";
}

function volumeLevel() {
  if (!state.settings.audioEnabled) return 0;
  return Math.max(0, Math.min(100, Number(state.settings.volume) || 0)) / 100;
}

function applyVolume() {
  const level = volumeLevel();
  sceneFrame.contentWindow?.postMessage({ t: "volume", value: level }, "*");
  webFrame.contentWindow?.postMessage({ __weVolume: { value: level } }, "*");
  if (vid.src) {
    vid.volume = level;
    vid.muted = level <= 0;
  }
}

let rotateTimer = 0;

function scheduleRotation() {
  clearTimeout(rotateTimer);
  if (!state.settings.rotate || state.walls.length < 2) return;
  const minutes = Math.max(1, Number(state.settings.rotateEvery) || 5);
  rotateTimer = setTimeout(() => {
    if (!state.settings.rotate || state.walls.length < 2) return;
    const allow = ratingAllowSet();
    const list = state.walls.filter((wall) => allow.has(wall.rating));
    let next = null;
    if (state.settings.rotateRandom) {
      if (list.length > 1) {
        do {
          next = list[Math.floor(Math.random() * list.length)];
        } while (next.id === state.current?.id && list.length > 1);
      } else {
        next = list[0];
      }
    } else {
      const index = list.findIndex((item) => item.id === state.current?.id);
      next = list[(index + 1 + list.length) % list.length];
    }
    if (next && next.id !== state.current?.id) play(next).catch(() => {});
  }, minutes * 60 * 1000);
}

const mic = { ctx: null, stream: null, analyser: null, timer: 0, data: null, bins: new Array(64).fill(0) };

function pushAudio() {
  if (!mic.analyser) return;
  const buffer = mic.data || (mic.data = new Uint8Array(mic.analyser.frequencyBinCount));
  mic.analyser.getByteFrequencyData(buffer);
  const bins = mic.bins;
  const step = Math.max(1, Math.floor(buffer.length / 64));
  for (let i = 0; i < 64; i++) {
    let sum = 0;
    const start = i * step;
    const end = Math.min(buffer.length, start + step);
    for (let j = start; j < end; j++) sum += buffer[j];
    bins[i] = sum / Math.max(1, end - start) / 255;
  }
  const frame = activeFrameOrNull();
  if (frame) frame.contentWindow?.postMessage({ t: "audio", left: bins, right: bins }, "*");
}

async function startMic() {
  if (mic.timer) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    Object.assign(mic, { ctx, stream, analyser });

    const loop = () => {
      if (!mic.timer) return;
      pushAudio();
      mic.timer = requestAnimationFrame(loop);
    };
    mic.timer = requestAnimationFrame(loop);
    notice("已启用麦克风频谱（仅本机处理）");
    return true;
  } catch (error) {
    notice(`麦克风不可用：${error.message || error}`);
    return false;
  }
}

function stopMic() {
  cancelAnimationFrame(mic.timer);
  mic.timer = 0;
  mic.stream?.getTracks().forEach((track) => track.stop());
  mic.ctx?.close().catch(() => {});
  mic.analyser = null;
  sceneFrame.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}

function activeFrameOrNull() {
  return state.sceneReady ? sceneFrame : null;
}

const bridge = { source: null, timer: 0, alive: false, mediaTimer: 0, base: "" };

const bridgeBins = new Float32Array(64);

function pushBins(bands) {
  const left = bridgeBins;
  for (let i = 0; i < 64; i++) left[i] = Math.max(0, Math.min(1, (bands[i] || 0) / 255));
  const frame = activeFrameOrNull();
  if (frame) frame.contentWindow?.postMessage({ t: "audio", left, right: left }, "*");
}

let dshAudioTimer = 0;

function stopDshAudio() {
  clearInterval(dshAudioTimer);
  dshAudioTimer = 0;
  activeFrameOrNull()?.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}

async function startDshAudio() {
  stopDshAudio();
  const port = state.webPort || 43197;
  const base = `http://127.0.0.1:${port}/dsh/spectrum`;
  try {
    const probe = await fetch(base, { cache: "no-store" });
    const json = await probe.json();
    if (!probe.ok || !json || json.ok === false || json.running !== true) throw new Error("DSH media-bridge 未运行");
  } catch (error) {
    notice(`DSH 音频不可用：${error.message || error}，改用本机 media-bridge`);
    await startBridge();
    return;
  }
  dshAudioTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(base, { cache: "no-store" });
      const json = await res.json();
      if (Array.isArray(json.bands)) pushBins(json.bands);
    } catch {
      /* 下一轮再试 */
    }
  }, 50);
}

function stopBridge() {
  if (bridge.source) {
    bridge.source.close();
    bridge.source = null;
  }
  if (bridge.timer) {
    clearInterval(bridge.timer);
    bridge.timer = 0;
  }
  if (bridge.mediaTimer) {
    clearInterval(bridge.mediaTimer);
    bridge.mediaTimer = 0;
  }
  activeFrameOrNull()?.contentWindow?.postMessage({ t: "media", off: true }, "*");
  bridge.alive = false;
}

function mediaSnapshot(now) {
  const track = now?.track || {};
  const playback = now?.playback || {};
  const art = track.artwork;
  const state = !now?.hasMedia ? 0 : playback.state === "playing" ? 1 : playback.state === "paused" ? 2 : 0;
  return {
    hasMedia: !!now?.hasMedia,
    state,
    title: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    albumArtist: track.albumArtist || "",
    position: Math.max(0, Number(playback.positionMs) || 0) / 1000,
    duration: Math.max(0, Number(track.durationMs) || Number(playback.durationMs) || 0) / 1000,
    hasThumbnail: !!art,
    thumbnail: art?.httpPath ? bridge.base + art.httpPath : "",
    trackIndex: 0,
  };
}

async function pollMedia() {
  const frame = activeFrameOrNull();
  if (!frame) return;
  try {
    const res = await fetch(`${bridge.base}/v1/now`, { cache: "no-store" });
    if (!res.ok) return;
    const now = await res.json();
    frame.contentWindow?.postMessage({ t: "media", snapshot: mediaSnapshot(now) }, "*");
  } catch {

  }
}

async function startBridge() {
  stopBridge();
  const port = Math.max(1, Number(state.settings.bridgePort) || 8765);
  const base = `http://127.0.0.1:${port}`;

  try {
    const probe = await fetch(`${base}/v1/now`, { cache: "no-store" });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    notice(`未检测到 media-bridge（${base}）：${error.message || error}。先运行 & "$env:USERPROFILE\\Downloads\\media-bridge-win32-x64.exe" serve --http ${base.replace("http://", "")}`);
    return;
  }

  bridge.base = base;
  pollMedia();
  bridge.lastPoll = 0;

  const source = new EventSource(`${base}/v1/events?events=spectrum&spectrumMs=50`);
  bridge.source = source;
  source.addEventListener("spectrum", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const bands = payload?.frame?.bands;
      if (Array.isArray(bands)) pushBins(bands);

      const stamp = performance.now();
      if (stamp - (bridge.lastPoll || 0) > 900) {
        bridge.lastPoll = stamp;
        pollMedia();
      }
    } catch {

    }
  });
  source.onerror = () => {
    if (bridge.alive) {
      bridge.alive = false;
      notice("media-bridge 连接断开，正在重连…");
    }
  };
  source.onopen = () => {
    if (!bridge.alive) {
      bridge.alive = true;
      notice("已接入 media-bridge 系统音频");
    }
  };
}

function stopAudioSources() {
  stopMic();
  stopBridge();
  stopDshAudio();
}

async function applyAudioSource() {
  startAudioLoop();
  stopAudioSources();
  const source = state.settings.audioSource;
  if (source === "mic") await startMic();
  else if (source !== "off" && (await dshAvailable())) await startDshAudio();
  else if (source === "bridge" || source === "auto") await startBridge();
  else if (source === "dsh") await startDshAudio();
  else activeFrameOrNull()?.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}
