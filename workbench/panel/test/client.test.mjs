import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CLIENT_PATH = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, "utf8");

function createStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function createReact() {
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type: type, props: props || {}, children: children };
  }

  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  }

  return {
    createElement: createElement,
    Component: Component,
    useState: function (initial) {
      return [initial, function () {}];
    },
    useRef: function (initial) {
      return { current: initial };
    },
    useEffect: function () {},
    useCallback: function (fn) {
      return fn;
    },
    useMemo: function (fn) {
      return fn();
    },
    useContext: function () {
      return null;
    },
    createContext: function (value) {
      return { _value: value };
    },
    Fragment: "Fragment",
  };
}

function createDocument() {
  const appended = [];
  return {
    appended: appended,
    hidden: false,
    head: {
      appendChild: function (node) {
        appended.push(node);
      },
    },
    body: {},
    querySelector: function () {
      return null;
    },
    createElement: function (tagName) {
      return {
        tagName: tagName,
        dataset: {},
        textContent: "",
        appendChild: function () {},
        setAttribute: function () {},
      };
    },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
}

function loadPlugin(options) {
  options = options || {};
  const storage = createStorage(options.storage);
  const document = createDocument();
  const react = createReact();
  let definition = null;

  const window = {
    __ModuleLoader__: {
      load: function (loaded) {
        definition = loaded;
      },
    },
  };

  const sandbox = {
    window: window,
    document: document,
    console: console,
    URL: URL,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    localStorage: storage,
    Symbol: Symbol,
  };

  vm.runInNewContext(SOURCE, sandbox, { filename: CLIENT_PATH });
  assert.ok(definition, "bundle 应该调用 window.__ModuleLoader__.load");
  assert.equal(definition.id, "dsh-sansheng-liubu-workbench", "bundle id 必须是包名");

  const exports = definition.factory(function (id) {
    if (id === "react") return react;
    throw new Error("unexpected require: " + id);
  });

  return { exports: exports, react: react, storage: storage, document: document, definition: definition };
}

function createCtx(options) {
  options = options || {};
  const registrations = [];
  const injections = [];
  const tabs = [];
  const effects = [];

  const ctx = {
    slots: {
      inject: function (name, factory) {
        injections.push(name);
        const value = factory();
        if (value !== undefined) registrations.push(value);
        return function () {};
      },
      register: function (spec, component) {
        const registration = { spec: spec, component: component };
        registrations.push(registration);
        return registration;
      },
    },
    effect: function (factory, label) {
      effects.push(label);
      const value = factory();
      return typeof value === "function" ? value : function () {};
    },
    get: function (name) {
      return options.services ? options.services[name] : undefined;
    },
    uiWorkspace: {
      currentWorkspaceId: options.workspaceId || "ws-1",
      openSession: function () {},
    },
  };

  if (!options.noTabs) {
    ctx.sidebarRightTabs = {
      register: function (spec) {
        tabs.push(spec);
        return function () {};
      },
    };
  }

  return { ctx: ctx, registrations: registrations, injections: injections, tabs: tabs, effects: effects };
}

test("bundle 契约：id、inject 与纯函数导出", function () {
  const plugin = loadPlugin();
  const api = plugin.exports;

  assert.deepEqual(Array.from(api.inject), ["slots", "sessions", "uiWorkspace", "uiConversation"]);
  assert.equal(typeof api.apply, "function");
  assert.equal(typeof api.WorkbenchRail, "function");
  assert.equal(typeof api.__test, "object");

  const expected = ["computeRailLayout", "statusOf", "mergeEvents", "apiPath", "pickProjectId", "formatModelLine", "ROLE_META"];
  for (const key of expected) assert.ok(key in api.__test, "__test 缺少 " + key);
  assert.equal(Object.keys(api.__test.ROLE_META).length, 10);
  assert.deepEqual(Object.keys(api.__test.ROLE_META).slice(0, 4), ["lead", "zhongshu", "shangshu", "menxia"]);
});

test("computeRailLayout：丞相跨三列居中、三省一列、六部 3×2", function () {
  const layout = loadPlugin().exports.__test.computeRailLayout(400);

  assert.equal(layout.width, 400);
  assert.equal(layout.nodes.length, 10);

  const byId = {};
  for (const node of layout.nodes) {
    assert.equal(typeof node.id, "string");
    assert.equal(typeof node.x, "number");
    assert.equal(typeof node.y, "number");
    assert.equal(typeof node.col, "number");
    assert.equal(typeof node.row, "number");
    byId[node.id] = node;
  }

  const lead = byId.lead;
  assert.equal(lead.col, 1);
  assert.equal(lead.span, 3);
  assert.ok(Math.abs(lead.x + lead.w / 2 - 200) < 0.001, "丞相应水平居中");
  assert.ok(Math.abs(lead.x - (400 - lead.w) / 2) < 0.001);

  const san = ["zhongshu", "shangshu", "menxia"].map((id) => byId[id]);
  assert.deepEqual(Array.from(san, (node) => node.col), [0, 1, 2]);
  assert.deepEqual(Array.from(san, (node) => node.row), [1, 1, 1]);
  assert.equal(new Set(Array.from(san, (node) => node.y)).size, 1, "三省应在同一行");
  assert.ok(san[0].x < san[1].x && san[1].x < san[2].x, "三省 x 必须递增");

  const six = layout.nodes.filter((node) => node.row >= 2);
  assert.equal(six.length, 6);
  assert.deepEqual(Array.from(six, (node) => node.id), ["libu", "hubu", "lipu", "bingbu", "xingbu", "gongbu"]);
  assert.equal(six[5].id, "gongbu", "第 6 个是工部");
  assert.deepEqual(Array.from(six, (node) => node.col), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(Array.from(six, (node) => node.row), [2, 2, 2, 3, 3, 3]);

  assert.ok(layout.groups.ministries.y > layout.groups.sansheng.y + layout.groups.sansheng.h);
  assert.ok(layout.height > 0);
});

test("computeRailLayout：窄栏仍是三列且不出现负宽度", function () {
  const layout = loadPlugin().exports.__test.computeRailLayout(340);
  assert.equal(layout.nodes.length, 10);
  assert.equal(new Set(Array.from(layout.nodes, (node) => node.col)).size, 3);
  for (const node of layout.nodes) assert.ok(node.w > 0, node.id + " 宽度必须为正");
  assert.ok(layout.leadWidth <= 184);
});

test("statusOf：六种部门状态与未知值兜底", function () {
  const { statusOf } = loadPlugin().exports.__test;
  assert.equal(statusOf("uninitialized"), "未接通");
  assert.equal(statusOf("idle"), "空闲");
  assert.equal(statusOf("queued"), "排队");
  assert.equal(statusOf("running"), "正在运行");
  assert.equal(statusOf("unavailable"), "不可用");
  assert.equal(statusOf("needs_attention"), "需人处理");
  assert.equal(statusOf("something-new"), "未知");
  assert.equal(statusOf(null), "未接通");
  assert.equal(statusOf(""), "未接通");
});

test("mergeEvents：按 eventId 去重、按 seq 升序、忽略乱序重复", function () {
  const { mergeEvents } = loadPlugin().exports.__test;
  const merged = mergeEvents(
    [{ eventId: "a", seq: 3 }, { eventId: "b", seq: 1 }],
    [{ eventId: "b", seq: 1 }, { eventId: "c", seq: 2 }, { eventId: "a", seq: 3 }],
  );

  assert.equal(merged.length, 3);
  assert.deepEqual(Array.from(merged, (event) => event.eventId), ["b", "c", "a"]);
  assert.deepEqual(Array.from(merged, (event) => event.seq), [1, 2, 3]);

  const again = mergeEvents(merged, []);
  assert.deepEqual(Array.from(again, (event) => event.eventId), ["b", "c", "a"]);
  assert.deepEqual(Array.from(mergeEvents([], [])), []);
});

test("formatModelLine：无配置跟随宿主，有配置拼 provider/model · effort", function () {
  const { formatModelLine } = loadPlugin().exports.__test;
  assert.equal(formatModelLine(null), "跟随宿主");
  assert.equal(formatModelLine(undefined), "跟随宿主");
  assert.equal(formatModelLine({}), "跟随宿主");
  assert.equal(formatModelLine({ provider: "", model: "" }), "跟随宿主");
  assert.equal(formatModelLine({ provider: "deepseek", model: "", reasoningEffort: "high" }), "跟随宿主");
  assert.equal(formatModelLine({ provider: "deepseek", model: "deepseek-v4", reasoningEffort: "high" }), "deepseek/deepseek-v4 · 高");
  assert.equal(formatModelLine({ provider: "deepseek", model: "deepseek-v4" }), "deepseek/deepseek-v4");
  assert.equal(formatModelLine({ provider: "deepseek", model: "deepseek-v4", reasoningEffort: "custom" }), "deepseek/deepseek-v4 · custom");
  // model 自带 provider 前缀时只留最后一段，完整路径放 title。
  assert.equal(
    formatModelLine({ provider: "magpie", model: "workbuddy/deepseek-v4", reasoningEffort: "high" }),
    "deepseek-v4 · 高",
  );
});

test("seatDisplayName：name 与 short 同时存在时必须用完整名", function () {
  const { seatDisplayName, modelTitle } = loadPlugin().exports.__test;

  assert.equal(seatDisplayName({ roleId: "lead", name: "丞相", short: "丞" }), "丞相");
  assert.equal(seatDisplayName({ roleId: "zhongshu", name: "中书", short: "中" }), "中书");
  assert.equal(seatDisplayName({ roleId: "lead" }), "丞相", "缺 name 时回落到 ROLE_META 的完整名");
  assert.equal(seatDisplayName({ roleId: "lead", short: "丞" }), "丞相", "short 不能优先于 ROLE_META 的完整名");
  assert.equal(seatDisplayName({ name: "", roleId: "unknown" }), "unknown");

  assert.equal(modelTitle(null), "跟随宿主（未单独配置模型）");
  assert.equal(
    modelTitle({ provider: "magpie", model: "workbuddy/deepseek-v4", reasoningEffort: "high" }),
    "magpie/workbuddy/deepseek-v4 · 高",
  );
});

test("wirePathsFromLayout：量不到 DOM 时仍能生成三支 + 主干连线", function () {
  const { computeRailLayout, wirePathsFromLayout } = loadPlugin().exports.__test;
  const layout = computeRailLayout(400);
  const paths = wirePathsFromLayout(layout);

  assert.equal(paths.length, 4, "三省三支 + 尚书到六部一条主干");
  const branch = paths.filter((item) => item.kind === "branch");
  const trunk = paths.filter((item) => item.kind === "trunk");
  assert.equal(branch.length, 3);
  assert.equal(trunk.length, 1);
  assert.deepEqual(Array.from(branch).map((item) => item.key), ["lead-zhongshu", "lead-shangshu", "lead-menxia"]);
  for (const item of branch) {
    const id = item.key.replace(/^lead-/, "");
    const card = layout.sansheng.find((node) => node.id === id);
    assert.ok(item.d.includes(" C "), "分支必须用三次贝塞尔收口，垂直进入卡片顶边");
    assert.ok(!item.d.includes(" Q "), "不要退回二次贝塞尔（会在卡片顶边上方擦成一条横线）");
    const tail = item.d.match(/ C [0-9.]+ [0-9.]+ [0-9.]+ [0-9.]+ ([0-9.]+) ([0-9.]+)$/);
    assert.ok(tail, "分支末尾应是第二个控制点 + 终点");
    assert.ok(Math.abs(Number(tail[1]) - card.cx) < 0.06, "终点 x 应等于卡片顶边中点");
    assert.equal(Number(tail[2]), card.y, "终点 y 应落在卡片顶边");
  }
  const shangshu = layout.sansheng.find((node) => node.id === "shangshu");
  assert.equal(trunk[0].d, "M 200 " + (shangshu.y + shangshu.h) + " L 200 " + layout.groups.ministries.y);
});

test("apiPath：拼出同源工作台路径并编码查询串", function () {
  const { apiPath } = loadPlugin().exports.__test;
  assert.equal(apiPath("bootstrap"), "/sansheng/workbench/bootstrap");
  assert.equal(apiPath("/connect"), "/sansheng/workbench/connect");
  assert.equal(apiPath("events", { projectId: "p-1", since: 7 }), "/sansheng/workbench/events?projectId=p-1&since=7");
  assert.equal(apiPath("events", { projectId: "p 1", since: undefined }), "/sansheng/workbench/events?projectId=p%201");
  assert.equal(apiPath("bootstrap", {}), "/sansheng/workbench/bootstrap");
});

test("pickProjectId：优先当前工作区，其次 bootstrap 默认项目", function () {
  const { pickProjectId } = loadPlugin().exports.__test;
  const data = {
    projectId: "p-default",
    projects: [
      { id: "p-other", hostWorkspaceId: "ws-other" },
      { id: "p-mine", hostWorkspaceId: "ws-mine" },
    ],
  };
  assert.equal(pickProjectId(data, "ws-mine"), "p-mine");
  assert.equal(pickProjectId(data, "ws-missing"), null);
  assert.equal(pickProjectId(data), "p-default");
  assert.equal(pickProjectId({ projects: [{ id: "p-only" }] }), "p-only");
  assert.equal(pickProjectId({ projects: [] }), null);
});

test("apply：注册朝堂页签、pane 槽与 priority -1 的 main.conversation", function () {
  const plugin = loadPlugin();
  const mock = createCtx();
  plugin.exports.apply(mock.ctx);

  assert.ok(mock.injections.includes("sidebar.right.pane.tab"));
  assert.ok(mock.injections.includes("sidebar.right.pane.tab.title"));
  assert.ok(mock.injections.includes("main.conversation"));

  assert.equal(mock.tabs.length, 1);
  assert.equal(mock.tabs[0].id, "sansheng-liubu-workbench");
  assert.equal(mock.tabs[0].priority, "builtin");
  assert.equal(mock.tabs[0].title(), "朝堂");

  const main = mock.registrations.find((entry) => entry.spec && entry.spec.name === "main.conversation");
  assert.ok(main, "必须注册 main.conversation");
  assert.equal(main.spec.priority, -1);
  assert.deepEqual(Array.from(Object.keys(main.spec.children)), ["conversation.header"]);
});

test("apply：localStorage 逃生开关 sansheng.workbench.main=off 时不接管主区", function () {
  const plugin = loadPlugin({ storage: { "sansheng.workbench.main": "off" } });
  const mock = createCtx();
  plugin.exports.apply(mock.ctx);

  assert.equal(mock.injections.includes("main.conversation"), false);
  assert.ok(mock.injections.includes("sidebar.right.pane.tab"));
});

test("main.conversation：非绑定会话只透传原生 header/content，不加右栏", function () {
  const plugin = loadPlugin();
  const mock = createCtx();
  plugin.exports.apply(mock.ctx);

  const main = mock.registrations.find((entry) => entry.spec && entry.spec.name === "main.conversation");
  const tree = main.component({
    sessionId: "session-1",
    useSession: function () {
      return { openState: "open", blank: true, running: false, promptAttempted: false };
    },
    useSessions: function (select) {
      return select({ byId: { "session-1": { blank: true } } });
    },
    useConversation: function () {
      return { activeTargets: new Set() };
    },
    renderSlot: function (name) {
      return { type: "header-slot", name: name };
    },
    renderFactorySlot: function (name, params) {
      return { type: "content-slot", name: name, params: params };
    },
    widthControls: { width: 900 },
  });

  assert.equal(tree.props.className, "wb-main-native");
  const children = tree.children[0];
  assert.equal(children[0].type, "header-slot");
  assert.equal(children[1].type, "content-slot");
  assert.equal(children[1].params.phase, "hero");
  assert.deepEqual(children[1].params.hero, true);
  assert.ok(!JSON.stringify(tree).includes("wb-main-rail"), "非工作台会话不能出现右栏");
});

test("WorkbenchRail：无数据时也渲染完整骨架与三个内部页签", function () {
  const plugin = loadPlugin();
  const mock = createCtx();
  const tree = plugin.exports.WorkbenchRail({ ctx: mock.ctx, compact: true });

  assert.ok(tree.props.className.includes("wb-rail"));
  assert.ok(tree.props.className.includes("is-compact"));
  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes("三省六部"));
  assert.ok(serialized.includes("朝堂"));
  assert.ok(serialized.includes("任务"));
  assert.ok(serialized.includes("成果"));
  assert.ok(serialized.includes("十席 · 0 席已接通"));
  assert.ok(serialized.includes("六部 · 同级"));
  assert.ok(serialized.includes("正在读取") === false);
});

test("main.conversation：接管逻辑抛错时回退原生会话，不白屏", function () {
  const plugin = loadPlugin();
  const mock = createCtx();
  plugin.exports.apply(mock.ctx);

  const main = mock.registrations.find((entry) => entry.spec && entry.spec.name === "main.conversation");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = function () {
    warnings.push(Array.from(arguments));
  };
  try {
    const tree = main.component({
      sessionId: "session-1",
      useSession: function () {
        // 模拟接管逻辑在渲染途中抛异常（理论上不应发生，但必须兜住）。
        throw new Error("boom");
      },
      useSessions: function () {
        return undefined;
      },
      useConversation: function () {
        return { activeTargets: new Set() };
      },
      renderSlot: function (name) {
        return { type: "header-slot", name: name };
      },
      renderFactorySlot: function (name, params) {
        return { type: "content-slot", name: name, params: params };
      },
    });

    assert.equal(tree.props.className, "wb-main-native");
    assert.equal(tree.children[0][0].type, "header-slot");
    assert.equal(tree.children[0][1].type, "content-slot");
    assert.ok(!JSON.stringify(tree).includes("wb-main-split"), "回退时不能拼右栏");
    assert.ok(!JSON.stringify(tree).includes("wb-main-resizer"), "回退时不能拼分隔条");
    assert.ok(
      warnings.some((args) => String(args[0]).includes("接管失败")),
      "回退时要留下可诊断的 console.warn",
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("existenceLabel：missing / unknown / ok 三态，unknown 不能被当成正常", function () {
  const plugin = loadPlugin();
  const { existenceLabel } = plugin.exports.__test;

  assert.equal(existenceLabel("missing"), "文件已失效");
  assert.equal(existenceLabel("unknown"), "位置未核验");
  assert.equal(existenceLabel("ok"), "");
  assert.equal(existenceLabel(undefined), "");
  assert.notEqual(existenceLabel("unknown"), "");
  assert.ok(!existenceLabel("unknown").includes("正常"), "unknown 不能显示成正常");
  assert.ok(!existenceLabel("ok").includes("正常"), "ok 也不必写正常，静默即可");
});

test("verificationLabel：英文枚举翻成中文，别和「文件已失效」读成自相矛盾", function () {
  const plugin = loadPlugin();
  const { verificationLabel } = plugin.exports.__test;

  assert.equal(verificationLabel("verified"), "已核验");
  assert.equal(verificationLabel("unverified"), "未核验");
  assert.equal(verificationLabel("rejected"), "未通过");
  assert.equal(verificationLabel(undefined), "核验未知");
  // 「已核验」说的是结果被核验过，不是文件还在——不能出现「存在」「有效」这类字眼。
  assert.ok(!/存在|有效/.test(verificationLabel("verified")));
});

test("revisionLabel：第 N 版，只有真正修订且 N>1 才写「修订自上一版」", function () {
  const plugin = loadPlugin();
  const { revisionLabel } = plugin.exports.__test;

  assert.equal(revisionLabel({ revision: 1, revisesArtifactId: "art-0" }), "第 1 版");
  assert.ok(!revisionLabel({ revision: 1, revisesArtifactId: "art-0" }).includes("修订自"));
  assert.equal(revisionLabel({ revision: 2, revisesArtifactId: "art-0" }), "第 2 版 · 修订自上一版");
  assert.equal(revisionLabel({ revision: 3, revisesArtifactId: null }), "第 3 版");
  assert.equal(revisionLabel({}), "第 1 版");
  assert.equal(revisionLabel(null), "第 1 版");
});

test("taskKindLabel：只给 kind=revision 加「修订」标签", function () {
  const plugin = loadPlugin();
  const { taskKindLabel } = plugin.exports.__test;

  assert.equal(taskKindLabel({ kind: "revision" }), "修订");
  assert.equal(taskKindLabel({ kind: "normal" }), "");
  assert.equal(taskKindLabel({}), "");
  assert.equal(taskKindLabel(null), "");
});

test("A27 分隔条键盘：方向键 / Shift / Home / End 有确定步长，其它键不动", function () {
  const { railResizeTarget } = loadPlugin().exports.__test;

  // 默认 16px 一档，Shift 加速到 64px。
  assert.equal(railResizeTarget("ArrowLeft", { width: 400 }), 384);
  assert.equal(railResizeTarget("ArrowRight", { width: 400 }), 416);
  assert.equal(railResizeTarget("ArrowRight", { width: 400, shift: true }), 464);
  assert.equal(railResizeTarget("ArrowLeft", { width: 400, shift: true }), 340); // 400-64 撞下限 340

  // 两端截断，不会跑出 340–600。
  assert.equal(railResizeTarget("Home", { width: 500 }), 340);
  assert.equal(railResizeTarget("End", { width: 500 }), 600);
  assert.equal(railResizeTarget("ArrowLeft", { width: 340 }), 340);
  assert.equal(railResizeTarget("ArrowRight", { width: 600 }), 600);
  assert.equal(railResizeTarget("ArrowRight", { width: 595, shift: true }), 600);

  // 不认识的键返回 null：调用方不能 preventDefault，浏览器的默认行为要保留。
  assert.equal(railResizeTarget("Tab", { width: 400 }), null);
  assert.equal(railResizeTarget("Enter", { width: 400 }), null);
  assert.equal(railResizeTarget(undefined, { width: 400 }), null);
});

test("任务行动作：草稿可派工、排队可派可取消、终态不给按钮", () => {
  const { taskActionKeys } = loadPlugin().exports.__test;

  // 草稿只是记在账本里，还没进部门队列，只能派工。
  assert.equal(taskActionKeys({ status: "draft" }).join(","), 'dispatch');
  // 排队：既能补派（幂等键会去重），也能取消。
  assert.equal(taskActionKeys({ status: "queued" }).join(","), 'dispatch,cancel');
  // 正在跑 / 需人处理：只能取消，不再重复派。
  assert.equal(taskActionKeys({ status: "running" }).join(","), 'cancel');
  assert.equal(taskActionKeys({ status: "needs_attention" }).join(","), 'cancel');
  // 终态不给动作：避免对已完成任务再派一次。
  assert.equal(taskActionKeys({ status: "completed" }).join(","), '');
  assert.equal(taskActionKeys({ status: "cancelled" }).join(","), '');
  assert.equal(taskActionKeys({ status: "failed" }).join(","), '');
  assert.equal(taskActionKeys(null).join(","), '');
});
