/* 壁纸库：扫描 Steam 库/创意工坊目录，解析 project.json，生成分类与封面。 */
"use strict";

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

async function mapPool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

let hostScanCache = null;
let hostScanAt = 0;

async function rescan(force) {
  const fresh = !force && hostScanCache && Date.now() - hostScanAt < 30000;
  const hostScan = fresh ? hostScanCache : await scanWalls().catch(() => null);
  if (!fresh && hostScan) {
    hostScanCache = hostScan;
    hostScanAt = Date.now();
  }
  if (hostScan && Array.isArray(hostScan.roots)) state.hostRoots = hostScan.roots;
  if (hostScan && hostScan.entries && hostScan.entries.length) {
    const port = await ensureWebService();
    const walls = new Array(hostScan.entries.length).fill(null);
    await mapPool(hostScan.entries, 12, async (item, index) => {
      const base = `http://127.0.0.1:${port}/asset/${encodeURIComponent(item.hostId)}`;
      let project = item.project || null;
      if (!project) {
        try {
          const res = await fetch(`${base}/project.json`);
          if (res.ok) project = await res.json();
        } catch {
          project = null;
        }
      }
      if (!project) return;
      walls[index] = {
        id: `host:${item.hostId}`,
        hostId: item.hostId,
        name: String(item.dir || "").split(/[\\/]/).pop(),
        title: project.title || item.title || item.dir,
        type: inferType(project),
        dir: null,
        root: "host",
        project,
        previewRel: project.preview || item.preview || "",
        rating: ratingTier({ project }),
      };
    });
    const validWalls = walls.filter(Boolean);
    if (validWalls.length) {
      state.walls = validWalls.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      await renderWalls();
      notice(`找到 ${validWalls.length} 张壁纸（宿主扫描）`);
      return;
    }
  }
  // 宿主扫描不可用：不再回退旧 FSA 扫描（旧实现已停用）
  state.walls = [];
  await renderWalls();
  notice("未发现壁纸：请确认已安装辅助程序，或添加壁纸目录");
  return;

}

async function previewUrl(wall) {
  if (wall.hostId) {
    const port = state.webPort;
    return port ? `http://127.0.0.1:${port}/thumb/${encodeURIComponent(wall.hostId)}` : "";
  }
  return null;
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
  const allow = ratingAllowSet();
  const visible = state.walls.filter((wall) => allow.has(wall.rating));
  $("count").textContent = String(visible.length);
  clearThumbs();
  const observer = ensurePreviewObserver();

  for (const group of WALL_GROUPS) {
    const items = visible.filter((wall) => wall.type === group.type);
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
