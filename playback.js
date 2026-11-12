"use strict";

/* 播放层：场景/视频/图片、属性下发、效果、轮换、音频 */

/* ---------------- 壁纸自定义选项 ---------------- */

let propView = null;
let propWallId = null;

// 读取所有壁纸的已存属性
async function readAllProps() {
  return (await chrome.storage.local.get("wallProps")).wallProps || {};
}

let wallPropsTimer = 0;

// 关标签页/切走时把还没落盘的属性写掉
window.addEventListener("pagehide", () => {
  if (!wallPropsTimer || !propWallId || !state.propValues) return;
  clearTimeout(wallPropsTimer);
  wallPropsTimer = 0;
  saveWallProps(propWallId, state.propValues).catch(() => {});
});

// 拖滑块时不必每次输入都整表落盘，停下来再写
function scheduleWallPropsSave(id, values) {
  clearTimeout(wallPropsTimer);
  const snapshot = { ...values };
  wallPropsTimer = setTimeout(() => {
    saveWallProps(id, snapshot).catch(() => {});
  }, 400);
}

// 保存某张壁纸的属性
async function saveWallProps(id, values) {
  const all = await readAllProps();
  all[id] = values;
  await chrome.storage.local.set({ wallProps: all });
}

let propsQueued = false;

// 把当前值下发给正在播放的壁纸
function pushProps(values) {
  // 壁纸自带的「视差」布尔属性与扩展开关保持同步
  const pkey = state.parallaxPropKey;
  if (pkey && values[pkey] !== undefined) {
    const on = values[pkey] !== false;
    if (on !== state.settings.parallax) {
      state.settings.parallax = on;
      const box = $("parallax");
      if (box) box.checked = on;
      saveSettings();
      state.parallaxDirty = true; // 由保存完成后的回调触发重新装配
    }
  }
  state.propValues = { ...values };
  if (!state.current || state.current.type !== "scene") return;
  // 拖滑块时每帧只发一次，避免 183 个属性的消息刷屏
  state.pendingProps = state.propValues;
  if (propsQueued) return;
  propsQueued = true;
  requestAnimationFrame(() => {
    propsQueued = false;
    const props = state.pendingProps;
    if (props) sceneFrame.contentWindow?.postMessage({ t: "props", props }, "*");
  });
}

// 生成属性面板并接管改动
async function prepareProps(wall) {
  const defs = propDefs(wall);
  const section = $("propsSection");
  const box = $("props");
  propView = null;
  // 重装前可能还有未保存的改动（例如刚点的视差开关），内存值优先，避免界面回跳
  const pending = state.propWallId === wall.id ? state.propValues || {} : {};
  propWallId = wall.id;
  state.propWallId = wall.id;
  state.propValues = {};

  if (!defs.length) {
    section.hidden = true;
    box.textContent = "";
    return;
  }

  const defaults = defaultValues(defs);
  const saved = (await readAllProps())[wall.id] || {};
  const values = { ...defaults, ...saved, ...pending };

  // 壁纸若定义了名为「视差」的布尔属性，加载时用它的值作为扩展开关初值
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
      // 先把最新值写完再重装，否则装配读到的还是旧值，开关会弹回去
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
/* ---------------- 播放 ---------------- */

// 隐藏视频 / 图片 / 场景
function hideAll() {
  for (const el of [vid, img, sceneFrame]) el.classList.remove("on");
  vid.removeAttribute("src");
}

// 停止一切播放并通知沙箱
function stopAll() {
  vid.pause();
  if (state.mediaUrl) {
    URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null;
  }
  hideAll();
  if (state.sceneReady) sceneFrame.contentWindow?.postMessage({ t: "stop" }, "*");
}

// 视差深度在装配期写入图层快照，切换后必须重新装配才生效
function remountScene() {
  const wall = state.walls.find((item) => item.id === state.current?.id);
  if (!wall || wall.type !== "scene") return;
  play(wall).catch(() => {});
}

// 播放一张壁纸
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
}

// 播放视频 / 图片
async function playMedia(wall, kind) {
  const fileName = String(wall.project.file || "");
  const { file: blob } = await fileInfo(wall.dir, fileName);

  const url = URL.createObjectURL(blob);
  state.mediaUrl = url;

  if (kind === "video") {
    const level = Math.max(0, Math.min(100, Number(state.settings.volume) || 0)) / 100;
    vid.src = url;
    vid.playbackRate = Number(state.settings.rate) || 1;
    vid.volume = level;
    vid.muted = level <= 0;
    vid.classList.add("on");
    vid.play().catch(() => {
      // 浏览器拦了带声音的自动播放：先静音起播，用户第一次点击后恢复音量
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

/* ---------------- 场景壁纸 ---------------- */

const SCENE_BOOT_TIMEOUT = 8000;

// 等沙箱渲染页就绪
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

// 构造场景挂载消息
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
      parallax: state.settings.parallax !== false,
      volume: (Number(state.settings.volume) || 0) / 100,
      quality: {
        antiAliasing: state.settings.aa,
        particles: state.settings.particles,
        postProcessing: state.settings.post,
      },
    },
  };
}

// 挂载场景壁纸
async function playScene(wall) {

  const alive = await waitSceneBoot();
  if (!alive) {
    notice("场景渲染器未启动（sandbox 页加载失败）");
    return;
  }

  notice(`正在加载：${wall.title}…`);
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
  if (data.t === "diag" && data.level === "error") notice(data.msg);
  if (data.t === "diag" && data.level !== "error") console.log("[diag]", data.msg);
  if (data.t === "error") notice(`壁纸加载失败：${data.msg}`);
  if (data.t === "propsstate") console.log("[props]", JSON.stringify(data.values));
  if (data.t === "ready" && state.current) {
    if (state.playStart) console.log(`[perf] ${state.current.title} ready in ${Math.round(performance.now() - state.playStart)}ms`);
    status(state.current.title);
  }
});

