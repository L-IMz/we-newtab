"use strict";

/* 入口：按顺序启动各项能力，最后恢复上次的壁纸。 */

/* ---------------- 启动 ---------------- */

// 启动：设置 → 面板 → 目录 → 恢复上次壁纸
async function main() {
  purgeLegacyCache().catch(() => {});
  startClock();
  startIdle();
  bindPanel();
  await loadSettings();
  applyHitokotoStyle();
  loadStoredFont("hitokoto").then(() => renderHitokoto());
  loadStoredFont("clock").then(() => applyClock());
  applyBrightness();
  bindSettings();
  watchPerformance();
  applyFit();
  vid.playbackRate = Number(state.settings.rate) || 1;

  applyAudioSource();
  const roots = (await kvGet("roots")) || [];
  state.roots = roots;
  renderRoots();
  startWatcher();

  if (!roots.length) {
    notice("先添加 Wallpaper Engine 壁纸目录");
    return;
  }

  await rescan();

  const last = (await chrome.storage.local.get("lastWall")).lastWall;
  const wall = last && state.walls.find((item) => item.id === last);
  if (wall) play(wall).catch(() => notice("上次的壁纸已不可用，请重新选择"));
}

main().catch(reportError);
