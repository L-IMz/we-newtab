"use strict";

/* 在线壁纸源：把第三方壁纸站的 HTTP 接口映射成可播放的壁纸条目。
   站点差异全部用「地址模板 + 列表路径 + 字段路径」描述，所以加新站不用改代码。 */

const SOURCE_PRESETS = {
  wallhaven: {
    name: "Wallhaven",
    type: "image",
    url: "https://wallhaven.cc/api/v1/search?q={q}&page={page}",
    list: "data",
    preview: "thumbs.small",
    file: "path",
    title: "id",
    key: "",
    headerName: "",
  },
  giphy: {
    name: "Giphy",
    type: "gif",
    url: "https://api.giphy.com/v1/gifs/search?api_key={key}&q={q}&limit=24",
    list: "data",
    preview: "images.fixed_width.url",
    file: "images.original.url",
    title: "title",
    key: "",
    headerName: "",
  },
  pexels: {
    name: "Pexels",
    type: "video",
    url: "https://api.pexels.com/videos/search?query={q}&per_page=24&page={page}",
    list: "videos",
    preview: "image",
    file: "video_files.0.link",
    title: "url",
    key: "",
    headerName: "Authorization",
  },
  pixabay: {
    name: "Pixabay",
    type: "image",
    url: "https://pixabay.com/api/?key={key}&q={q}&per_page=24&page={page}",
    list: "hits",
    preview: "webformatURL",
    file: "largeImageURL",
    title: "tags",
    key: "",
    headerName: "",
  },
};

const PRESET_ORDER = ["wallhaven", "giphy", "pexels", "pixabay"];
let presetCursor = 0;

let sources = [];
let sourceResults = [];

function getPath(obj, path) {
  if (!path) return obj;
  let current = obj;
  for (const part of String(path).split(".")) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function fillTemplate(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) =>
    vars[key] === undefined ? match : encodeURIComponent(String(vars[key]))
  );
}

function originOf(url) {
  try {
    return new URL(url).origin + "/*";
  } catch {
    return null;
  }
}

// 必须在用户手势里同步调用（第一次 await 之前），否则 Chrome 会拒绝弹授权
// 网络权限已在清单里声明为 *://*/*，这里只做一次兜底检查
async function ensureHostPermission(url) {
  const origin = originOf(url);
  if (!origin || !chrome.permissions) return true;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return true;
  }
}

async function readSources() {
  const stored = await chrome.storage.local.get("sources");
  return Array.isArray(stored.sources) ? stored.sources : [];
}

async function writeSources() {
  await chrome.storage.local.set({ sources });
}

function renderSourceChips() {
  const box = $("srcList");
  const pick = $("srcPick");
  box.textContent = "";
  pick.textContent = "";
  $("srcCount").textContent = String(sources.length);

  if (!sources.length) {
    const tip = document.createElement("p");
    tip.className = "hint";
    tip.textContent = "还没有添加任何源。点「载入示例」可快速填入一个。";
    box.appendChild(tip);
    return;
  }

  for (const source of sources) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.textContent = `${source.name} · ${source.type}`;
    chip.appendChild(name);
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "删除";
    del.addEventListener("click", async () => {
      sources = sources.filter((item) => item.id !== source.id);
      await writeSources();
      renderSourceChips();
    });
    chip.appendChild(del);
    box.appendChild(chip);

    const opt = document.createElement("option");
    opt.value = source.id;
    opt.textContent = source.name;
    pick.appendChild(opt);
  }
}

function readForm() {
  return {
    id: `src${Date.now().toString(36)}`,
    name: $("srcName").value.trim() || "未命名源",
    type: $("srcType").value,
    url: $("srcUrl").value.trim(),
    list: $("srcList").value.trim(),
    preview: $("srcPreview").value.trim(),
    file: $("srcFile").value.trim(),
    title: $("srcTitle").value.trim() || "id",
    key: $("srcKey").value,
    headerName: $("srcHeaderName").value.trim(),
  };
}

function fillForm(source) {
  $("srcName").value = source.name || "";
  $("srcType").value = source.type || "image";
  $("srcUrl").value = source.url || "";
  $("srcList").value = source.list || "";
  $("srcPreview").value = source.preview || "";
  $("srcFile").value = source.file || "";
  $("srcTitle").value = source.title || "";
  $("srcHeaderName").value = source.headerName || "";
}

