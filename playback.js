"use strict";

/* 播放层：场景/视频/图片、属性下发、效果、轮换、音频 */

/* ---------------- 壁纸自定义选项 ---------------- */

let propView = null;
let propWallId = null;

async function readAllProps() {
  return (await chrome.storage.local.get("wallProps")).wallProps || {};
}

async function saveWallProps(id, values) {
  const all = await readAllProps();
  all[id] = values;
  await chrome.storage.local.set({ wallProps: all });
}

// 把当前值下发给正在播放的壁纸
function pushProps(values) {
  state.propValues = { ...values };
  if (!state.current) return;
  if (state.current.type === "scene") {
    sceneFrame.contentWindow?.postMessage({ t: "props", props: state.propValues }, "*");
  }
}

async function prepareProps(wall) {
  const defs = propDefs(wall);
  const section = $("propsSection");
  const box = $("props");
  propView = null;
  propWallId = wall.id;
  state.propValues = {};

  if (!defs.length) {
    section.hidden = true;
    box.textContent = "";
    return;
  }

  const defaults = defaultValues(defs);
  const saved = (await readAllProps())[wall.id] || {};
  const values = { ...defaults, ...saved };

  section.hidden = false;
  propView = renderProperties(box, defs, values, async (name, value) => {
    values[name] = value;
    propView?.refresh(values);
    pushProps(values);
    await saveWallProps(propWallId, values);
  });
  propView.refresh(values);
  state.propValues = values;

  $("propsReset").onclick = async () => {
    const all = await readAllProps();
    delete all[propWallId];
    await chrome.storage.local.set({ wallProps: all });
    await prepareProps(wall);
    pushProps(state.propValues);
    status("已恢复该壁纸的默认选项");
  };
}
/* ---------------- 播放 ---------------- */

function hideAll() {
  for (const el of [vid, img, sceneFrame]) el.classList.remove("on");
  vid.removeAttribute("src");
}

function stopAll() {
  vid.pause();
  if (state.mediaUrl) {
    URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null;
  }
  hideAll();
  if (state.sceneReady) sceneFrame.contentWindow?.postMessage({ t: "stop" }, "*");
}

async function play(wall) {
  stopAll();
  state.effectiveDpr = null;
  lowFpsTicks = 0;
  // 场景装配期渲染页会回读松散工程资源，必须先记录当前壁纸目录
  state.current = { id: wall.id, type: wall.type, title: wall.title, dir: wall.dir };
  state.playStart = performance.now();
  await prepareProps(wall);

  if (wall.type === "scene") {
    await playScene(wall);
  } else if (wall.type === "video") {
    await playMedia(wall, "video");
  } else if (wall.type === "image" || wall.type === "gif") {
    await playMedia(wall, "image");
  } else {
    state.current = null;
    status("该类型暂不支持（仅支持场景 / 视频 / 图片）");
    return;
  }

  saveSettings();
  document.querySelectorAll("#walls .card").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === wall.id);
  });
  chrome.storage.local.set({ lastWall: wall.id });
  // 莫奈取色：换壁纸后按新壁纸的主色更新主题
  applyMonet(true).catch(() => {});
  applyBrightness();
  applyVolume();
  scheduleRotation();
  applyAudioSource();
}

async function playMedia(wall, kind) {
  const fileName = String(wall.project.file || "");
  const { file: blob } = await fileInfo(wall.dir, fileName);

  const url = URL.createObjectURL(blob);
  state.mediaUrl = url;

  if (kind === "video") {
    vid.src = url;
    vid.playbackRate = Number(state.settings.rate) || 1;
    vid.classList.add("on");
    vid.play().catch(() => status("视频自动播放被拦截，请点击页面"));
  } else {
    img.src = url;
    img.classList.add("on");
  }
  status(`正在播放：${wall.title}`);
}

/* ---------------- 场景壁纸 ---------------- */

const SCENE_BOOT_TIMEOUT = 8000;

function waitSceneBoot() {
  return new Promise((resolve) => {
    if (state.sceneReady) return resolve(true);
    // render.html 随页面一起加载，boot 早于挂载动作就发完了，不能只等那一条消息。
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
  const dir = wall.dir;
  const declared = String(wall.project.file || "");

  let entry = null;

  // 松散工程：project.file 指向 json 且该文件确实存在
  if (declared.toLowerCase().endsWith(".json")) {
    try {
      const { file } = await fileInfo(dir, declared);
      if (file.size > 0) entry = declared;
    } catch {
      entry = null;
    }
  }

  let pkgFile = null;
  if (!entry) {
    if (!dir) throw new Error("缺少壁纸目录");
    const { file } = await fileInfo(dir, "scene.pkg");
    pkgFile = file;
  }

  return {
    t: "mount",
    key: `${wall.root}/${wall.name}`,
    title: wall.title,
    pkgFile,
    entry,
    project: wall.project,
    props: state.propValues || {},
    opts: {
      fps: Number(state.settings.fps) || 30,
      dpr: state.effectiveDpr ?? (Number(state.settings.dpr) || 0),
      fit: state.settings.fit,
      scripts: !!state.settings.scripts,
      volume: (Number(state.settings.volume) || 0) / 100,
      quality: {
        antiAliasing: state.settings.aa,
        particles: state.settings.particles,
        postProcessing: state.settings.post,
      },
    },
  };
}

async function playScene(wall) {

  const alive = await waitSceneBoot();
  if (!alive) {
    status("场景渲染器未启动（sandbox 页加载失败）");
    return;
  }

  status(`正在加载：${wall.title}…`);
  const msg = await scenePayload(wall);
  sceneFrame.classList.add("on");
  sceneFrame.contentWindow.postMessage(msg, "*");
}

/* 渲染页请求读取松散工程里的资源 */
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.t !== "read") return;

  const reqId = data.id;
  const dir = state.current?.dir || null;
  // 直接回 File（结构化克隆只传引用），沙箱侧再读字节
  let file = null;
  try {
    if (dir) ({ file } = await fileInfo(dir, data.path));
  } catch {
    file = null;
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
    const meter = $("fpsNow");
    if (meter) meter.textContent = state.current ? `${state.fps} FPS` : "—";
  }
  // 降级类提示（软件渲染、贴图回退）只进控制台，不打断用户
  if (data.t === "diag" && data.level === "error") status(data.msg);
  if (data.t === "diag" && data.level !== "error") console.log("[diag]", data.msg);
  if (data.t === "error") status(`壁纸加载失败：${data.msg}`);
  if (data.t === "propsstate") console.log("[props]", JSON.stringify(data.values));
  if (data.t === "ready" && state.current) {
    if (state.playStart) console.log(`[perf] ${state.current.title} ready in ${Math.round(performance.now() - state.playStart)}ms`);
    status(`正在播放：${state.current.title}`);
  }
});


