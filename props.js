/* 壁纸属性：默认值、类型转换、控件生成与增量下发。 */
"use strict";

const PROP_TYPES = new Set(["slider", "color", "bool", "combo", "textinput", "text", "group", "file"]);

function plainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const PROP_LABELS = {
  ui_browse_properties_scheme_color: "系统配色",
};

function labelOf(def) {
  const raw = String(def.text || "");
  const text = plainText(raw);
  if (!text) return "";
  if (PROP_LABELS[text]) return PROP_LABELS[text];
  if (/^[a-z0-9_]+$/i.test(text) && text.includes("_")) {
    return text
      .replace(/^ui_browse_properties_/i, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return text;
}

function compare(a, b, op) {
  const numA = typeof a === "boolean" ? Number(a) : Number(a);
  const numB = typeof b === "boolean" ? Number(b) : Number(b);
  const bothNumeric = a !== "" && b !== "" && !Number.isNaN(numA) && !Number.isNaN(numB);
  const equal = bothNumeric ? numA === numB : String(a) === String(b);
  return op === "==" ? equal : !equal;
}

function evalCondition(expression, values) {
  const src = String(expression || "").trim();
  if (!src) return true;

  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  function parseOr() {
    let left = parseAnd();
    skip();
    while (src.startsWith("||", i)) {
      i += 2;
      const right = parseAnd();
      left = left || right;
      skip();
    }
    return left;
  }

  function parseAnd() {
    let left = parseCompare();
    skip();
    while (src.startsWith("&&", i)) {
      i += 2;
      const right = parseCompare();
      left = left && right;
      skip();
    }
    return left;
  }

  function parseCompare() {
    const left = parseAtom();
    skip();
    if (src.startsWith("==", i) || src.startsWith("!=", i)) {
      const op = src.slice(i, i + 2);
      i += 2;
      const right = parseAtom();
      return compare(left, right, op);
    }
    return left;
  }

  function parseAtom() {
    skip();
    const ch = peek();
    if (ch === "(") {
      i++;
      const value = parseOr();
      skip();
      if (peek() === ")") i++;
      return value;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let text = "";
      while (i < src.length && src[i] !== quote) text += src[i++];
      i++;
      return text;
    }
    const rest = src.slice(i);

    if (/^true\b/.test(rest)) {
      i += 4;
      return true;
    }
    if (/^false\b/.test(rest)) {
      i += 5;
      return false;
    }
    const num = rest.match(/^-?\d+(\.\d+)?/);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const ident = rest.match(/^[A-Za-z_][\w.]*/);
    if (ident) {
      i += ident[0].length;
      const name = ident[0].replace(/\.value$/, "");
      const value = values[name];
      return value === undefined ? 0 : value;
    }
    throw new Error(`无法解析 condition: ${src}`);
  }

  try {
    return Boolean(parseOr());
  } catch {
    return true;
  }
}

function propDefs(wall) {
  const props = wall?.project?.general?.properties || {};
  return Object.entries(props)
    .filter(([, def]) => def && typeof def === "object" && PROP_TYPES.has(def.type))
    .map(([name, def]) => ({ name, def }))
    .sort((a, b) => Number(a.def.order ?? 0) - Number(b.def.order ?? 0));
}

function defaultValues(defs) {
  const values = {};
  for (const { name, def } of defs) {

    if (def.type === "file" || def.type === "directory" || def.type === "text" || def.type === "textinput") {
      values[name] = def.value ?? "";
      continue;
    }
    if (def.value !== undefined) values[name] = def.value;
    else if (def.type === "bool") values[name] = false;
    else if (def.type === "slider") values[name] = Number(def.min ?? 0);
    else if (def.type === "combo") values[name] = def.options?.[0]?.value ?? 0;
    else if (def.type === "color") values[name] = "1 1 1";
    else values[name] = "";

    if (def.type === "color" && typeof values[name] === "string" && /^#[0-9a-f]{6}$/i.test(values[name])) {
      values[name] = hexToColorString(values[name]);
    }
  }
  return values;
}

function colorStringToHex(value) {
  const parts = String(value || "1 1 1").trim().split(/\s+/).map(Number);
  const rgb = parts.length === 3 ? parts : [1, 1, 1];
  const toByte = (v) => Math.max(0, Math.min(255, Math.round((Number.isNaN(v) ? 1 : v) * 255)));
  return `#${rgb.map((v) => toByte(v).toString(16).padStart(2, "0")).join("")}`;
}

function hexToColorString(hex) {
  const clean = hex.replace("#", "");
  const rgb = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
  return rgb.map((v) => Math.round(v * 1000) / 1000).join(" ");
}

function colorFromHexOrRgb(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  return colorStringToHex(text);
}

function formatPropValue(def, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? "");
  const precision = Number.isFinite(Number(def.precision)) ? Number(def.precision) : def.fraction ? 2 : 0;
  return def.fraction ? n.toFixed(Math.min(4, Math.max(0, precision))) : String(Math.round(n));
}

const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

function renderProperties(container, defs, values, onChange) {
  container.textContent = "";
  const fragment = document.createDocumentFragment();
  const rows = [];

  for (const { name, def } of defs) {
    const row = el("div", "prop");
    row.dataset.prop = name;

    if (def.type === "group") {
      row.className = "prop prop-group";
      const head = el("h4", "prop-group-head");
      head.textContent = labelOf(def) || name;
      row.appendChild(head);
      fragment.appendChild(row);
      rows.push({ row, def, name });
      continue;
    }

    if (def.type === "text") {
      row.className = "prop prop-text";
      const title = /<h4/i.test(def.text || "");
      const node = el(title ? "h3" : "p", title ? "prop-head" : "prop-note");
      node.textContent = plainText(def.text);
      row.appendChild(node);
      fragment.appendChild(row);
      rows.push({ row, def, name });
      continue;
    }

    const label = el("label", "prop-label");
    label.textContent = labelOf(def) || name;
    row.appendChild(label);

    let control;

    if (def.type === "bool") {
      control = el("input");
      control.type = "checkbox";
      control.className = "switch";
      control.checked = values[name] === true || values[name] === "true";
      control.addEventListener("change", () => onChange(name, control.checked));
    } else if (def.type === "slider") {
      const min = Number(def.min ?? 0);
      const max = Number(def.max ?? 100);
      const slider = el("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(def.step ?? (def.fraction ? 0.01 : 1));
      slider.value = String(values[name] ?? min);

      const readout = el("span", "prop-readout");
      const paint = () => {
        readout.textContent = formatPropValue(def, slider.value);
        const pct = max > min ? ((Number(slider.value) - min) / (max - min)) * 100 : 0;
        slider.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct))}%`);
      };
      paint();
      slider.addEventListener("input", () => {
        paint();
        onChange(name, Number(slider.value));
      });

      const wrap = el("div", "prop-slider");
      wrap.append(slider, readout);
      control = wrap;
    } else if (def.type === "combo") {

      const options = def.options || [];
      control = el("select");
      options.forEach((option, index) => {
        const opt = el("option");
        opt.value = String(index);
        opt.textContent = String(option.label ?? option.value);
        control.appendChild(opt);
      });
      const currentIndex = options.findIndex((option) => String(option.value) === String(values[name]));
      control.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
      control.addEventListener("change", () => {
        const picked = options[Number(control.value)];
        onChange(name, picked ? picked.value : control.value);
      });
    } else if (def.type === "color") {
      control = el("input");
      control.type = "color";
      control.value = colorFromHexOrRgb(values[name]);
      control.addEventListener("change", () => onChange(name, hexToColorString(control.value)));
    } else if (def.type === "textinput") {
      control = el("input");
      control.type = "text";
      control.value = String(values[name] ?? "");
      control.addEventListener("change", () => onChange(name, control.value));
    } else {
      control = el("input");
      control.disabled = true;
      control.placeholder = "文件类选项暂不支持";
    }

    row.appendChild(control);
    fragment.appendChild(row);
    rows.push({ row, def, name });
  }

  container.appendChild(fragment);

  let refreshQueued = false;
  let pendingValues = null;
  const applyRefresh = (values) => {

    const evalValues = { ...values };
    for (const { name, def } of defs) if (def.type === "group") evalValues[name] = true;
    for (const { row, def } of rows) {
      if (!def.condition) continue;
      row.hidden = !evalCondition(def.condition, evalValues);
    }
  };

  return {

    refresh(nextValues) {
      pendingValues = nextValues;
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        applyRefresh(pendingValues);
      });
    },
  };
}
