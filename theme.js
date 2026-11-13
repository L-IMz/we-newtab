/* 主题色：从壁纸取色并计算、应用 Monet 调色板。 */
"use strict";

const MONET_DEFAULTS = {
  accent: "#60cdff",
  dim: "rgba(96, 205, 255, .18)",
  ink: "#003651",
};

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function dominantColor(pixels) {
  let best = null;
  let bestScore = -1;
  for (const pixel of pixels) {
    const [r, g, b] = pixel;
    const [, s, l] = rgbToHsl(r, g, b);
    if (s < 0.16 || l < 0.12 || l > 0.93) continue;
    const score = s * (1 - Math.abs(l - 0.55) * 1.4);
    if (score > bestScore) {
      bestScore = score;
      best = pixel;
    }
  }
  return best;
}

function sampleElement(source) {
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return dominantColor(pixels);
  } catch {

    return null;
  }
}

function parseSchemeColor(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const { x, y, z } = value;
    if ([x, y, z].every((n) => Number.isFinite(Number(n)))) {
      return [x, y, z].map((n) => Math.round(Number(n) * 255));
    }
    return null;
  }
  const parts = String(value).trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const scale = parts.slice(0, 3).some((n) => n > 1) ? 1 : 255;
  return parts.slice(0, 3).map((n) => Math.round(n * scale));
}

function colorOfScene(wall) {
  const props = wall.project?.general?.properties || {};
  return parseSchemeColor(props.schemecolor?.value);
}

function colorOfWall(wall) {
  if (!wall) return null;
  if (wall.type === "scene") return colorOfScene(wall);
  if (wall.type === "video") return vid.readyState >= 2 ? sampleElement(vid) : null;
  if (wall.type === "image" || wall.type === "gif") {
    return img.complete && img.naturalWidth ? sampleElement(img) : null;
  }
  return null;
}

function paintTheme(rgb) {
  const root = document.documentElement;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  if (s < 0.12) return paintThemeDefaults();
  const sat = Math.min(0.85, Math.max(0.5, s));
  const light = Math.min(0.72, Math.max(0.58, l));
  const accent = `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-dim", `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}% / .18)`);
  root.style.setProperty("--accent-ink", light > 0.62 ? "#08222c" : "#f4fcff");
}

function paintThemeDefaults() {
  const root = document.documentElement;
  root.style.setProperty("--accent", MONET_DEFAULTS.accent);
  root.style.setProperty("--accent-dim", MONET_DEFAULTS.dim);
  root.style.setProperty("--accent-ink", MONET_DEFAULTS.ink);
}

function applyMonet(wall = state.current) {
  if (!state.settings.monet) return paintThemeDefaults();
  const wallObject = wall && state.walls.find((item) => item.id === wall.id);
  const rgb = colorOfWall(wallObject || wall);
  if (rgb) paintTheme(rgb);
  else paintThemeDefaults();
}

vid.addEventListener("loadeddata", () => {
  if (state.current?.type === "video") applyMonet();
});
img.addEventListener("load", () => {
  if (state.current && state.current.type !== "scene") applyMonet();
});
