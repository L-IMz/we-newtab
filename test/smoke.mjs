// 开发期校验：在 Node 里用桩对象执行 props.js，验证 condition 求值、取值与颜色转换。
// 用法：node test/smoke.mjs
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "props.js"), "utf8");

function element(tag = "div") {
  return {
    tagName: tag,
    className: "",
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    type: "",
    children: [],
    style: {},
    dataset: {},
    selectedIndex: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    insertBefore(child) {
      return child;
    },
    setAttribute() {},
    removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const context = createContext({
  console,
  document: {
    createElement: (tag) => element(tag),
    getElementById: () => element(),
    body: element("body"),
  },
});
context.globalThis = context;
runInContext(
  `${source}\n;globalThis.__t = { evalCondition, labelOf, plainText, defaultValues, propDefs, colorStringToHex, hexToColorString, colorFromHexOrRgb };`,
  context
);

const t = context.__t;
const results = [];
const check = (name, ok, extra = "") => results.push({ name, ok, extra });

// condition 表达式
const values = { bgm: true, mode: 2, name: "abc", count: 0 };
check("相等（数字）", t.evalCondition("mode.value == 2", values) === true);
check("相等（布尔）", t.evalCondition("bgm.value == true", values) === true);
check("不等", t.evalCondition("mode.value != 1", values) === true);
check("&& 两真", t.evalCondition("bgm.value == true && mode.value == 2", values) === true);
check("&& 一假", t.evalCondition("bgm.value == true && mode.value == 3", values) === false);
check("|| 一真", t.evalCondition("mode.value == 3 || bgm.value == true", values) === true);
check("括号优先级", t.evalCondition("(mode.value == 3 || bgm.value == true) && mode.value == 2", values) === true);
check("字符串比较", t.evalCondition("name.value == 'abc'", values) === true);
check("空字符串比较", t.evalCondition("name.value != ''", values) === true);
check("数字 0 与 false", t.evalCondition("count.value == false", values) === true);
check("无法解析时放行", t.evalCondition("这 && 不是 表达式", values) === true);
check("空条件放行", t.evalCondition("", values) === true);

// 属性定义与默认值
const project = {
  general: {
    properties: {
      schemecolor: { type: "color", value: "0.35294 0.43922 0.55686", text: "ui_browse_properties_scheme_color", order: 0 },
      background: { type: "combo", value: "1", order: 100, options: [{ label: "樱花", value: "1" }, { label: "月球", value: "2" }] },
      bgm: { type: "bool", value: true, order: 101 },
      staff: { type: "bool", value: true, order: 103, condition: "bgm.value == true" },
      note: { type: "text", text: "<h4>标题</h4><small>说明</small>", order: 10 },
      pick: { type: "file", order: 11 },
    },
  },
};
const defs = t.propDefs({ project });
check("按 order 排序", defs.map((d) => d.name).join(",") === "schemecolor,note,pick,background,bgm,staff", defs.map((d) => d.name).join(","));
const defaults = t.defaultValues(defs);
check("combo 默认值保持字符串", defaults.background === "1");
check("bool 默认值", defaults.bgm === true);
check("text/file 不产生值", defaults.note === undefined && defaults.pick === undefined);

// 文案清洗
check("去标签取文本", t.plainText("<h4>标题</h4><small>说明</small>") === "标题 说明");
check("本地化 key 有中文别名", t.labelOf({ text: "ui_browse_properties_scheme_color" }) === "系统配色");
check("未知 key 转可读", t.labelOf({ text: "some_unknown_key" }) === "Some Unknown Key");

// 颜色
check("0-1 RGB 转 hex", t.colorStringToHex("1 0 0") === "#ff0000");
check("hex 转 0-1 RGB", t.hexToColorString("#0000ff") === "0 0 1");
check("hex 原样识别", t.colorFromHexOrRgb("#7a7574") === "#7a7574");
check("非法值回退白色", t.colorFromHexOrRgb("") === "#ffffff");

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  <- ${r.extra}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
