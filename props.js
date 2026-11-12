"use strict";

/* 壁纸自定义选项：解析 project.json 的 general.properties，生成控件并求值 condition。
   只处理文本与数值，不执行壁纸提供的任何 HTML/脚本。 */

const PROP_TYPES = new Set(["slider", "color", "bool", "combo", "textinput", "text", "file", "textinput"]);

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

// WE 的 text 字段可能是本地化 key（如 ui_browse_properties_scheme_color），也可能是带 HTML 的说明
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

/* --- condition 表达式：支持 && || == != 括号、数字/字符串/布尔、`Name.value` --- */

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
    // true/false 必须先于标识符判断，否则会被当成属性名查表
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
    return true; // 解析失败时按“显示”处理，宁可多给控件也不藏掉
  }
}

/* --- 取值与控件 --- */

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
    if (def.type === "text" || def.type === "file") continue;
    if (def.value !== undefined) values[name] = def.value;
    else if (def.type === "bool") values[name] = false;
    else if (def.type === "slider") values[name] = Number(def.min ?? 0);
    else if (def.type === "combo") values[name] = def.options?.[0]?.value ?? 0;
    else if (def.type === "color") values[name] = "1 1 1";
    else values[name] = "";
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

const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

/* 渲染控件列表。onChange(name, value) 由调用方负责持久化与下发 */
function renderProperties(container, defs, values, onChange) {
  container.textContent = "";
  const rows = [];

  for (const { name, def } of defs) {
    const row = el("div", "prop");

    if (def.type === "text") {
      row.className = "prop prop-text";
      const title = /<h4/i.test(def.text || "");
      const node = el(title ? "h3" : "p", title ? "prop-head" : "prop-note");
      node.textContent = plainText(def.text);
      row.appendChild(node);
      container.appendChild(row);
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
      control = el("input");
      control.type = "range";
      control.min = String(min);
      control.max = String(max);
      control.step = String(def.step ?? (max - min > 20 ? 1 : 0.01));
      control.value = String(values[name] ?? min);
      const readout = el("span", "prop-readout");
      readout.textContent = control.value;
      control.addEventListener("input", () => {
        readout.textContent = control.value;
        onChange(name, Number(control.value));
      });
      const wrap = el("div", "prop-slider");
      wrap.append(control, readout);
      control = wrap;
    } else if (def.type === "combo") {
      // 选项值可能是字符串（"1"）也可能是数字（1），必须原样回传，WE 的壁纸依赖这个类型
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
    container.appendChild(row);
    rows.push({ row, def, name });
  }

  return {
    // 依据当前值刷新 condition 可见性
    refresh(nextValues) {
      for (const { row, def } of rows) {
        if (!def.condition) continue;
        row.hidden = !evalCondition(def.condition, nextValues);
      }
    },
  };
}
