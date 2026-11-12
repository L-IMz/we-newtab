"use strict";

/* 入口：启动流程、时钟、空闲状态 */

/* ---------------- 启动 ---------------- */

async function main() {
  purgeLegacyCache().catch(() => {});
  startClock();
  startIdle();
  bindPanel();
  bindPanelTabs();
  await loadSettings();
  applyBrightness();
  bindSettings();
  watchPerformance();
  applyFit();
  vid.playbackRate = Number(state.settings.rate) || 1;

  // 自定义页与壁纸库相互独立：没有壁纸也要能初始化组件面板
  const stored = await chrome.storage.local.get(["tiles", "palette", "tab"]);
  initBoard(stored);
  setTab(stored.tab === "custom" ? "custom" : "wall");

  applyAudioSource();
  const roots = (await kvGet("roots")) || [];
  state.roots = roots;
  renderRoots();
  startWatcher();

  if (!roots.length) {
    status("先添加 Wallpaper Engine 壁纸目录");
    return;
  }

  await rescan();

  const last = (await chrome.storage.local.get("lastWall")).lastWall;
  const wall = last && state.walls.find((item) => item.id === last);
  if (wall) play(wall).catch(() => status("上次的壁纸已不可用，请重新选择"));
}

main().catch(reportError);