/* ---------------- 亮度 / 音量 / 轮换 / 音频 ---------------- */

function applyBrightness() {
  const value = Number(state.settings.brightness) || 100;
  stage.style.filter = value >= 100 ? "" : `brightness(${(value / 100).toFixed(2)})`;
}

function applyVolume() {
  const value = Math.max(0, Math.min(100, Number(state.settings.volume) || 0));
  sceneFrame.contentWindow?.postMessage({ t: "volume", value: value / 100 }, "*");
}

/* 自动轮换：按间隔切到列表里的下一张（可选随机） */
let rotateTimer = 0;

function scheduleRotation() {
  clearTimeout(rotateTimer);
  if (!state.settings.rotate || state.walls.length < 2) return;
  const minutes = Math.max(1, Number(state.settings.rotateEvery) || 5);
  rotateTimer = setTimeout(() => {
    if (!state.settings.rotate || state.walls.length < 2) return;
    const list = state.walls;
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

/* 音频响应：浏览器拿不到系统声音，只能用麦克风近似（默认关闭） */
const mic = { ctx: null, stream: null, analyser: null, timer: 0, data: null };

function pushAudio() {
  const frame = activeFrameOrNull();
  if (!frame || !mic.analyser) return;
  const buffer = mic.data || (mic.data = new Uint8Array(mic.analyser.frequencyBinCount));
  mic.analyser.getByteFrequencyData(buffer);
  const bins = new Array(64);
  const step = Math.max(1, Math.floor(buffer.length / 64));
  for (let i = 0; i < 64; i++) bins[i] = buffer[i * step] / 255;
  frame.contentWindow?.postMessage({ t: "audio", left: bins, right: bins }, "*");
}

async function startMic() {
  if (mic.timer) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    Object.assign(mic, { ctx, stream, analyser });
    mic.timer = setInterval(pushAudio, 60);
    status("已启用麦克风频谱（仅本机处理）");
    return true;
  } catch (error) {
    status(`麦克风不可用：${error.message || error}`);
    return false;
  }
}

function stopMic() {
  clearInterval(mic.timer);
  mic.timer = 0;
  mic.stream?.getTracks().forEach((track) => track.stop());
  mic.ctx?.close().catch(() => {});
  mic.analyser = null;
  sceneFrame.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}

function activeFrameOrNull() {
  return state.sceneReady ? sceneFrame : null;
}
/* ---------------- 系统音频桥（media-bridge） ---------------- */

const bridge = { source: null, timer: 0, alive: false };

function pushBins(bands) {
  const frame = activeFrameOrNull();
  if (!frame) return;
  const left = new Array(64);
  for (let i = 0; i < 64; i++) left[i] = Math.max(0, Math.min(1, (bands[i] || 0) / 255));
  frame.contentWindow?.postMessage({ t: "audio", left, right: left }, "*");
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
  bridge.alive = false;
}

// media-bridge 的 SSE：/v1/events?events=spectrum&spectrumMs=100
// 帧结构 { event:"spectrum", frame:{ bands:[64], rms, peak } }
async function startBridge() {
  stopBridge();
  const port = Math.max(1, Number(state.settings.bridgePort) || 8765);
  const base = `http://127.0.0.1:${port}`;

  try {
    const probe = await fetch(`${base}/v1/now`, { cache: "no-store" });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    status(`未检测到 media-bridge（${base}）：${error.message || error}`);
    return;
  }

  const source = new EventSource(`${base}/v1/events?events=spectrum&spectrumMs=100`);
  bridge.source = source;
  source.addEventListener("spectrum", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const bands = payload?.frame?.bands;
      if (Array.isArray(bands)) pushBins(bands);
    } catch {
      /* 单帧解析失败忽略 */
    }
  });
  source.onerror = () => {
    if (bridge.alive) {
      bridge.alive = false;
      status("media-bridge 连接断开，正在重连…");
    }
  };
  source.onopen = () => {
    if (!bridge.alive) {
      bridge.alive = true;
      status("已接入 media-bridge 系统音频");
    }
  };
}

function stopAudioSources() {
  stopMic();
  stopBridge();
}

async function applyAudioSource() {
  stopAudioSources();
  const source = state.settings.audioSource;
  if (source === "mic") await startMic();
  else if (source === "bridge") await startBridge();
  else activeFrameOrNull()?.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}
