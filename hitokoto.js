"use strict";

/* 一言：左下角一句随机句子，支持字号、字体与导入自定义字体 */

const HITOKOTO_API = "https://v1.hitokoto.cn/";
const HITOKOTO_TTL = 10 * 60 * 1000;

const HITOKOTO_FONTS = {
  system: '"Segoe UI Variable Text", var(--font)',
  sans: "var(--font)",
  serif: '"Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", Consolas, monospace',
};

// 当前字体族
function hitokotoFamily() {
  const key = state.settings.hitokotoFont || "system";
  if (key === "custom") return `"${fontSlot("hitokoto").family}", var(--font)`;
  return HITOKOTO_FONTS[key] || HITOKOTO_FONTS.system;
}

// 应用显隐、字号与字体
function applyHitokotoStyle() {
  const el = $("hitokoto");
  if (!el) return;
  el.hidden = !state.settings.hitokotoShow;
  const root = document.documentElement;
  root.style.setProperty("--hitokoto-size", `${Number(state.settings.hitokotoSize) || 14}px`);
  root.style.setProperty("--hitokoto-font", hitokotoFamily());
}

/* ---------------- 内容 ---------------- */

// 取一言（带 10 分钟缓存）
async function loadHitokoto(force) {
  const cached = await kvGet("hitokotoCache").catch(() => null);
  if (!force && cached?.text && Date.now() - cached.at < HITOKOTO_TTL) return cached;
  const res = await fetch(HITOKOTO_API, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const entry = {
    text: String(data.hitokoto || "").trim(),
    from: String(data.from || "").trim(),
    at: Date.now(),
  };
  if (!entry.text) throw new Error("空内容");
  await kvSet("hitokotoCache", entry);
  return entry;
}

// 渲染一言
async function renderHitokoto(force) {
  applyHitokotoStyle();
  const el = $("hitokoto");
  if (!el || !state.settings.hitokotoShow) return;
  try {
    const entry = await loadHitokoto(force);
    el.textContent = entry.text;
    el.dataset.from = entry.from ? `—— ${entry.from}` : "";
    el.hidden = false;
  } catch {
    // 拉不到就安静地留空，不打断壁纸
    el.textContent = "";
    el.dataset.from = "";
    el.hidden = true;
  }
}

/* ---------------- 字体导入 ---------------- */

// 导入一言字体
async function importHitokotoFont(file) {
  const stateEl = $("hitokotoState");
  if (!file) return;
  try {
    await importFont("hitokoto", file);
    state.settings.hitokotoFont = "custom";
    state.settings.hitokotoCustomName = file.name;
    saveSettings();
    applyHitokotoStyle();
    if (stateEl) stateEl.textContent = `已导入：${file.name}`;
  } catch (error) {
    if (stateEl) stateEl.textContent = `导入失败：${error.message || error}`;
  }
}

// 恢复系统字体
async function clearHitokotoFont() {
  await clearImportedFont("hitokoto");
  state.settings.hitokotoFont = "system";
  state.settings.hitokotoCustomName = "";
  saveSettings();
  applyHitokotoStyle();
  const stateEl = $("hitokotoState");
  if (stateEl) stateEl.textContent = "已恢复系统字体";
}