async function querySource(source, query, page = 1) {
  const url = fillTemplate(source.url, { q: query, page, key: source.key || "" });

  const headers = {};
  if (source.headerName && source.key) headers[source.headerName] = source.key;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}`);
  const json = await res.json();

  let list = getPath(json, source.list);
  if (list && !Array.isArray(list) && typeof list === "object") list = Object.values(list);
  if (!Array.isArray(list)) throw new Error(`列表路径「${source.list}」没有取到数组`);

  const items = [];
  for (const row of list.slice(0, 30)) {
    const file = getPath(row, source.file);
    if (!file) continue;
    const preview = getPath(row, source.preview) || file;
    items.push({
      id: `${source.id}:${getPath(row, source.title) || items.length}`,
      title: String(getPath(row, source.title) || `壁纸 ${items.length + 1}`).slice(0, 40),
      preview: String(preview),
      file: String(file),
      type: source.type,
    });
  }
  if (!items.length) throw new Error("接口没有返回可用条目，检查字段路径");
  return items;
}

function renderSourceResults(items) {
  const box = $("srcResults");
  box.textContent = "";
  for (const item of items) {
    const card = document.createElement("button");
    card.className = "card";
    card.title = item.title;

    const image = document.createElement("img");
    image.src = item.preview;
    image.alt = "";
    image.loading = "lazy";
    card.appendChild(image);

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.type === "video" ? "视频" : item.type === "gif" ? "动态" : "图片";
    card.appendChild(tag);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.title;
    card.appendChild(name);

    card.addEventListener("click", () => playRemote(item));
    box.appendChild(card);
  }
}

function playRemote(item) {
  stopAll();
  state.current = { id: item.id, type: item.type, title: item.title };

  if (item.type === "video") {
    vid.src = item.file;
    vid.classList.add("on");
    vid.play().catch(() => status("视频自动播放被拦截，点击页面重试"));
  } else {
    img.src = item.file;
    img.classList.add("on");
  }
  status(`正在播放：${item.title}（来自在线源）`);
}

function bindSources() {
  $("srcPreset").addEventListener("click", () => {
    const key = PRESET_ORDER[presetCursor % PRESET_ORDER.length];
    presetCursor++;
    fillForm(SOURCE_PRESETS[key]);
    $("srcStatus").textContent = `已填入 ${SOURCE_PRESETS[key].name} 示例，确认后点「保存源」`;
  });

  $("srcSave").addEventListener("click", async () => {
    const source = readForm();
    if (!source.url || !source.list) {
      $("srcStatus").textContent = "接口地址和列表路径不能为空";
      return;
    }
    sources.push(source);
    await writeSources();
    renderSourceChips();
    $("srcPick").value = source.id;
    $("srcStatus").textContent = `已保存「${source.name}」`;
  });

  $("srcSearch").addEventListener("click", () => {
    const list = sources;
    const id = $("srcPick").value;
    const source = list.find((item) => item.id === id) || list[0];
    if (!source) {
      $("srcStatus").textContent = "先添加一个源";
      return;
    }
    // 先同步发起授权（保留点击手势），再异步搜索
    const url = fillTemplate(source.url, { q: $("srcQuery").value.trim(), page: 1, key: source.key || "" });
    const permission = ensureHostPermission(url);
    (async () => {
    $("srcStatus").textContent = "搜索中…";
    try {
      if (!(await permission)) throw new Error("未授权访问该站点（浏览器未授予网络权限）");
      const items = await querySource(source, $("srcQuery").value.trim());
      sourceResults = items;
      renderSourceResults(items);
      $("srcStatus").textContent = `${source.name}：${items.length} 条结果`;
    } catch (error) {
      $("srcStatus").textContent = `失败：${error.message || error}`;
    }
    })();
  });

  $("srcClear").addEventListener("click", () => {
    sourceResults = [];
    $("srcResults").textContent = "";
    $("srcStatus").textContent = "";
  });
}

async function initSources() {
  sources = await readSources();
  renderSourceChips();
  bindSources();
}
