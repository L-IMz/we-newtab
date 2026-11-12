"use strict";

/* 字体槽位：每个组件一个槽位，导入的字体以字节存在 IndexedDB，运行时用 FontFace 注册。 */

/* ---------------- 槽位配置 ---------------- */

const FONT_SLOTS = {
  clock: { key: "font.clock", family: "WE-Clock" },
  hitokoto: { key: "font.hitokoto", family: "WE-Hitokoto" },
};

// 取槽位配置
function fontSlot(name) {
  return FONT_SLOTS[name] || FONT_SLOTS.hitokoto;
}

// 从 IndexedDB 恢复字体
/* ---------------- 加载已存字体 ---------------- */
async function loadStoredFont(name) {
  const slot = fontSlot(name);
  try {
    const buffer = await kvGet(slot.key);
    if (!buffer) return false;
    if ([...document.fonts].some((face) => face.family.replace(/"/g, "") === slot.family)) return true;
    const face = new FontFace(slot.family, buffer);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
}

// 导入并注册字体
/* ---------------- 导入与清除 ---------------- */
async function importFont(name, file) {
  const slot = fontSlot(name);
  const buffer = await file.arrayBuffer();
  const face = new FontFace(slot.family, buffer);
  await face.load();
  document.fonts.add(face);
  await kvSet(slot.key, buffer);
  return slot.family;
}

// 删除已导入字体
async function clearImportedFont(name) {
  const slot = fontSlot(name);
  await kvSet(slot.key, null);
}
