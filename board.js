"use strict";

/* 自定义页：网格组件（图标 / 时钟 / 搜索 / 便签 / 倒计时 / 天气）+ 莫奈取色。
   组件按格子定位，拖动后吸附；所有配置存 chrome.storage.local。 */

const TILE_GAP = 12;
const WEATHER_TTL = 30 * 60 * 1000;

const SEARCH_ENGINES = {
  bing: "https://www.bing.com/search?q=",
  google: "https://www.google.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  duck: "https://duckduckgo.com/?q=",
};

const WEATHER_CODES = {
  0: "晴", 1: "多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾",
  51: "小雨", 53: "小雨", 55: "小雨", 61: "雨", 63: "雨", 65: "大雨",
  71: "雪", 73: "雪", 75: "大雪", 80: "阵雨", 81: "阵雨", 82: "暴雨",
  95: "雷雨", 96: "雷雨", 99: "雷雨",
};

const board = {
  tiles: [],
  selected: null,
  visible: false,
  palette: null,
};

let dragState = null;
let tickTimer = 0;
const weatherCache = new Map();

/* ---------------- 网格 ---------------- */

function boardMetrics() {
  const box = document.getElementById("tiles");
  if (!box) return { cell: 96, cols: 12, rows: 6 };
  // 页面隐藏时尺寸为 0，用窗口尺寸兜底，避免新组件全堆在 (0,0)
  const width = box.clientWidth > 0 ? box.clientWidth : Math.max(400, window.innerWidth - 128);
  const height = box.clientHeight > 0 ? box.clientHeight : Math.max(300, window.innerHeight - 196);
  const cell = Math.max(64, Math.min(112, Math.floor(width / 12)));
  const cols = Math.max(1, Math.floor((width + TILE_GAP) / (cell + TILE_GAP)));
  const rows = Math.max(1, Math.floor((height + TILE_GAP) / (cell + TILE_GAP)));
  return { cell, cols, rows, width, height };
}

function suggestedSize(type) {
  switch (type) {
    case "clock": return { w: 3, h: 2 };
    case "search": return { w: 4, h: 1 };
    case "note": return { w: 3, h: 2 };
    case "countdown": return { w: 2, h: 2 };
    case "weather": return { w: 2, h: 2 };
    default: return { w: 1, h: 1 };
  }
}

function tileStyle(tile, metrics) {
  const step = metrics.cell + TILE_GAP;
  return {
    left: `${tile.x * step}px`,
    top: `${tile.y * step}px`,
    width: `${tile.w * step - TILE_GAP}px`,
    height: `${tile.h * step - TILE_GAP}px`,
  };
}

/* ---------------- 组件内容 ---------------- */

function countdownDays(tile) {
  const target = tile.config?.date;
  if (!target) return "--";
  const diff = new Date(`${target}T00:00:00`).getTime() - Date.now();
  if (Number.isNaN(diff)) return "--";
  const days = Math.ceil(diff / 86400000);
  if (days === 0) return "今天";
  return days > 0 ? `${days} 天` : `已过 ${-days} 天`;
}

function goSearch(engine, text) {
  const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES.bing;
  window.location.href = base + encodeURIComponent(text.trim());
}

