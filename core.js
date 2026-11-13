/* 全局状态与 DOM 引用：设置默认值、运行状态、共享元素查询。 */
"use strict";

const $ = (id) => document.getElementById(id);
const vid = $("vid");
const img = $("img");

vid.disablePictureInPicture = true;
vid.disableRemotePlayback = true;
vid.removeAttribute("controls");
const sceneFrame = $("scene");

const webFrame = $("web");

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
  enableWebService: false,
  enableBridgeService: false,
};

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
  webPort: 0,
  propTypes: {},
  webInfo: null,
};

const SKIP_DIRS = new Set(["node_modules", ".git", "preview", "backup", "cache"]);
const TYPE_LABEL = { scene: "场景", video: "视频", web: "网页", image: "图片", gif: "GIF", application: "应用" };

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("we-newtab", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadSettings() {
  const got = await chrome.storage.local.get("settings");
  state.settings = { ...DEFAULTS, ...(got.settings || {}) };
}

function saveSettings() {
  chrome.storage.local.set({ settings: state.settings });
}

async function permissionOf(handle) {
  const q = await handle.queryPermission({ mode: "read" });
  return q;
}

async function ensurePermission(handle) {
  if ((await permissionOf(handle)) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

async function dirByPath(root, parts) {
  let cur = root;
  for (const part of parts) cur = await cur.getDirectoryHandle(part);
  return cur;
}

async function fileInfo(root, path) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  const dir = parts.length ? await dirByPath(root, parts) : root;
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return { dir, file, name };
}

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

  }
  await chrome.storage.local.set({ legacyCachePurged: true });
}
