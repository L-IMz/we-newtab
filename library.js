/* 壁纸库：扫描 Steam 库/创意工坊目录，解析 project.json，生成分类与封面。 */
"use strict";

const LAYOUT_HINTS = [
  ["steamapps", "workshop", "content", "431960"],
  ["steamapps", "common", "wallpaper_engine"],
  ["steamapps", "common", "wallpaper_engine", "projects"],
  ["common", "wallpaper_engine"],
  ["common", "wallpaper_engine", "projects"],
  ["workshop", "content", "431960"],
  ["steamapps"],
  ["wallpaper_engine"],
  ["wallpaper_engine", "projects"],
  ["projects"],
];

function lowerMap(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.name.toLowerCase(), entry);
  return map;
}

async function entriesOf(dir) {
  const out = [];
  try {
    for await (const entry of dir.values()) out.push(entry);
  } catch {

  }
  return out;
}

async function resolveChain(dir, parts) {
  let current = dir;
  for (const part of parts) {
    const entry = lowerMap(await entriesOf(current)).get(part.toLowerCase());
    if (!entry || entry.kind !== "directory") return null;
    current = entry;
  }
  return current;
}

async function detectRoots(handle) {
  const found = [];
  const seen = new Set();

  const push = (dir, label) => {
    if (!dir) return;
    const key = label || dir.name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ handle: dir, label: key });
  };

  for (const parts of LAYOUT_HINTS) {
    const hit = await resolveChain(handle, parts);
    if (hit) push(hit, parts.join("/"));
  }
  return found;
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

let projectCache = null;
let projectCacheDirty = false;

async function loadProjectCache() {
  if (!projectCache) projectCache = (await kvGet("projectCache").catch(() => null)) || {};
  return projectCache;
}

function flushProjectCache() {
  if (!projectCache || !projectCacheDirty) return;
  projectCacheDirty = false;
  kvSet("projectCache", projectCache).catch(() => {});
}

async function scanDir(dir, depth, root, out) {
  const entries = await entriesOf(dir);
  const cache = await loadProjectCache();

  const project = entries.find((e) => e.kind === "file" && e.name === "project.json");
  if (project) {
    try {
      const file = await project.getFile();
      const key = `${root}/${dir.name}`;
      const hit = cache[key];
      let json;
      if (hit && hit.mtime === file.lastModified && hit.size === file.size) {
        json = hit.project;
      } else {
        json = JSON.parse(await file.text());
        cache[key] = { mtime: file.lastModified, size: file.size, project: json };
        projectCacheDirty = true;
      }
      out.push({ dir, name: dir.name, root, project: json });
    } catch {

    }
  }

  if (depth <= 0) return;
  const dirs = entries.filter(
    (entry) => entry.kind === "directory" && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")
  );
  await mapLimit(dirs, 8, (entry) => scanDir(entry, depth - 1, root, out));
}

function inferType(project) {
  const raw = String(project.type || "").toLowerCase();
  if (TYPE_LABEL[raw]) return raw;
  const file = String(project.file || "").toLowerCase();
  if (file.endsWith(".mp4") || file.endsWith(".webm")) return "video";
  if (file.endsWith(".html")) return "web";
  if (file.endsWith(".gif")) return "gif";
  return "scene";
}

function rootEntry(item) {

  if (item && typeof item.kind === "string") return { handle: item, label: item.name };
  return item;
}

async function rescan() {
  if (scanning) return;
  scanning = true;
  try {
    const found = [];
    const roots = state.roots.filter(Boolean).map(rootEntry);
    if (!roots.length) {
      renderRoots();
      return;
    }

    let skipped = 0;
    for (let i = 0; i < roots.length; i++) {
      const { handle, label } = roots[i];
      notice(`扫描目录 ${i + 1}/${roots.length}：${label}…`);
      if ((await permissionOf(handle)) !== "granted") {
        skipped++;
        continue;
      }
      await scanDir(handle, 5, label, found);
    }

    flushProjectCache();

    state.walls = found
      .map((w) => ({

        id: `${w.root}/${w.name}`,
        title: w.project.title || w.name,
        type: inferType(w.project),
        dir: w.dir,
        root: w.root,
        project: w.project,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));

    await renderWalls();
    if (skipped) notice(`${skipped} 个目录未授权，点击「授权」后重新扫描`);
    else
      notice(
        found.length
          ? `找到 ${found.length} 张壁纸`
          : "未找到壁纸。确认选择的是 projects 或 431960 目录"
      );
  } finally {
    scanning = false;
  }
}

async function previewUrl(wall) {
  const name = wall.project.preview;
  if (!name) return null;
  try {
    const { file } = await fileInfo(wall.dir, name);
    const url = URL.createObjectURL(file);
    state.thumbs.push(url);
    return url;
  } catch {
    return null;
  }
}

function clearThumbs() {
  for (const url of state.thumbs) URL.revokeObjectURL(url);
  state.thumbs = [];
  state.previewCache.clear();
}

let previewObserver = null;

function ensurePreviewObserver() {
  if (previewObserver) return previewObserver;
  previewObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        previewObserver.unobserve(entry.target);
        loadPreview(entry.target);
      }
    },
    { root: $("panel"), rootMargin: "400px" }
  );
  return previewObserver;
}