function widgetBody(tile) {
  const wrap = document.createElement("div");
  wrap.className = "wb";

  switch (tile.type) {
    case "clock": {
      wrap.classList.add("wb-clock");
      const time = document.createElement("div");
      time.className = "wb-time";
      time.dataset.role = "time";
      const date = document.createElement("div");
      date.className = "wb-date";
      date.dataset.role = "date";
      wrap.append(time, date);
      break;
    }
    case "search": {
      wrap.classList.add("wb-search");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = tile.label || "搜索";
      const submit = () => {
        if (input.value.trim()) goSearch(tile.config?.engine, input.value);
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      const button = document.createElement("button");
      button.textContent = "搜索";
      button.addEventListener("click", submit);
      wrap.append(input, button);
      break;
    }
    case "note": {
      wrap.classList.add("wb-note");
      const text = document.createElement("div");
      text.className = "wb-text";
      text.textContent = tile.config?.text || "双击编辑便签";
      text.addEventListener("dblclick", async () => {
        const next = window.prompt("便签内容", tile.config?.text || "");
        if (next === null) return;
        tile.config = { ...(tile.config || {}), text: next };
        await saveBoard();
        renderBoard();
      });
      wrap.appendChild(text);
      break;
    }
    case "countdown": {
      wrap.classList.add("wb-count");
      const days = document.createElement("div");
      days.className = "wb-days";
      days.dataset.role = "days";
      days.textContent = countdownDays(tile);
      const label = document.createElement("div");
      label.className = "wb-label";
      label.textContent = tile.label || "目标日";
      wrap.append(days, label);
      break;
    }
    case "weather": {
      wrap.classList.add("wb-weather");
      const temp = document.createElement("div");
      temp.className = "wb-temp";
      temp.dataset.role = "weather";
      temp.dataset.city = tile.config?.city || "北京";
      temp.textContent = "…";
      const label = document.createElement("div");
      label.className = "wb-label";
      label.textContent = tile.config?.city || "北京";
      wrap.append(temp, label);
      refreshWeather(temp);
      break;
    }
    default: {
      wrap.classList.add("wb-icon");
      const icon = document.createElement("div");
      icon.className = "ti";
      icon.style.fontSize = `${tile.font || 26}px`;
      icon.textContent = tile.icon || "★";
      wrap.appendChild(icon);
      if (tile.label) {
        const label = document.createElement("div");
        label.className = "tl";
        label.textContent = tile.label;
        wrap.appendChild(label);
      }
    }
  }
  return wrap;
}

async function refreshWeather(node) {
  const city = node.dataset.city || "北京";
  const cached = weatherCache.get(city);
  if (cached && Date.now() - cached.at < WEATHER_TTL) {
    node.textContent = cached.text;
    return;
  }
  try {
    const geo = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`)
    ).json();
    const place = geo.results?.[0];
    if (!place) throw new Error("找不到城市");
    const forecast = await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code`
      )
    ).json();
    const current = forecast.current;
    if (!current) throw new Error("无数据");
    const text = `${Math.round(current.temperature_2m)}° ${WEATHER_CODES[current.weather_code] || ""}`.trim();
    weatherCache.set(city, { at: Date.now(), text });
    node.textContent = text;
  } catch {
    node.textContent = "—";
  }
}

function tickBoard() {
  if (!board.visible) return;
  const now = new Date();
  for (const node of document.querySelectorAll('.wb-time[data-role="time"]')) {
    const tile = board.tiles.find((item) => item.id === node.closest(".tile")?.dataset.id);
    node.textContent = now.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: tile?.config?.hour12 === true,
    });
  }
  for (const node of document.querySelectorAll('.wb-date[data-role="date"]')) {
    node.textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  }
  for (const node of document.querySelectorAll('.wb-days[data-role="days"]')) {
    const tile = board.tiles.find((item) => item.id === node.closest(".tile")?.dataset.id);
    if (tile) node.textContent = countdownDays(tile);
  }
}

/* ---------------- 渲染与拖拽 ---------------- */

function renderBoard() {
  const box = document.getElementById("tiles");
  if (!box) return;
  box.textContent = "";
  const metrics = boardMetrics();

  for (const tile of board.tiles) {
    const node = document.createElement("div");
    node.className = "tile";
    node.dataset.id = tile.id;
    if (board.selected === tile.id) node.classList.add("selected");
    node.appendChild(widgetBody(tile));
    Object.assign(node.style, tileStyle(tile, metrics));
    if (tile.color) node.style.background = tile.color;
    node.addEventListener("pointerdown", (event) => startDrag(event, tile, node, metrics));
    node.querySelectorAll("input, textarea, button").forEach((child) => {
      child.addEventListener("pointerdown", (event) => event.stopPropagation());
    });
    box.appendChild(node);
  }

  const count = document.getElementById("tileCount");
  if (count) count.textContent = String(board.tiles.length);
  tickBoard();
}

function startDrag(event, tile, node, metrics) {
  if (event.button !== 0) return;
  board.selected = tile.id;
  syncEditor();
  document.querySelectorAll(".tile").forEach((el) => el.classList.toggle("selected", el.dataset.id === tile.id));

  const step = metrics.cell + TILE_GAP;
  dragState = {
    tile, node, metrics, step,
    startX: event.clientX,
    startY: event.clientY,
    originX: tile.x * step,
    originY: tile.y * step,
  };
  node.classList.add("dragging");
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", onDrag);
  node.addEventListener("pointerup", endDrag);
  node.addEventListener("pointercancel", endDrag);
}

function onDrag(event) {
  if (!dragState) return;
  dragState.node.style.left = `${dragState.originX + event.clientX - dragState.startX}px`;
  dragState.node.style.top = `${dragState.originY + event.clientY - dragState.startY}px`;
}

