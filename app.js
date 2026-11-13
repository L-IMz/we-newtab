/* 启动入口：加载壁纸库、恢复上次壁纸、绑定面板与本地服务，页面加载完成后启动。 */
"use strict";

function findWallBySavedId(saved) {
  return (
    state.walls.find((item) => item.id === saved) ||
    state.walls.find((item) => item.id === saved.replace(/\/\d+$/, "")) ||
    state.walls.find((item) => item.id.startsWith(`${saved}/`))
  );
}

async function restoreLastWall() {
  const { lastWall } = await chrome.storage.local.get("lastWall");
  if (!lastWall) return;
  const wall = findWallBySavedId(lastWall);
  if (wall) play(wall).catch(() => notice("上次的壁纸已不可用，请重新选择"));
}

function whenIdle(fn) {
  if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 1500 });
  else setTimeout(fn, 200);
}

async function main() {
  purgeLegacyCache().catch(() => {});
  startClock();
  startIdle();
  bindPanel();
  await loadSettings();
  applyHitokotoStyle();
  whenIdle(() => loadStoredFont("hitokoto").then(() => renderHitokoto()));
  whenIdle(() => loadStoredFont("clock").then(() => applyClock()));
  applyBrightness();
  bindSettings();

  cleanLegacyAutostart();
  applyLocalServices();
  watchPerformance();
  applyFit();
  vid.playbackRate = Number(state.settings.rate) || 1;

  const roots = (await kvGet("roots")) || [];
  state.roots = roots;
  renderRoots();
  startWatcher();

  if (!roots.length) {
    notice("先添加 Wallpaper Engine 壁纸目录");
    return;
  }

  if (document.hidden) {
    const resume = async () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", resume);
      await rescan();
      await restoreLastWall();
    };
    document.addEventListener("visibilitychange", resume);
    return;
  }

  await rescan();
  await restoreLastWall();
}

main().catch(reportError);
