"use strict";

/* 时钟：时间 / 日期渲染与外观设置（显隐、字号、粗细、字体、百分比位置）。 */

const CLOCK_FONTS = {
  system: '"Segoe UI Variable Display", "Segoe UI Variable", var(--font)',
  sans: "var(--font)",
  serif: '"Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", Consolas, monospace',
};

// 百分比夹取到 0–100
function clockPercent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, number));
}

// 应用时钟外观与位置
function applyClock() {
  const el = $("clock");
  if (!el) return;
  el.hidden = !state.settings.clockShow;
  const root = document.documentElement;
  root.style.setProperty("--clock-size", `${Number(state.settings.clockSize) || 112}px`);
  root.style.setProperty("--clock-weight", String(Number(state.settings.clockWeight) || 300));
  const family = state.settings.clockFont === "custom" ? `"${fontSlot("clock").family}", var(--font)` : CLOCK_FONTS[state.settings.clockFont] || CLOCK_FONTS.system;
  root.style.setProperty("--clock-font", family);
  const x = clockPercent(state.settings.clockX, 50);
  const y = clockPercent(state.settings.clockY, 42);
  root.style.setProperty("--clock-x", `${x}%`);
  root.style.setProperty("--clock-y", `${y}%`);
  if ($("clockXValue")) $("clockXValue").textContent = `${x}%`;
  if ($("clockYValue")) $("clockYValue").textContent = `${y}%`;
}

// 导入时钟字体
async function importClockFont(file) {
  if (!file) return;
  try {
    await importFont("clock", file);
    state.settings.clockFont = "custom";
    saveSettings();
    applyClock();
    if ($("clockFontState")) $("clockFontState").textContent = `已导入：${file.name}`;
  } catch (error) {
    if ($("clockFontState")) $("clockFontState").textContent = `导入失败：${error.message || error}`;
  }
}

// 恢复时钟系统字体
async function clearClockFont() {
  await clearImportedFont("clock");
  state.settings.clockFont = "system";
  saveSettings();
  applyClock();
  if ($("clockFontState")) $("clockFontState").textContent = "已恢复系统字体";
}

/* ---------------- 时间渲染 ---------------- */

// 渲染时间与日期
function startClock() {
  const time = $("time");
  const date = $("date");
  const paint = () => {
    const now = new Date();
    time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    date.textContent = now.toLocaleDateString("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  };
  paint();
  setInterval(paint, 15000);
}
