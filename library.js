"use strict";

/* 壁纸库：目录检测、扫描、列表渲染、变更监听 */

/* ---------------- 扫描 ---------------- */

// 浏览器无法枚举磁盘路径，但用户选一个上层目录后，这里能按已知安装布局
// 把真正要用的子目录找出来（Steam 库 / 创意工坊 / 官方独立版）。
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
    /* 无权限 */
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

// 返回该目录下所有“值得加入壁纸库”的目录
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

async function scanDir(dir, depth, root, out) {
  const entries = await entriesOf(dir);

  const project = entries.find((e) => e.kind === "file" && e.name === "project.json");
  if (project) {
    try {
      const text = await (await project.getFile()).text();
      const json = JSON.parse(text);
      out.push({ dir, name: dir.name, root, project: json });
    } catch {
      /* 损坏的 project.json 直接跳过 */
    }
  }

  if (depth <= 0) return;
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    await scanDir(entry, depth - 1, root, out);
  }
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
  // 兼容旧版：早期只存 FileSystemDirectoryHandle 本身
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
      status(`扫描目录 ${i + 1}/${roots.length}：${label}…`);
      if ((await permissionOf(handle)) !== "granted") {
        skipped++;
        continue;
      }
      await scanDir(handle, 5, label, found);
    }

    state.walls = found
      .map((w, index) => ({
        id: `${w.root}/${w.name}/${index}`,
        title: w.project.title || w.name,
        type: inferType(w.project),
        dir: w.dir,
        root: w.root,
        project: w.project,
      }))
      .filter((wall) => wall.type !== "web")
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));

    await renderWalls();
    if (skipped) status(`${skipped} 个目录未授权，点击「授权」后重新扫描`);
    else
      status(
        found.length
          ? `找到 ${found.length} 张壁纸`
          : "未找到壁纸。确认选择的是 projects 或 431960 目录"
      );
  } finally {
    scanning = false;
  }
}

/* ---------------- 壁纸库渲染 ---------------- */

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

    // ≤50 张：整块平铺、不出滚动条；>50 张：给可视区固定高度，出现 WinUI 风格滚动条，
    // 框内滚轮即可浏览全部（含第 50 张之后的）
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

// 可视高度按 5 整行算，避免底部切半行；面板隐藏时量不到高度，打开面板后再补一次
function alignWallHeight(list) {
  const card = list.querySelector(".card");
  if (!card) return;
  const height = card.getBoundingClientRect().height;
  if (height < 20) return;
  const gap = 8;
  const rows = 5;
  // +20：内边距 12 + 滚动条出现后卡片略变矮的余量
  list.style.setProperty("--wall-max", `${Math.round(rows * height + (rows - 1) * gap + 20)}px`);
}

function alignAllWallLists() {
  for (const list of document.querySelectorAll(".wallList.scrollable")) alignWallHeight(list);
}
/* ---------------- 目录监听 ---------------- */

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

// Chromium 的 FileSystemObserver：创意工坊新增/删除壁纸后自动刷新列表
async function startWatcher() {
  if (!("FileSystemObserver" in window)) return;
  try {
    fsObserver?.disconnect();
  } catch {
    /* 旧实例已失效 */
  }
  try {
    fsObserver = new FileSystemObserver(() => scheduleRescan());
    for (const item of state.roots) {
      try {
        await fsObserver.observe(rootEntry(item).handle, { recursive: true });
      } catch {
        /* 单个目录失败不影响其它 */
      }
    }
  } catch {
    fsObserver = null;
  }
}
