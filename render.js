/* 沙箱渲染页：加载 WebWallGL、预加载字体、处理属性/音频/视差消息，回传 ready/stats/diag。 */
"use strict";

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

    }
    try {
      Object.defineProperty(window, name, { configurable: true, value: make() });
    } catch {

    }
  }
})();

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

  }
})();

(function disableCacheStorage() {
  try {
    void window.caches;
    return;
  } catch {

  }
  try {
    Object.defineProperty(window, "caches", { configurable: true, value: undefined });
  } catch {

  }
})();

for (const level of ["warn", "error"]) {
  const raw = console[level].bind(console);
  console[level] = (...args) => {
    try {
      send({ t: "diag", level: level === "error" ? "error" : "warn", msg: args.map(String).join(" ").slice(0, 300) });
    } catch {

    }
    raw(...args);
  };
}

const stage = document.getElementById("stage");

const send = (msg, transfer) => parent.postMessage(msg, "*", transfer || []);

function errorText(error) {
  return `${error?.name || "Error"}: ${error?.message || error}`;
}

let audioBins = null;

const AUDIO_BANDS = 64;
const audioSmoothL = new Float32Array(AUDIO_BANDS);
const audioSmoothR = new Float32Array(AUDIO_BANDS);
const audioSilent = new Float32Array(AUDIO_BANDS);
let audioSmoothAt = 0;

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

const mediaSource = {
  get snapshot() { return mediaSnap; },
  update() { return mediaSnap; },
};
const pending = new Map();
let seq = 0;

function askRead(path) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ t: "read", id, path });
  });
}

function destroy() {
  if (instance) {
    try {
      instance.destroy({ releasePkgCache: true });
    } catch {

    }
    instance = null;
  }
  stage.textContent = "";
}

function applyProps(values) {
  if (!instance || !values) return;
  try {

    if (typeof instance.declareUserProperties === "function") instance.declareUserProperties(values);
    else instance.setProperties(values);
    applySoundVisibility();
  } catch (error) {
    send({ t: "diag", level: "warn", msg: `属性下发失败：${errorText(error)}` });
  }
}

