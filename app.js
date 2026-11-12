"use strict";

/* 入口：初始化设置与面板，扫描壁纸目录，恢复上次的壁纸。
   后台标签先不扫描不挂载，等变为可见再启动。 */

/* ---------------- 启动 ---------------- */

// 按保存的 id 找壁纸：先精确匹配，再兼容旧版 root/name/index
function findWallBySavedId(saved) {
  return (
    state.walls.find((item) => item.id === saved) ||
    state.walls.find((item) => item.id === saved.replace(/\/\d+$/, "")) ||
    state.walls.find((item) => item.id.startsWith(`${saved}/`))
  );
}

// 恢复上次播放的壁纸
async function restoreLastWall() {
  const { lastWall } = await chrome.storage.local.get("lastWall");
  if (!lastWall) return;
  const wall = findWallBySavedId(lastWall);
  if (wall) play(wall).catch(() => notice("上次的壁纸已不可用，请重新选择"));
}

// 非关键任务放到空闲帧执行，先让新标签页可交互
function whenIdle(fn) {
  if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 1500 });
  else setTimeout(fn, 200);
}

// 启动：设置 → 面板 → 目录 → 恢复上次壁纸
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
  watchPerformance();
  applyFit();
  vid.playbackRate = Number(state.settings.rate) || 1;

  // 音频源在真正开始播放时由 play() 启动，启动阶段不占资源
  const roots = (await kvGet("roots")) || [];
  state.roots = roots;
  renderRoots();
  startWatcher();

  if (!roots.length) {
    notice("先添加 Wallpaper Engine 壁纸目录");
    return;
  }

  // 后台标签（开机恢复会话时常常一次打开很多个）先不做扫描和挂载，
  // 等真正切过去再干活，避免启动瞬间一堆 WebGL 场景同时初始化。
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