async function loadPreview(card) {
  const wall = state.walls.find((item) => item.id === card.dataset.id);
  if (!wall) return;
  let url = state.previewCache.get(wall.id);
  if (!url) {
    url = await previewUrl(wall);
    if (!url) return;
    state.previewCache.set(wall.id, url);
  }
  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  image.loading = "lazy";
  card.insertBefore(image, card.firstChild);
}

const WALL_GROUPS = [
  { type: "scene", label: "场景壁纸" },
  { type: "video", label: "视频壁纸" },
  { type: "web", label: "网页壁纸" },
  { type: "image", label: "图片壁纸" },
  { type: "gif", label: "动态图片" },
];
const MAX_PREVIEW = 50;

function wallCard(wall) {
  const card = document.createElement("button");
  card.className = "card";
  card.title = wall.title;
  card.dataset.id = wall.id;
  if (state.current && state.current.id === wall.id) card.classList.add("active");

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = wall.title;
  card.appendChild(name);

  card.addEventListener("click", () => play(wall).catch(reportError));
  return card;
}

async function renderWalls() {
  const box = $("walls");
  box.textContent = "";
  $("count").textContent = String(state.walls.length);
  clearThumbs();
  const observer = ensurePreviewObserver();

  for (const group of WALL_GROUPS) {
    const items = state.walls.filter((wall) => wall.type === group.type);
    if (!items.length) continue;

    const section = document.createElement("div");
    section.className = "wallGroup";

    const head = document.createElement("div");
    head.className = "wallGroupHead";
    head.textContent = group.label;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(items.length);
    head.appendChild(badge);
    section.appendChild(head);

    const list = document.createElement("div");
    list.className = "wallList";
    section.appendChild(list);

    for (const wall of items) {
      const card = wallCard(wall);
      list.appendChild(card);
      observer.observe(card);
    }

    if (items.length > MAX_PREVIEW) {
      list.classList.add("scrollable");
      alignWallHeight(list);
      const more = document.createElement("p");
      more.className = "hint wallMore";
      more.textContent = `共 ${items.length} 张，框内滚动查看全部`;
      section.appendChild(more);
    }
    box.appendChild(section);
  }
}

function wallListMax(cardHeight) {
  const gap = 8;
  const rows = 5;
  return Math.round(rows * cardHeight + (rows - 1) * gap + 20);
}

function alignWallHeight(list) {
  const card = list.querySelector(".card");
  if (!card) return;
  const height = card.getBoundingClientRect().height;
  if (height < 20) return;
  list.style.setProperty("--wall-max", `${wallListMax(height)}px`);
}

function alignAllWallLists() {
  const lists = [...document.querySelectorAll(".wallList.scrollable")];
  const heights = lists.map((list) => {
    const card = list.querySelector(".card");
    return card ? card.getBoundingClientRect().height : 0;
  });
  lists.forEach((list, index) => {
    if (heights[index] < 20) return;
    list.style.setProperty("--wall-max", `${wallListMax(heights[index])}px`);
  });
}

let fsObserver = null;
let rescanTimer = 0;
let scanning = false;

function scheduleRescan(delay = 1500) {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    if (scanning) return scheduleRescan(2000);
    rescan().catch(() => {});
  }, delay);
}

async function startWatcher() {
  if (!("FileSystemObserver" in window)) return;
  try {
    fsObserver?.disconnect();
  } catch {

  }
  try {
    fsObserver = new FileSystemObserver(() => scheduleRescan());
    for (const item of state.roots) {
      try {
        await fsObserver.observe(rootEntry(item).handle, { recursive: true });
      } catch {

      }
    }
  } catch {
    fsObserver = null;
  }
}

const WE_WORKSHOP_URL = "https://steamcommunity.com/app/431960/workshop/";

function openSteamWorkshop() {
  const url = WE_WORKSHOP_URL;
  try {
    if (chrome?.tabs?.create) {
      const opened = chrome.tabs.create({ url });
      if (opened && typeof opened.catch === "function") {
        opened.catch(() => window.open(url, "_blank"));
      }
      return;
    }
  } catch {

  }
  window.open(url, "_blank");
}