function endDrag() {
  if (!dragState) return;
  const { tile, node, metrics, step } = dragState;
  node.classList.remove("dragging");
  node.removeEventListener("pointermove", onDrag);
  node.removeEventListener("pointerup", endDrag);
  node.removeEventListener("pointercancel", endDrag);

  const left = parseFloat(node.style.left) || 0;
  const top = parseFloat(node.style.top) || 0;
  tile.x = Math.max(0, Math.min(metrics.cols - tile.w, Math.round(left / step)));
  tile.y = Math.max(0, Math.min(metrics.rows - tile.h, Math.round(top / step)));
  Object.assign(node.style, tileStyle(tile, metrics));
  dragState = null;
  saveBoard();
}

async function saveBoard() {
  await chrome.storage.local.set({ tiles: board.tiles });
}

/* ---------------- 增删与编辑 ---------------- */

function addWidget(type = "icon") {
  const metrics = boardMetrics();
  const size = suggestedSize(type);
  const occupied = new Set();
  for (const tile of board.tiles) {
    for (let dx = 0; dx < (tile.w || 1); dx++) {
      for (let dy = 0; dy < (tile.h || 1); dy++) occupied.add(`${tile.x + dx},${tile.y + dy}`);
    }
  }

  let x = 0;
  let y = 0;
  let placed = false;
  for (let row = 0; row < metrics.rows && !placed; row++) {
    for (let col = 0; col + size.w <= metrics.cols; col++) {
      let free = true;
      for (let dx = 0; dx < size.w && free; dx++) {
        for (let dy = 0; dy < size.h && free; dy++) {
          if (occupied.has(`${col + dx},${row + dy}`)) free = false;
        }
      }
      if (free) {
        x = col;
        y = row;
        placed = true;
        break;
      }
    }
  }

  const tile = {
    id: `t${Date.now().toString(36)}`,
    type,
    x,
    y,
    w: size.w,
    h: size.h,
    color: "",
    font: 26,
    icon: "★",
    label: "",
    config: {},
  };
  if (type === "search") tile.config = { engine: "bing" };
  if (type === "note") tile.config = { text: "双击编辑便签" };
  if (type === "countdown") Object.assign(tile, { label: "目标日", config: { date: "" } });
  if (type === "weather") tile.config = { city: "北京" };
  if (type === "icon") Object.assign(tile, { label: "新图标", icon: "★" });

  board.tiles.push(tile);
  board.selected = tile.id;
  saveBoard();
  renderBoard();
  syncEditor();
  document.getElementById("tileSection").hidden = false;
}

function currentTile() {
  return board.tiles.find((tile) => tile.id === board.selected) || null;
}

function syncEditor() {
  const tile = currentTile();
  const section = document.getElementById("tileSection");
  if (!section) return;
  section.hidden = !tile;
  if (!tile) return;

  document.getElementById("tileLabel").value = tile.label || "";
  document.getElementById("tileIcon").value = tile.icon || "";
  document.getElementById("tileW").value = String(tile.w || 1);
  document.getElementById("tileH").value = String(tile.h || 1);
  document.getElementById("tileColor").value = tile.color || "#3a3a40";
  document.getElementById("tileFont").value = String(tile.font || 24);

  const kind = tile.type || "icon";
  for (const [key, id] of Object.entries({
    icon: "cfgIcon",
    clock: "cfgClock",
    search: "cfgSearch",
    note: "cfgNote",
    countdown: "cfgCountdown",
    weather: "cfgWeather",
  })) {
    const node = document.getElementById(id);
    if (node) node.hidden = key !== kind;
  }
  document.getElementById("cfgClock12").checked = tile.config?.hour12 === true;
  document.getElementById("cfgSearchEngine").value = tile.config?.engine || "bing";
  document.getElementById("cfgNoteText").value = tile.config?.text || "";
  document.getElementById("cfgCountDate").value = tile.config?.date || "";
  document.getElementById("cfgWeatherCity").value = tile.config?.city || "北京";
}

