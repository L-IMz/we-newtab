"use strict";

/* 沙箱页：只负责把 WebWallGL 挂到 canvas 上。与外壳仅靠 postMessage 通信。 */

/* 沙箱页是不透明源：读取 localStorage / sessionStorage 会抛 SecurityError，
   连 `typeof` 探测都会炸。属性本身可配置，直接遮蔽成内存实现。 */
(function shimStorage() {
  const make = () => {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => mem.set(String(k), String(v)),
      removeItem: (k) => mem.delete(String(k)),
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    };
  };

  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      void window[name];
      continue;
    } catch {
      /* 不可用，继续遮蔽 */
    }
    try {
      Object.defineProperty(window, name, { configurable: true, value: make() });
    } catch {
      /* 遮蔽失败时由壁纸自身报错 */
    }
  }
})();

/* DOMException.message 只有 getter：库在 catch 里做 err.message += "…" 会再抛 TypeError，
   把真实失败原因吞掉。补一个可写 message，保留原始 name/message。 */
(function makeDomExceptionMessageWritable() {
  try {
    const proto = DOMException.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "message");
    if (!desc || desc.set) return;
    const overrides = new WeakMap();
    Object.defineProperty(proto, "message", {
      configurable: true,
      get() {
        return overrides.has(this) ? overrides.get(this) : desc.get.call(this);
      },
      set(value) {
        overrides.set(this, String(value));
      },
    });
  } catch {
    /* 改不了就算了，不影响主流程 */
  }
})();

/* 沙箱页读取 window.caches 会抛 SecurityError，连 `typeof caches` 都会炸。库用 typeof
   探测后端，这里把 caches 置空让它回落到内存缓存。 */
(function disableCacheStorage() {
  try {
    void window.caches;
    return;
  } catch {
    /* 继续，尝试遮蔽 */
  }
  try {
    Object.defineProperty(window, "caches", { configurable: true, value: undefined });
  } catch {
    /* 遮蔽失败时由上层错误处理兜底 */
  }
})();

const stage = document.getElementById("stage");

const send = (msg, transfer) => parent.postMessage(msg, "*", transfer || []);
let engine = window.WebWallGL;
let engineLoading = null;



let instance = null;
// 宿主推来的实时频谱；为空时引擎用自己的模拟源
let audioBins = null;

/* 音频快照：宿主送来的频谱只有 10–16Hz，直接喂给引擎会有明显阶梯感。
   这里按帧做指数平滑（起得快、落得慢），引擎每帧读到的都是连续值。 */
const AUDIO_BANDS = 64;
const audioSmoothL = new Float32Array(AUDIO_BANDS);
const audioSmoothR = new Float32Array(AUDIO_BANDS);
const audioSilent = new Float32Array(AUDIO_BANDS);
let audioSmoothAt = 0;

// 取当前平滑后的频谱（左右声道各自独立，指数起落）
function audioSnapshot() {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - audioSmoothAt) / 1000));
  audioSmoothAt = now;
  const attack = 1 - Math.exp(-dt * 28);
  const release = 1 - Math.exp(-dt * 9);
  const left = audioBins ? audioBins.left : audioSilent;
  const right = audioBins ? audioBins.right : audioSilent;
  for (let i = 0; i < AUDIO_BANDS; i++) {
    const goalL = Number(left[i]) || 0;
    audioSmoothL[i] += (goalL - audioSmoothL[i]) * (goalL > audioSmoothL[i] ? attack : release);
    const goalR = Number(right[i]) || 0;
    audioSmoothR[i] += (goalR - audioSmoothR[i]) * (goalR > audioSmoothR[i] ? attack : release);
  }
  return { left: audioSmoothL, right: audioSmoothR };
}
let mediaSnap = null;
// 引擎判断媒体源读的是 snapshot 属性本身（snapshot.hasMedia），所以用 getter 暴露最新快照
const mediaSource = {
  get snapshot() { return mediaSnap; },
  update() { return mediaSnap; },
};
const pending = new Map();
let seq = 0;

// 请外壳读取散装工程里的文件
function askRead(path) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ t: "read", id, path });
  });
}

// 销毁引擎实例并清理计时器
function destroy() {
  if (instance) {
    try {
      instance.destroy({ releasePkgCache: true });
    } catch {
      /* 已销毁 */
    }
    instance = null;
  }
  stage.textContent = "";
}

// 把属性下发给引擎（含图层绑定与可见性）
function applyProps(values) {
  if (!instance || !values) return;
  try {
    // declareUserProperties 会更新 liveUserProps、图层绑定与可见性，并通知脚本；
    // setProperties 只转发给脚本，属性条件驱动的图层不会跟着变。
    if (typeof instance.declareUserProperties === "function") instance.declareUserProperties(values);
    else instance.setProperties(values);
  } catch (error) {
    send({ t: "diag", level: "warn", msg: `属性下发失败：${errorText(error)}` });
  }
}

