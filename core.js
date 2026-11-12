"use strict";

/* 基础层：DOM 引用、默认设置与运行状态、IndexedDB / chrome.storage 封装、目录授权与文件读取。
   所有模块都直接依赖这里的 $()、state、loadSettings/saveSettings、kvGet/kvSet。 */

/* ---------------- DOM 引用 ---------------- */

const $ = (id) => document.getElementById(id);
const vid = $("vid");
const img = $("img");
// 关掉画中画/远程播放入口，避免视频壁纸弹出浏览器浮层
vid.disablePictureInPicture = true;
vid.disableRemotePlayback = true;
vid.removeAttribute("controls");
const sceneFrame = $("scene");

/* ---------------- 默认设置 ---------------- */

const DEFAULTS = {
  fps: 30,
  dpr: 1,
  aa: "fxaa",
  particles: "high",
  post: "high",
  fit: "cover",
  rate: 1,
  scripts: true,
  parallax: true,
  monet: true,
  clockShow: true,
  clockSize: 112,
  clockWeight: 300,
  clockFont: "system",
  clockX: 50,
  clockY: 42,
  hitokotoShow: true,
  hitokotoSize: 14,
  hitokotoFont: "system",
  hitokotoCustomName: "",
  brightness: 100,
  volume: 0,
  audioSource: "off",
  bridgePort: 8765,
  rotate: false,
  rotateEvery: 5,
  rotateRandom: false,
};

/* ---------------- 运行状态 ---------------- */

const state = {
  settings: { ...DEFAULTS },
  roots: [],
  walls: [],
  current: null,
  thumbs: [],
  sceneReady: false,
  mediaUrl: null,
  sceneRunning: false,
  previewCache: new Map(),
  gpuPref: null,
  tab: "wall",
  fps: 0,
  effectiveDpr: null,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "preview", "backup", "cache"]);
const TYPE_LABEL = { scene: "场景", video: "视频", web: "网页", image: "图片", gif: "GIF", application: "应用" };

/* ---------------- 存储 ---------------- */

// 打开或创建本地数据库（只有一个 kv 存储）
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("we-newtab", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 读一个键
async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

// 写一个键
async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 载入设置并与默认值合并
async function loadSettings() {
  const got = await chrome.storage.local.get("settings");
  state.settings = { ...DEFAULTS, ...(got.settings || {}) };
}

// 保存设置到 chrome.storage
function saveSettings() {
  chrome.storage.local.set({ settings: state.settings });
}

/* ---------------- 目录授权 ---------------- */

// 查询目录句柄的读取权限
async function permissionOf(handle) {
  const q = await handle.queryPermission({ mode: "read" });
  return q;
}

// 必要时弹出目录授权请求
async function ensurePermission(handle) {
  if ((await permissionOf(handle)) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

// 按路径逐级取子目录句柄
async function dirByPath(root, parts) {
  let cur = root;
  for (const part of parts) cur = await cur.getDirectoryHandle(part);
  return cur;
}

// 按相对路径取文件句柄与内容
async function fileInfo(root, path) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  const dir = parts.length ? await dirByPath(root, parts) : root;
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return { dir, file, name };
}


/* ---------------- 清理旧版缓存 ---------------- */

// 旧版本把视频/场景包写进了 IndexedDB，新版不再使用，这里一次性删掉
async function purgeLegacyCache() {
  const flag = await chrome.storage.local.get("legacyCachePurged");
  if (flag.legacyCachePurged) return;
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const store = db.transaction("kv", "readwrite").objectStore("kv");
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const key = String(cursor.key);
        if (key.startsWith("dyn:") || key === "dynIndex" || key.startsWith("poster:")) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => resolve();
    });
  } catch {
    /* 清理失败不影响使用 */
  }
  await chrome.storage.local.set({ legacyCachePurged: true });
}