/* ---------------- 亮度 / 音量 / 轮换 / 音频 ---------------- */

// 应用亮度遮罩
function applyBrightness() {
  const value = Math.max(0, Math.min(100, Number(state.settings.brightness) || 100));
  $("dim").style.opacity = (value >= 100 ? 0 : (100 - value) / 100).toFixed(2);
  // 清掉旧版本可能残留在舞台上的滤镜
  $("stage").style.filter = "";
}

// 应用音量：场景走沙箱，视频直接改 <video>
function applyVolume() {
  const value = Math.max(0, Math.min(100, Number(state.settings.volume) || 0));
  const level = value / 100;
  sceneFrame.contentWindow?.postMessage({ t: "volume", value: level }, "*");
  // 视频壁纸用的是 <video>，音量与静音状态必须同步过去
  if (vid.src) {
    vid.volume = level;
    vid.muted = value <= 0;
  }
}

/* 自动轮换：按间隔切到列表里的下一张（可选随机） */
let rotateTimer = 0;

// 安排自动轮换
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
const mic = { ctx: null, stream: null, analyser: null, timer: 0, data: null, bins: new Array(64).fill(0) };

// 把麦克风频谱发给沙箱
function pushAudio() {
  const frame = activeFrameOrNull();
  if (!frame || !mic.analyser) return;
  const buffer = mic.data || (mic.data = new Uint8Array(mic.analyser.frequencyBinCount));
  mic.analyser.getByteFrequencyData(buffer);
  const bins = mic.bins;
  const step = Math.max(1, Math.floor(buffer.length / 64));
  for (let i = 0; i < 64; i++) bins[i] = buffer[i * step] / 255;
  frame.contentWindow?.postMessage({ t: "audio", left: bins, right: bins }, "*");
}

// 启动麦克风分析
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
    // 用 rAF 跟随刷新率采样，比固定 60ms 更贴合画面节拍
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

// 停止麦克风
function stopMic() {
  cancelAnimationFrame(mic.timer);
  mic.timer = 0;
  mic.stream?.getTracks().forEach((track) => track.stop());
  mic.ctx?.close().catch(() => {});
  mic.analyser = null;
  sceneFrame.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}

// 沙箱就绪时返回 iframe，否则 null
function activeFrameOrNull() {
  return state.sceneReady ? sceneFrame : null;
}

/* ---------------- 系统音频桥（media-bridge） ---------------- */

const bridge = { source: null, timer: 0, alive: false, mediaTimer: 0, base: "" };

// 把 64 段频谱发给沙箱
function pushBins(bands) {
  const frame = activeFrameOrNull();
  if (!frame) return;
  const left = new Array(64);
  for (let i = 0; i < 64; i++) left[i] = Math.max(0, Math.min(1, (bands[i] || 0) / 255));
  frame.contentWindow?.postMessage({ t: "audio", left, right: left }, "*");
}

// 断开桥并清空状态
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

/* media-bridge 的播放状态映射成 WebWallGL 的媒体快照 */
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

// 拉一次“正在播放”
async function pollMedia() {
  const frame = activeFrameOrNull();
  if (!frame) return;
  try {
    const res = await fetch(`${bridge.base}/v1/now`, { cache: "no-store" });
    if (!res.ok) return;
    const now = await res.json();
    frame.contentWindow?.postMessage({ t: "media", snapshot: mediaSnapshot(now) }, "*");
  } catch {
    /* 单次轮询失败忽略，下一拍再试 */
  }
}

// media-bridge 的 SSE：/v1/events?events=spectrum&spectrumMs=50
// 帧结构 { event:"spectrum", frame:{ bands:[64], rms, peak } }
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
      // 顺带刷新「正在播放」：定时器在后台会被节流，频谱帧本来就在持续到来
      const stamp = performance.now();
      if (stamp - (bridge.lastPoll || 0) > 900) {
        bridge.lastPoll = stamp;
        pollMedia();
      }
    } catch {
      /* 单帧解析失败忽略 */
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

// 停掉所有音频源
function stopAudioSources() {
  stopMic();
  stopBridge();
}

// 按设置切换音频源
async function applyAudioSource() {
  stopAudioSources();
  const source = state.settings.audioSource;
  if (source === "mic") await startMic();
  else if (source === "bridge") await startBridge();
  else activeFrameOrNull()?.contentWindow?.postMessage({ t: "audio", off: true }, "*");
}