// 依据壁纸布局构造 load() 的入参
function buildSource(msg) {
  return {
    key: msg.key,
    // 直接用外壳传进来的 File 句柄读取：File 走结构化克隆只传引用，
    // 避免几百 MB 的包在两侧各拷一份
    async scenePkg() {
      if (msg.pkgFile) return new Uint8Array(await msg.pkgFile.arrayBuffer());
      if (!msg.pkg) throw new Error("缺少 scene.pkg");
      return msg.pkg;
    },
    async project() {
      return msg.project || null;
    },
    async sceneDir() {
      if (!msg.entry) return null;
      return {
        entry: msg.entry,
        read: async (name) => {
          const file = await askRead(name);
          if (!file) return null;
          if (file instanceof Blob) return new Uint8Array(await file.arrayBuffer());
          return new Uint8Array(file);
        },
      };
    },
  };
}

// WE 的相机视差由「全局相机」驱动，而本引擎把偏移乘到每个图层的 parallaxDepth 上。
// 有些壁纸只开了 cameraparallax、图层没有 parallaxDepth，就会一点位移都没有。
// 这里按「扩展开关 + 壁纸自己的视差属性 + 场景 cameraparallax」三者共同决定是否注入深度。
const PARALLAX_FALLBACK_DEPTH = 1;
const parallaxOriginal = new WeakMap();
let parallaxEnabled = true;

// 从场景属性判断作者是否启用视差
function sceneWantsParallax() {
  const raw = window.__scene?.general?.cameraparallax;
  return raw === true || (raw && typeof raw === "object" && raw.value === true);
}

// 引擎在装配时会把 parallaxDepth 快照到 parallaxDepthOwn，运行时两个都要改
function setLayerDepth(layer, depth) {
  if (!parallaxOriginal.has(layer)) {
    parallaxOriginal.set(layer, {
      depth: layer.parallaxDepth || null,
      own: layer.parallaxDepthOwn || null,
    });
  }
  layer.parallaxDepth = depth;
  if ("parallaxDepthOwn" in layer) layer.parallaxDepthOwn = depth;
}

// 恢复图层原始视差深度
function restoreLayerDepth(layer) {
  if (!parallaxOriginal.has(layer)) return;
  const original = parallaxOriginal.get(layer);
  for (const [key, value] of [["parallaxDepth", original.depth], ["parallaxDepthOwn", original.own]]) {
    if (!(key in layer)) continue;
    if (value) layer[key] = value;
    else delete layer[key];
  }
  parallaxOriginal.delete(layer);
}

// 为缺少深度的图层补默认值
function applyCameraParallax() {
  const scene = window.__scene;
  if (!scene || !Array.isArray(scene.layers)) return;

  const on = parallaxEnabled && sceneWantsParallax();
  let patched = 0;

  for (const layer of scene.layers) {
    if (!layer || layer.destroyed) continue;
    if (layer.isSkybox || layer.skybox) continue; // 天空盒不跟随
    if (!on) {
      setLayerDepth(layer, [0, 0]); // 关掉：作者定义的深度也归零
      continue;
    }
    restoreLayerDepth(layer);
    if (layer.parallaxDepth) continue; // 作者已定义，尊重原值
    setLayerDepth(layer, [PARALLAX_FALLBACK_DEPTH, PARALLAX_FALLBACK_DEPTH]);
    patched++;
  }

  if (patched) send({ t: "diag", level: "info", msg: `camera parallax：为 ${patched} 个图层补充默认视差深度` });
}
// 按需加载引擎（1MB），避免每个新标签页都提前解析
function loadEngine() {
  if (engine) return Promise.resolve(engine);
  if (engineLoading) return engineLoading;
  engineLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/webwallgl.global.min.js";
    script.onload = () => {
      engine = window.WebWallGL;
      resolve(engine);
    };
    script.onerror = () => {
      engineLoading = null;
      reject(new Error("WebWallGL 脚本加载失败"));
    };
    document.head.appendChild(script);
  });
  return engineLoading;
}