function buildSource(msg) {
  return {
    key: msg.key,

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

const PARALLAX_FALLBACK_DEPTH = 1;
const parallaxOriginal = new WeakMap();
let parallaxEnabled = true;

function sceneWantsParallax() {
  const raw = window.__scene?.general?.cameraparallax;
  return raw === true || (raw && typeof raw === "object" && raw.value === true);
}

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

function applyCameraParallax() {
  const scene = window.__scene;
  if (!scene || !Array.isArray(scene.layers)) return;

  const on = parallaxEnabled && sceneWantsParallax();
  let patched = 0;

  for (const layer of scene.layers) {
    if (!layer || layer.destroyed) continue;
    if (layer.isSkybox || layer.skybox) continue;
    if (!on) {
      setLayerDepth(layer, [0, 0]);
      continue;
    }
    restoreLayerDepth(layer);
    if (layer.parallaxDepth) continue;
    setLayerDepth(layer, [PARALLAX_FALLBACK_DEPTH, PARALLAX_FALLBACK_DEPTH]);
    patched++;
  }

  if (patched) send({ t: "diag", level: "info", msg: `camera parallax：为 ${patched} 个图层补充默认视差深度` });
}

let engine = window.WebWallGL;
let engineLoading = null;

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

function matchesUserValue(value, condition) {
  const num = Number(value);
  const condNum = Number(condition);
  if (Number.isFinite(num) && Number.isFinite(condNum)) return num === condNum;
  return String(value) === String(condition);
}

let soundRulesPresent = false;

function applySoundVisibility() {
  const scene = window.__scene;
  const ctlProps = instance && typeof instance.getProperties === "function" ? instance.getProperties() : {};
  if (!scene || !Array.isArray(scene.layers)) return;
  for (const layer of scene.layers) {
    const spec = layer && layer.srcObject && layer.srcObject.volume && layer.srcObject.volume.scriptproperties;
    if (!spec || !spec.play) continue;

    soundRulesPresent = true;
    const ctl = layer.soundCtl;
    if (!ctl) continue;
    const rule = spec.play;
    const user = rule.user;
    let want = rule.value !== false;
    if (user && typeof user === "object" && typeof user.name === "string") {
      const current = ctlProps[user.name];
      want = user.condition === undefined ? !!current : matchesUserValue(current, user.condition);
    }
    const playing = typeof ctl.isPlaying === "function" ? ctl.isPlaying() : false;

    layer.__weWantSound = want;
    if (!layer.__weSoundGuard && ctl.play && ctl.stop) {
      const rawPlay = ctl.play.bind(ctl);
      const rawStop = ctl.stop.bind(ctl);
      ctl.play = () => {
        if (layer.__weWantSound) rawPlay();
      };
      ctl.stop = () => rawStop();
      layer.__weSoundGuard = true;
    }
    if (want) {
      if (typeof ctl.setVolume === "function") ctl.setVolume(1);
      if (!playing) ctl.play && ctl.play();
    } else {
      if (typeof ctl.setVolume === "function") ctl.setVolume(0);
      if (playing) ctl.stop && ctl.stop();
    }
  }
}

let instance = null;

const weFontsLoaded = new Set();
let weFontNames = null;

async function preloadWeFonts(port) {
  if (!port) return;
  try {
    const base = `http://127.0.0.1:${port}/wefonts/`;
    const names = weFontNames || (weFontNames = await (await fetch(base)).json());
    if (weFontsLoaded.size >= names.length) return;
    await Promise.all(
      names.map(async (name) => {
        if (weFontsLoaded.has(name)) return;
        try {
          const buffer = await (await fetch(base + encodeURIComponent(name))).arrayBuffer();
          const families = [`fonts/${name}`, name, name.replace(/\.[^.]+$/, "")];
          for (const family of families) {
            try {
              const face = new FontFace(family, buffer.slice(0));
              await face.load();
              document.fonts.add(face);
            } catch {

            }
          }
          weFontsLoaded.add(name);
        } catch {

        }
      })
    );
  } catch {

  }
}

async function mountScene(msg) {
  parallaxEnabled = msg.opts?.parallax !== false;

  await preloadWeFonts(msg.opts?.webPort);
  if (!engine) {
    try {
      await loadEngine();
    } catch (error) {
      send({ t: "error", msg: errorText(error) });
      return;
    }
  }

  destroy();
  audioBins = null;
  audioSmoothL.fill(0);
  audioSmoothR.fill(0);

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

  try {
    instance.setAudio?.({ snapshot: audioSnapshot });
  } catch {

  }

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
    applySoundVisibility();
    setTimeout(applySoundVisibility, 800);

    if (msg.props && Object.keys(msg.props).length) {
      try {
        applyProps(msg.props);
            } catch (e) {
        send({ t: "diag", level: "warn", msg: `选项下发失败：${errorText(e)}` });
      }
    }
  } catch (error) {
    send({ t: "error", msg: errorText(error), stack: String(error?.stack || "") });
  }
}

window.addEventListener("message", (event) => {
  const data = event.data;

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
    try { instance.setVolume(Math.max(0, Math.min(1, Number(data.value) || 0))); } catch {  }
  }

  if (data.t === "media") {
    mediaSnap = data.off ? null : data.snapshot || null;
    return;
  }

  if (data.t === "audio") {
    if (data.off) audioBins = null;
    else if (data.left && data.right && typeof data.left.length === "number" && typeof data.right.length === "number") {

      audioBins = { left: data.left, right: data.right };
    }
  }

  if (data.t === "stop") destroy();

  if (data.t === "ping") send({ t: "pong" });

  if (data.t === "props" && data.props) applyProps(data.props);
});

let soundBurstTimer = 0;

function syncSoundBurst() {
  if (!soundRulesPresent) return;
  clearInterval(soundBurstTimer);
  let ticks = 0;
  applySoundVisibility();

  soundBurstTimer = setInterval(() => {
    applySoundVisibility();
    if (++ticks >= 20) clearInterval(soundBurstTimer);
  }, 100);
}

for (const evt of ["pointerdown", "keydown"]) {
  window.addEventListener(evt, syncSoundBurst, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncSoundBurst();
});

document.addEventListener("visibilitychange", () => {
  if (!instance) return;
  try {
    if (document.hidden) instance.pause();
    else instance.resume();
  } catch {

  }
});

setInterval(() => {
  if (!instance) return;
  if (soundRulesPresent) applySoundVisibility();
  const stats = instance.stats;
  if (stats) send({ t: "stats", fps: Math.round(stats.fps || 0), running: !!stats.running });
}, 1000);

send({ t: "boot" });

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

    }
  }, { passive: true });
})();