function bindEditor() {
  const apply = (patch, configPatch) => {
    const tile = currentTile();
    if (!tile) return;
    Object.assign(tile, patch);
    if (configPatch) tile.config = { ...(tile.config || {}), ...configPatch };
    saveBoard();
    renderBoard();
  };

  document.getElementById("tileLabel").addEventListener("change", (e) => apply({ label: e.target.value.slice(0, 12) }));
  document.getElementById("tileIcon").addEventListener("change", (e) => apply({ icon: e.target.value.slice(0, 4) }));
  document.getElementById("tileW").addEventListener("change", () => {
    const tile = currentTile();
    if (!tile) return;
    const w = Number(document.getElementById("tileW").value) || 1;
    apply({ w, x: Math.min(tile.x, boardMetrics().cols - w) });
  });
  document.getElementById("tileH").addEventListener("change", () => {
    const tile = currentTile();
    if (!tile) return;
    const h = Number(document.getElementById("tileH").value) || 1;
    apply({ h, y: Math.min(tile.y, boardMetrics().rows - h) });
  });
  document.getElementById("tileColor").addEventListener("change", (e) => apply({ color: e.target.value }));
  document.getElementById("tileFont").addEventListener("change", (e) => apply({ font: Number(e.target.value) || 24 }));
  document.getElementById("tileDelete").addEventListener("click", () => {
    const tile = currentTile();
    if (!tile) return;
    board.tiles = board.tiles.filter((item) => item.id !== tile.id);
    board.selected = null;
    saveBoard();
    renderBoard();
    syncEditor();
  });

  document.getElementById("cfgClock12").addEventListener("change", (e) => apply({}, { hour12: e.target.checked }));
  document.getElementById("cfgSearchEngine").addEventListener("change", (e) => apply({}, { engine: e.target.value }));
  document.getElementById("cfgNoteText").addEventListener("change", (e) => apply({}, { text: e.target.value }));
  document.getElementById("cfgCountDate").addEventListener("change", (e) => apply({}, { date: e.target.value }));
  document.getElementById("cfgWeatherCity").addEventListener("change", (e) => apply({}, { city: e.target.value.trim() || "北京" }));
  document.getElementById("addTile").addEventListener("click", () =>
    addWidget(document.getElementById("widgetType").value)
  );
}

/* ---------------- 莫奈取色 ---------------- */

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

const hsl = (h, s, l) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

function clusterPalette(pixels) {
  const points = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    points.push([pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255]);
  }
  if (!points.length) return [];
  const k = Math.min(6, points.length);
  let centers = points.slice(0, k).map((p) => p.slice());
  for (let iter = 0; iter < 6; iter++) {
    const buckets = centers.map(() => ({ sum: [0, 0, 0], n: 0 }));
    for (const p of points) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      const bucket = buckets[best];
      bucket.sum[0] += p[0];
      bucket.sum[1] += p[1];
      bucket.sum[2] += p[2];
      bucket.n++;
    }
    centers = buckets.map((b, i) => (b.n ? [b.sum[0] / b.n, b.sum[1] / b.n, b.sum[2] / b.n] : centers[i]));
  }
  return centers.map((c) => {
    const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
    return { h, s, l, score: s * (1 - Math.abs(l - 0.5)) };
  });
}

async function wallpaperPixels() {
  const wall = state.walls.find((item) => item.id === state.current?.id);
  if (!wall || !wall.project?.preview) return null;
  try {
    const { file } = await fileInfo(wall.dir, wall.project.preview);
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(48, 48);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, 48, 48);
    return canvas.getContext("2d").getImageData(0, 0, 48, 48).data;
  } catch {
    return null;
  }
}

async function applyMonet(quiet) {
  const pixels = await wallpaperPixels();
  if (!pixels) throw new Error("当前壁纸没有可用的预览图，无法取色");
  const primary = clusterPalette(pixels).sort((a, b) => b.score - a.score)[0];
  if (!primary) throw new Error("取色失败");

  const palette = {
    accent: hsl(primary.h, Math.max(0.45, primary.s), 0.62),
    accentDim: hsl(primary.h, 0.5, 0.25),
    surface: hsl(primary.h, 0.18, 0.1),
    surface2: hsl(primary.h, 0.16, 0.14),
  };
  applyPalette(palette);
  board.palette = palette;
  await chrome.storage.local.set({ palette });
  if (!quiet) status("已按壁纸重新取色");
}

function applyPalette(palette) {
  if (!palette) return;
  const root = document.documentElement;
  root.style.setProperty("--accent", palette.accent);
  if (palette.accentDim) root.style.setProperty("--accent-dim", palette.accentDim);
  if (palette.surface) root.style.setProperty("--layer", palette.surface);
  if (palette.surface2) root.style.setProperty("--card", palette.surface2);
}

/* ---------------- 可见性与初始化 ---------------- */

function boardSetVisible(visible) {
  board.visible = visible;
  const node = document.getElementById("board");
  if (node) node.hidden = !visible;
  document.body.classList.toggle("page-custom", visible);
  if (visible) {
    document.body.classList.remove("bare");
    requestAnimationFrame(renderBoard);
  }
}

function initBoard(stored) {
  board.tiles = Array.isArray(stored.tiles) ? stored.tiles : [];
  board.palette = stored.palette || null;
  applyPalette(board.palette);
  bindEditor();
  document.getElementById("monetBtn").addEventListener("click", () => applyMonet().catch(reportError));
  renderBoard();
  tickTimer = setInterval(tickBoard, 1000);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (board.visible) renderBoard();
    }, 150);
  });
}
