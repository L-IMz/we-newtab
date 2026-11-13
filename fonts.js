/* 自定义字体：IndexedDB 存取与 FontFace 注册。 */
"use strict";

const FONT_SLOTS = {
  clock: { key: "font.clock", family: "WE-Clock" },
  hitokoto: { key: "font.hitokoto", family: "WE-Hitokoto" },
};

function fontSlot(name) {
  return FONT_SLOTS[name] || FONT_SLOTS.hitokoto;
}

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

async function importFont(name, file) {
  const slot = fontSlot(name);
  const buffer = await file.arrayBuffer();
  const face = new FontFace(slot.family, buffer);
  await face.load();
  document.fonts.add(face);
  await kvSet(slot.key, buffer);
  return slot.family;
}

async function clearImportedFont(name) {
  const slot = fontSlot(name);
  await kvSet(slot.key, null);
}