// 创建引擎实例并加载壁纸
async function mountScene(msg) {
  parallaxEnabled = msg.opts?.parallax !== false;
  if (!engine) {
    try {
      await loadEngine();
    } catch (error) {
      send({ t: "error", msg: errorText(error) });
      return;
    }
  }

  destroy();
  const opts = msg.opts || {};
  try {
    instance = engine.createScene(stage, {
      fit: opts.fit || "cover",
      fps: Number(opts.fps) || 60,
      renderDpr: Number(opts.dpr) || 0,
      quality: opts.quality || {},
      scripts: opts.scripts !== false,
      properties: msg.props || {},
      audio: { snapshot: audioSnapshot },
      media: mediaSource,
      autoplay: true,
      volume: Math.max(0, Math.min(1, Number(opts.volume) || 0)),
      autoQuality: true,
      mountTimeoutMs: 30000,
    });
  } catch (error) {
    send({ t: "error", msg: errorText(error), stack: String(error?.stack || "") });
    return;
  }

  // 先挂监听再 load：ready/error 可能早于 load() 的 Promise 落地
  instance.on("diagnostic", (text, level) => {
    if (level !== "info") send({ t: "diag", msg: text, level });
  });
  instance.on("error", (error) => send({ t: "error", msg: errorText(error) }));
  instance.on("ready", (info) => {
    applyCameraParallax();
    send({
      t: "ready",
      width: info.width,
      height: info.height,
      layers: info.layerCount,
    });
  });

  try {
    await instance.load(buildSource(msg));
    applyCameraParallax();
    // load() 之后再推一次：部分壁纸在装配期不消费 properties，只有热更才生效
    if (msg.props && Object.keys(msg.props).length) {
      try {
        applyProps(msg.props);
        send({ t: "propsstate", values: instance.getProperties() });
      } catch (e) {
        send({ t: "diag", level: "warn", msg: `选项下发失败：${errorText(e)}` });
      }
    }
  } catch (error) {
    send({ t: "error", msg: errorText(error), stack: String(error?.stack || "") });
  }
}

// 统一的错误文本
function errorText(error) {
  return `${error?.name || "Error"}: ${error?.message || error}`;
}

window.addEventListener("message", (event) => {
  const data = event.data;
  // 网页壁纸内部的运行期异常通常只影响某个特效模块，不该判成整张壁纸加载失败
  if (data && data.__weerr) send({ t: "diag", level: "warn", msg: `网页壁纸脚本异常：${data.__weerr}` });
  if (!data || !data.t) return;


  if (data.t === "read:res") {
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.file || data.bytes || null);
    }
    return;
  }

  if (data.t === "mount") {
    mountScene(data);
    return;
  }

  if (data.t === "update" && instance) {
    const opts = data.opts || {};
    try {
      if (opts.fps) instance.setFps(Number(opts.fps));
      if (opts.fit) instance.setFit(opts.fit);
      if (opts.quality) instance.setQuality(opts.quality);
      if (opts.dpr !== undefined) instance.setRenderDpr(Number(opts.dpr) || 0);
    } catch (error) {
      send({ t: "diag", msg: String(error?.message || error), level: "warn" });
    }
    return;
  }

  if (data.t === "volume" && instance) {
    try { instance.setVolume(Math.max(0, Math.min(1, Number(data.value) || 0))); } catch { /* 忽略 */ }
  }

  // 媒体信息：宿主从 media-bridge 拿到的「正在播放」
  if (data.t === "media") {
    mediaSnap = data.off ? null : data.snapshot || null;
    return;
  }

  // 音频响应：宿主推来的麦克风频谱（可选）
  if (data.t === "audio") {
    if (data.off) audioBins = null;
    else if (Array.isArray(data.left) && Array.isArray(data.right)) audioBins = { left: data.left, right: data.right };
  }


  if (data.t === "stop") destroy();

  if (data.t === "ping") send({ t: "pong" });


  if (data.t === "props" && data.props) applyProps(data.props);
});

// 标签页不可见时暂停渲染，回来再继续（后台不再空转 GPU）
document.addEventListener("visibilitychange", () => {
  if (!instance) return;
  try {
    if (document.hidden) instance.pause();
    else instance.resume();
  } catch {
    /* 引擎可能已销毁 */
  }
});

setInterval(() => {
  if (!instance) return;
  const stats = instance.stats;
  if (stats) send({ t: "stats", fps: Math.round(stats.fps || 0), running: !!stats.running });
}, 1000);

send({ t: "boot" });
/* 触摸：引擎只监听 mousemove，触摸屏不会产生视差。
   这里把触摸坐标换算成归一化坐标，直接推给引擎的指针控制器。 */
(function bindTouchPointer() {
  const area = document.getElementById("stage") || document.body;
  if (!area) return;
  let last = { u: 0.5, v: 0.5 };

  const push = (clientX, clientY, buttons) => {
    const rect = area.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const u = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const v = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    last = { u, v };
    if (!instance) return;
    try {
      instance.pushPointer(u, v, buttons);
    } catch {
      /* 引擎可能尚未就绪 */
    }
  };

  area.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    if (touch) push(touch.clientX, touch.clientY, 1);
  }, { passive: true });

  area.addEventListener("touchmove", (event) => {
    const touch = event.touches[0];
    if (touch) push(touch.clientX, touch.clientY, 1);
  }, { passive: true });

  area.addEventListener("touchend", () => {
    if (!instance) return;
    try {
      instance.pushPointer(last.u, last.v, 0);
    } catch {
      /* 忽略 */
    }
  }, { passive: true });
})();
