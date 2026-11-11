#!/usr/bin/env node
/**
 * preview-workbench.mjs — 任意 DSH 客户端 bundle 的离线渲染 + 截图工具。
 *
 * 与 scripts/preview.mjs 的区别：那个脚本是「朝堂侧栏」专用、演示数据写死；
 * 这个脚本接受任意 bundle 路径，用 vm 在伪 window 上加载真实 bundle，
 * 打桩 fetch 数据，用会真正重渲染的 hooks 替身跑完异步 effect，
 * 把组件树序列化成 HTML，最后交给本机 Chrome 截图。
 *
 * 用法：
 *   node scripts/preview-workbench.mjs --bundle=<path> --out=<dir> --name=<file> \
 *     --theme=light|dark --width=400
 */

import vm from 'node:vm'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SCRATCH = join(ROOT, '.scratch', 'preview-workbench')
const ROUTE_PREFIX = '/sansheng/workbench'
const LEAD_SESSION = 'sess-lead'

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

// #region 基础工具

function fail(message) {
  const error = new Error(message)
  error.previewFailure = true
  throw error
}

function log(message) {
  process.stdout.write(`[preview-workbench] ${message}\n`)
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function parseArgs(argv) {
  const options = {
    bundle: 'workbench/panel/lib/client.js',
    out: 'docs/preview',
    name: 'v01-workbench-rail',
    theme: 'light',
    width: 400,
    scale: 2,
    chrome: null,
    view: 'court',
    open: '',
    scenario: '',
    live: false,
    help: false,
  }
  const keys = {
    bundle: 'bundle',
    out: 'out',
    name: 'name',
    theme: 'theme',
    width: 'width',
    scale: 'scale',
    chrome: 'chrome',
    view: 'view',
    open: 'open',
    scenario: 'scenario',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (!arg.startsWith('--')) fail(`无法识别的参数：${arg}`)
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    const rawKey = eq === -1 ? body : body.slice(0, eq)
    if (rawKey === 'help') {
      options.help = true
      continue
    }
    if (rawKey === 'live') {
      if (eq !== -1 && body.slice(eq + 1) === 'false') options.live = false
      else options.live = true
      continue
    }
    const field = keys[rawKey]
    if (!field) fail(`无法识别的参数：--${rawKey}`)
    let value
    if (eq === -1) {
      index += 1
      value = argv[index]
      if (value === undefined) fail(`参数 --${rawKey} 缺少值`)
    } else {
      value = body.slice(eq + 1)
    }
    options[field] = value
  }
  return options
}

function inferLiveScenario(name, view) {
  if (/cancel/i.test(name)) return 'cancel'
  if (/revise/i.test(name)) return 'revise'
  if (/missing/i.test(name)) return 'missing'
  if (view === 'tasks') return 'tasks'
  if (view === 'artifacts') return 'revise'
  return 'court'
}

function usage() {
  return [
    '用法：',
    '  node scripts/preview-workbench.mjs --bundle=<path> --out=<dir> --name=<file> \\',
    '    --theme=light|dark --width=400',
    '',
    '选项：',
    '  --bundle  bundle 路径，默认 workbench/panel/lib/client.js',
    '  --out     截图输出目录，默认 docs/preview',
    '  --name    输出文件名前缀，默认 v01-workbench-rail',
    '  --theme   light | dark，默认 light',
    '  --width   截图宽度（CSS px），默认 400',
    '  --scale   设备像素比，默认 2',
    '  --chrome  Chrome/Edge 可执行文件路径，默认自动探测',
    '  --view    court | tasks | artifacts，先切到该页签再截图，默认 court',
    '  --open    切到成果页后点开匹配这段文字的成果行（看详情抽屉）',
    '  --scenario  live 场景：court | tasks | cancel | revise | missing（默认按 --name 推断）',
    '  --live    不打死数据：把 bundle 的 fetch 接到仓库内真实 Host 路由（内存账本）',
    '  --help    显示本帮助',
  ].join('\n')
}

function chromeRun(chrome, args, label) {
  const result = spawnSync(chrome, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) fail(`${label} 调用 Chrome 失败：${result.error.message}`)
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split(/\r?\n/).slice(-8).join('\n')
    fail(`${label} 失败（Chrome 退出码 ${result.status}）${stderr ? `：\n${stderr}` : ''}`)
  }
  return result
}

function findChrome(explicit) {
  const candidates = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES
  for (const candidate of candidates) {
    try {
      if (candidate && statSync(candidate).isFile()) return candidate
    } catch (error) {
      // 继续找下一个
    }
  }
  fail(`找不到 Chrome/Edge。可用 --chrome=<path> 指定。尝试过：\n${candidates.join('\n')}`)
}

function readPngSize(pngPath) {
  const bytes = readFileSync(pngPath)
  if (bytes.length < 33) fail(`截图文件不完整：${pngPath}（${bytes.length} 字节）`)
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    fail(`截图不是合法 PNG：${pngPath}`)
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
  }
}

// #endregion

// #region 固定演示数据（形状对齐 workbench/host/service.mjs）

const SEATS = [
  { roleId: 'lead', name: '丞相', short: '丞', tier: 'leaders', group: 'lead', column: 'span', row: 0, duty: '接需求、分流、协调、汇报', canDispatch: true },
  { roleId: 'zhongshu', name: '中书', short: '中', tier: 'leaders', group: 'sansheng', column: 'left', row: 1, duty: '调查、澄清、规划', canDispatch: false },
  { roleId: 'shangshu', name: '尚书', short: '尚', tier: 'leaders', group: 'sansheng', column: 'center', row: 1, duty: '分工建议、组织交付', canDispatch: true },
  { roleId: 'menxia', name: '门下', short: '门', tier: 'leaders', group: 'sansheng', column: 'right', row: 1, duty: '审议与整体审核', canDispatch: false },
  { roleId: 'libu', name: '吏部', short: '吏', tier: 'ministries', group: 'ministries', column: 'left', row: 2, duty: '角色和技能配置建议', canDispatch: false },
  { roleId: 'hubu', name: '户部', short: '户', tier: 'ministries', group: 'ministries', column: 'center', row: 2, duty: '数据、表格、计算', canDispatch: false },
  { roleId: 'lipu', name: '礼部', short: '礼', tier: 'ministries', group: 'ministries', column: 'right', row: 2, duty: '文档、内容、呈现', canDispatch: false },
  { roleId: 'bingbu', name: '兵部', short: '兵', tier: 'ministries', group: 'ministries', column: 'left', row: 3, duty: '环境、调试、部署', canDispatch: false },
  { roleId: 'xingbu', name: '刑部', short: '刑', tier: 'ministries', group: 'ministries', column: 'center', row: 3, duty: '测试与风险检查', canDispatch: false },
  { roleId: 'gongbu', name: '工部', short: '工', tier: 'ministries', group: 'ministries', column: 'right', row: 3, duty: '代码实现与工程产出', canDispatch: false },
]

const TASKS = [
  {
    id: 'task_demo_running',
    projectId: 'prj_demo1',
    title: '生成离线预览截图',
    objective: '在 400px 窄栏下渲染工作台并输出 light / dark 两张截图。',
    acceptance: ['两张 PNG 宽度为 800px（2x）', '不修改被预览的 bundle'],
    constraints: ['只写 .scratch 与 docs/preview'],
    scope: 'preview',
    ownerRoleId: 'gongbu',
    sourceRoleId: 'shangshu',
    originMessageRef: 'msg_demo_1',
    returnTarget: 'shangshu',
    status: 'running',
    activeAttemptId: 'attempt_demo_running',
    attempts: [
      {
        id: 'attempt_demo_running',
        projectId: 'prj_demo1',
        taskId: 'task_demo_running',
        state: 'running',
        startedAt: '2026-11-09T22:10:00.000Z',
        endedAt: null,
      },
    ],
    startedAt: '2026-11-09T22:10:00.000Z',
    endedAt: null,
    reportReceivedAt: null,
    needsAttentionReason: null,
    failureReason: null,
    waitingReason: null,
    revision: 3,
    createdAt: '2026-11-09T22:09:00.000Z',
    updatedAt: '2026-11-09T22:12:00.000Z',
    open: true,
    attemptCount: 1,
    resultCount: 0,
  },
  {
    id: 'task_demo_attention',
    projectId: 'prj_demo1',
    title: '复核 2x 截图的验收口径',
    objective: '确认 800px 宽的 PNG 是否满足交付要求，并记录结论。',
    acceptance: ['给出明确的接受 / 不接受结论'],
    constraints: ['不重启 DSH'],
    scope: 'review',
    ownerRoleId: 'xingbu',
    sourceRoleId: 'lead',
    originMessageRef: 'msg_demo_2',
    returnTarget: 'lead',
    status: 'needs_attention',
    activeAttemptId: null,
    attempts: [],
    startedAt: '2026-11-09T22:05:00.000Z',
    endedAt: null,
    reportReceivedAt: null,
    needsAttentionReason: '验收标准需要人工确认：是否接受 2x 设备像素比截图？',
    failureReason: null,
    waitingReason: null,
    revision: 2,
    createdAt: '2026-11-09T22:04:00.000Z',
    updatedAt: '2026-11-09T22:14:00.000Z',
    open: true,
    attemptCount: 0,
    resultCount: 0,
  },
  {
    id: 'task_demo_revision',
    projectId: 'prj_demo1',
    title: '修订：离线预览截图',
    kind: 'revision',
    objective: '按验收意见重拍 light 页并补一张成果详情。',
    acceptance: ['修订后的截图进入成果账本'],
    constraints: ['不重启 DSH'],
    scope: 'preview',
    ownerRoleId: 'gongbu',
    sourceRoleId: 'xingbu',
    originMessageRef: 'msg_demo_4',
    returnTarget: 'xingbu',
    status: 'queued',
    activeAttemptId: null,
    attempts: [],
    startedAt: null,
    endedAt: null,
    reportReceivedAt: null,
    needsAttentionReason: null,
    failureReason: null,
    waitingReason: null,
    revision: 1,
    createdAt: '2026-11-09T22:15:00.000Z',
    updatedAt: '2026-11-09T22:16:00.000Z',
    open: true,
    attemptCount: 0,
    resultCount: 0,
  },
  {
    id: 'task_demo_done',
    projectId: 'prj_demo1',
    title: '核对十席角色文案',
    objective: '按 roles.mjs 校对十席名称、简写和职责。',
    acceptance: ['十席全部一致'],
    constraints: [],
    scope: 'copy',
    ownerRoleId: 'hubu',
    sourceRoleId: 'zhongshu',
    originMessageRef: 'msg_demo_3',
    returnTarget: 'zhongshu',
    status: 'completed',
    activeAttemptId: null,
    attempts: [
      {
        id: 'attempt_demo_done',
        projectId: 'prj_demo1',
        taskId: 'task_demo_done',
        state: 'completed',
        startedAt: '2026-11-09T21:40:00.000Z',
        endedAt: '2026-11-09T21:52:00.000Z',
      },
    ],
    startedAt: '2026-11-09T21:40:00.000Z',
    endedAt: '2026-11-09T21:52:00.000Z',
    reportReceivedAt: '2026-11-09T21:52:30.000Z',
    needsAttentionReason: null,
    failureReason: null,
    waitingReason: null,
    revision: 5,
    createdAt: '2026-11-09T21:39:00.000Z',
    updatedAt: '2026-11-09T21:53:00.000Z',
    open: false,
    attemptCount: 1,
    resultCount: 1,
  },
]

const ARTIFACTS = [
  {
    id: 'artifact_demo_light',
    projectId: 'prj_demo1',
    taskId: 'task_demo_running',
    ownerRoleId: 'gongbu',
    fileRef: '.scratch/preview-workbench/v01-workbench-rail-400-light.png',
    displayName: 'v01-workbench-rail-400-light.png',
    mediaType: 'image/png',
    versionOrHash: 'sha256:preview-demo-light',
    verification: { status: 'verified' },
    sourceResultId: null,
    createdAt: '2026-11-09T22:11:00.000Z',
    updatedAt: '2026-11-09T22:11:00.000Z',
  },
  {
    id: 'artifact_demo_report',
    projectId: 'prj_demo1',
    taskId: 'task_demo_attention',
    ownerRoleId: 'xingbu',
    fileRef: 'docs/preview/巡检报告.md',
    displayName: '巡检报告.md',
    mediaType: 'text/markdown',
    versionOrHash: 'sha256:preview-demo-report',
    verification: { status: 'pending' },
    sourceResultId: null,
    createdAt: '2026-11-09T22:13:00.000Z',
    updatedAt: '2026-11-09T22:13:00.000Z',
  },
  {
    id: 'artifact_demo_missing',
    projectId: 'prj_demo1',
    taskId: 'task_demo_attention',
    ownerRoleId: 'xingbu',
    fileRef: '.scratch/preview-workbench/缺失的验收单.pdf',
    displayName: '缺失的验收单.pdf',
    mediaType: 'application/pdf',
    versionOrHash: 'sha256:preview-demo-missing',
    verification: { status: 'missing' },
    existence: 'missing',
    revision: 1,
    sourceResultId: null,
    createdAt: '2026-11-09T22:13:20.000Z',
    updatedAt: '2026-11-09T22:13:20.000Z',
  },
  {
    id: 'artifact_demo_unknown',
    projectId: 'prj_demo1',
    taskId: 'task_demo_running',
    ownerRoleId: 'gongbu',
    fileRef: '.scratch/preview-workbench/待核验的交付物.zip',
    displayName: '待核验的交付物.zip',
    mediaType: 'application/zip',
    versionOrHash: 'sha256:preview-demo-unknown',
    verification: { status: 'unknown' },
    existence: 'unknown',
    revision: 1,
    sourceResultId: null,
    createdAt: '2026-11-09T22:13:40.000Z',
    updatedAt: '2026-11-09T22:13:40.000Z',
  },
  {
    id: 'artifact_demo_revision',
    projectId: 'prj_demo1',
    taskId: 'task_demo_revision',
    ownerRoleId: 'gongbu',
    fileRef: 'docs/preview/v01-workbench-rail-400-light.png',
    displayName: '预览截图（第 2 版）.png',
    mediaType: 'image/png',
    versionOrHash: 'sha256:preview-demo-revision-2',
    verification: { status: 'verified' },
    existence: 'present',
    revision: 2,
    revisesArtifactId: 'artifact_demo_light',
    sourceResultId: null,
    createdAt: '2026-11-09T22:16:10.000Z',
    updatedAt: '2026-11-09T22:16:10.000Z',
  },
]

const PROJECT = {
  id: 'prj_demo1',
  hostWorkspaceId: 'ws_demo',
  displayNameCache: '演示项目',
  canonicalRoot: 'C:\\demo',
  status: 'active',
  schemaVersion: 1,
  revision: 4,
  createdAt: '2026-11-09T20:00:00.000Z',
  updatedAt: '2026-11-09T22:14:00.000Z',
}

function buildSeats() {
  const states = {
    lead: 'idle',
    gongbu: 'running',
    xingbu: 'needs_attention',
  }
  return SEATS.map((seat) => {
    const status = states[seat.roleId] || 'uninitialized'
    const connected = status !== 'uninitialized'
    const sessionId = connected ? `sess_${seat.roleId}` : null
    const activeTask = TASKS.find(
      (task) => task.ownerRoleId === seat.roleId && task.open,
    )
    return {
      roleId: seat.roleId,
      name: seat.name,
      short: seat.short,
      tier: seat.tier,
      group: seat.group,
      column: seat.column,
      row: seat.row,
      duty: seat.duty,
      canDispatch: seat.canDispatch,
      connected,
      pending: !connected,
      pendingLabel: connected ? null : '尚未接通',
      activeTaskId: activeTask ? activeTask.id : null,
      binding: connected
        ? {
            id: `binding_${seat.roleId}`,
            currentSessionId: sessionId,
            bindingGeneration: 1,
            status,
            historyCount: 0,
            revision: 1,
          }
        : null,
      config: {
        provider: 'magpie',
        model: 'workbuddy/deepseek-v4.1-flash',
        reasoningEffort: 'high',
        configRevision: 3,
        configured: true,
      },
      session: {
        running: seat.roleId === 'gongbu',
        available: true,
      },
    }
  })
}

function buildBootstrap() {
  const seats = buildSeats()
  return {
    projects: [
      {
        ...PROJECT,
        seatCount: SEATS.length,
        taskCount: TASKS.length,
        openTaskCount: TASKS.filter((task) => task.open).length,
      },
    ],
    projectId: PROJECT.id,
    project: { ...PROJECT },
    seats,
    layout: {
      lead: ['lead'],
      chancellery: ['zhongshu', 'shangshu', 'menxia'],
      sansheng: ['zhongshu', 'shangshu', 'menxia'],
      ministries: [
        ['libu', 'hubu', 'lipu'],
        ['bingbu', 'xingbu', 'gongbu'],
      ],
    },
    tasks: TASKS,
    artifacts: ARTIFACTS,
    results: [],
    eventSeq: 42,
  }
}

// #endregion

// #region 伪浏览器环境 + fetch 打桩

function createDemoStorage() {
  const store = new Map([
    [
      'sansheng-liubu.route.gongbu',
      JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }),
    ],
  ])
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
    clear: () => { store.clear() },
    key: () => null,
    get length() { return store.size },
  }
}

function routePath(input) {
  const raw = typeof input === 'string'
    ? input
    : input && typeof input.url === 'string'
      ? input.url
      : String(input)
  try {
    return new URL(raw, 'http://preview.local').pathname
  } catch (error) {
    return raw.split('?')[0]
  }
}

function makeResponse(status, payload) {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => JSON.parse(text),
    text: async () => text,
    clone() { return makeResponse(status, payload) },
  }
}

function createFetchStub(theme, onUnknown) {
  const unknown = new Set()
  const routes = new Map([
    [`${ROUTE_PREFIX}/bootstrap`, () => buildBootstrap()],
    [`${ROUTE_PREFIX}/events`, () => ({ events: [], reset: false, seq: 42, hasMore: false })],
    [`${ROUTE_PREFIX}/projects`, () => buildBootstrap().projects],
    [`${ROUTE_PREFIX}/seats`, () => buildSeats()],
    [`${ROUTE_PREFIX}/layout`, () => buildBootstrap().layout],
    [`${ROUTE_PREFIX}/tasks`, () => TASKS],
    [`${ROUTE_PREFIX}/artifacts`, () => ARTIFACTS],
    [`${ROUTE_PREFIX}/results`, () => []],
  ])
  return async function fetchStub(input, init) {
    const path = routePath(input)
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    const factory = routes.get(path)
    if (factory) return makeResponse(200, { ok: true, value: factory() })
    if (!unknown.has(path)) {
      unknown.add(path)
      if (typeof onUnknown === 'function') onUnknown(path, method)
    }
    // 未知路由不抛错：尽量让面板继续渲染，而不是整页空白。
    const fallback = path.endsWith('s') ? [] : {}
    return makeResponse(200, { ok: true, value: fallback, previewStub: true })
  }
}

function createBrowserEnv({ theme, fetchStub }) {
  const styleTexts = []
  const listeners = new Map()

  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        textContent: '',
        innerHTML: '',
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
      }
    },
    createTextNode(text) {
      return { textContent: String(text) }
    },
    head: {
      appendChild(node) {
        if (node && typeof node.textContent === 'string' && node.textContent.trim() !== '') {
          styleTexts.push(node.textContent)
        }
      },
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
    documentElement: {
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener() {},
    visibilityState: 'visible',
    hidden: false,
    cookie: '',
  }

  const window = {
    document,
    location: { href: 'http://preview.local/', pathname: '/', origin: 'http://preview.local', search: '' },
    navigator: { userAgent: 'preview-workbench', language: 'zh-CN', languages: ['zh-CN'], platform: 'Win32' },
    localStorage: createDemoStorage(),
    sessionStorage: createDemoStorage(),
    devicePixelRatio: 2,
    innerWidth: 400,
    innerHeight: 800,
    matchMedia(query) {
      const wantsDark = theme === 'dark' && /prefers-color-scheme\s*:\s*dark/i.test(String(query))
      return {
        matches: wantsDark,
        media: String(query),
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
      }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // bundle 里有事件轮询（setTimeout 链 / setInterval）。这些计时器若保持
    // ref 状态，截图跑完后 Node 永远不会退出。unref 掉：只要主流程结束，
    // 进程就能正常收尾，同时轮询在存活期间照常执行。
    requestAnimationFrame: (callback) => unrefTimer(setTimeout(() => callback(Date.now()), 0)),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    addEventListener(type, handler) {
      const list = listeners.get(type) || []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener() {},
    fetch: fetchStub,
    alert() {},
    focus() {},
    scrollTo() {},
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class IntersectionObserver {
    constructor(callback) { this.callback = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  return { document, window, styleTexts, ResizeObserver, IntersectionObserver, MutationObserver }
}

// #endregion

// #region 加载 bundle + React / hooks 替身

function createHooks() {
  const slotMap = new Map()
  const instanceMap = new Map()
  const contextStack = []
  const keyStack = []
  const cursorStack = []
  let currentKey = null
  let cursor = 0
  let dirty = false
  let effectQueue = []
  let idCounter = 0

  const markDirty = () => { dirty = true }

  const depsEqual = (a, b) => {
    if (a === undefined) return false
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const rootKey = '<root>'
  const slotsFor = (key) => {
    let slots = slotMap.get(key)
    if (!slots) {
      slots = []
      slotMap.set(key, slots)
    }
    return slots
  }
  const useSlot = () => {
    const key = currentKey === null ? rootKey : currentKey
    const slots = slotsFor(key)
    const index = cursor
    cursor += 1
    if (!slots[index]) slots[index] = {}
    return slots[index]
  }

  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
      this.context = undefined
    }
    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state) : partial
      this.state = { ...this.state, ...(next || {}) }
      markDirty()
    }
    forceUpdate() { markDirty() }
  }
  Component.prototype.isReactComponent = {}

  function createElement(type, config, ...children) {
    const props = { ...(config || {}) }
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { type, props, children }
  }

  function createContext(defaultValue) {
    const context = {
      _defaultValue: defaultValue,
      _stack: [],
    }
    context.Provider = function ContextProvider(props) {
      return props.children
    }
    context.Provider.__previewContext = context
    context.Consumer = function ContextConsumer(props) {
      const value = context._stack.length > 0
        ? context._stack[context._stack.length - 1]
        : context._defaultValue
      return typeof props.children === 'function' ? props.children(value) : null
    }
    context.Consumer.__previewContext = context
    return context
  }

  const React = {
    createElement,
    cloneElement: (element, extraProps, ...children) => {
      const props = { ...(element.props || {}), ...(extraProps || {}) }
      if (children.length === 1) props.children = children[0]
      else if (children.length > 1) props.children = children
      return { type: element.type, props, children }
    },
    isValidElement: (value) => Boolean(value && typeof value === 'object' && value.type !== undefined),
    createContext,
    Component,
    PureComponent: Component,
    Fragment: 'fragment',
    StrictMode: 'fragment',
    Suspense: function Suspense(props) { return props.children },
    memo: (component) => component,
    forwardRef: (render) => function ForwardRefComponent(props) {
      return render(props, props && props.ref ? props.ref : { current: null })
    },
    useContext(context) {
      if (!context || !Array.isArray(context._stack)) return undefined
      return context._stack.length > 0
        ? context._stack[context._stack.length - 1]
        : context._defaultValue
    },
    useState(initial) {
      const slot = useSlot()
      if (!('value' in slot)) {
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        markDirty()
      }
      return [slot.value, setState]
    },
    useReducer(reducer, initialArg, init) {
      const slot = useSlot()
      if (!('value' in slot)) {
        slot.value = typeof init === 'function' ? init(initialArg) : initialArg
      }
      const dispatch = (action) => {
        const value = reducer(slot.value, action)
        if (Object.is(value, slot.value)) return
        slot.value = value
        markDirty()
      }
      return [slot.value, dispatch]
    },
    useRef(initial) {
      const slot = useSlot()
      if (!('ref' in slot)) slot.ref = { current: initial }
      return slot.ref
    },
    useEffect(effect, deps) {
      const slot = useSlot()
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? deps.slice() : undefined
        const previousCleanup = slot.cleanup
        effectQueue.push(() => {
          if (typeof previousCleanup === 'function') previousCleanup()
          const cleanup = effect()
          slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        })
      }
    },
    useLayoutEffect(effect, deps) {
      React.useEffect(effect, deps)
    },
    useInsertionEffect(effect, deps) {
      React.useEffect(effect, deps)
    },
    useMemo(factory, deps) {
      const slot = useSlot()
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? deps.slice() : undefined
        slot.value = factory()
      }
      return slot.value
    },
    useCallback(fn, deps) {
      const slot = useSlot()
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? deps.slice() : undefined
        slot.value = fn
      }
      return slot.value
    },
    useImperativeHandle(ref, create, deps) {
      const slot = useSlot()
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? deps.slice() : undefined
        const value = create()
        if (ref && typeof ref === 'object') ref.current = value
        else if (typeof ref === 'function') ref(value)
      }
    },
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      const slot = useSlot()
      if (!slot.subscribed) {
        slot.subscribed = true
        try {
          slot.value = getSnapshot()
        } catch (error) {
          slot.value = typeof getServerSnapshot === 'function' ? getServerSnapshot() : undefined
        }
        if (typeof subscribe === 'function') {
          try {
            const unsubscribe = subscribe(() => {
              let next
              try {
                next = getSnapshot()
              } catch (error) {
                return
              }
              if (!Object.is(next, slot.value)) {
                slot.value = next
                markDirty()
              }
            })
            if (typeof unsubscribe === 'function') slot.unsubscribe = unsubscribe
          } catch (error) {
            // 预览里订阅失败不阻断渲染
          }
        }
      }
      return slot.value
    },
    useId() {
      idCounter += 1
      return `:pv${idCounter}:`
    },
    useDebugValue() {},
    useTransition() { return [false, (callback) => { callback() }] },
    useDeferredValue(value) { return value },
  }

  return {
    React,
    enter(key) {
      keyStack.push(currentKey)
      cursorStack.push(cursor)
      currentKey = key
      cursor = 0
    },
    leave() {
      currentKey = keyStack.length > 0 ? keyStack.pop() : null
      cursor = cursorStack.length > 0 ? cursorStack.pop() : 0
    },
    beginRender() {
      cursor = 0
      effectQueue = []
    },
    runEffects() {
      const queue = effectQueue
      effectQueue = []
      for (const effect of queue) effect()
      return queue.length
    },
    consumeDirty() {
      const value = dirty
      dirty = false
      return value
    },
    instanceMap,
  }
}

function loadBundle(sourcePath, hooks, options) {
  if (!existsSync(sourcePath)) fail(`找不到 bundle：${sourcePath}`)
  const source = readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '')
  if (!source.includes('__ModuleLoader__')) {
    fail(`${sourcePath} 看起来不是 DSH 客户端 bundle（未找到 __ModuleLoader__）。`)
  }

  const { React } = hooks
  const env = createBrowserEnv({
    theme: options.theme,
    fetchStub: options.fetchStub || createFetchStub(options.theme, (path, method) => {
      log(`fetch 未命中固定数据：${method} ${path}（返回空对象/数组占位）`)
    }),
  })
  const { document, window, styleTexts } = env
  let loaded = null

  window.__ModuleLoader__ = {
    load(registration) {
      loaded = registration
      const module = { exports: {} }
      const requireStub = (name) => {
        if (name === 'react') return React
        throw new Error(`预览加载器不认识的模块：${name}（只支持 react）`)
      }
      const exported = registration.factory(requireStub)
      if (exported !== undefined) module.exports = exported
      loaded.exports = module.exports
    },
  }

  const sandbox = {
    window,
    document,
    console,
    URL,
    URLSearchParams,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Proxy,
    Reflect,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    TypeError,
    RangeError,
    RegExp,
    Intl,
    TextEncoder,
    TextDecoder,
    setTimeout: (callback, delay, ...args) => unrefTimer(setTimeout(callback, delay, ...args)),
    clearTimeout,
    setInterval: (callback, delay, ...args) => unrefTimer(setInterval(callback, delay, ...args)),
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    structuredClone,
    fetch: window.fetch,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    matchMedia: window.matchMedia,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    getComputedStyle: window.getComputedStyle,
    ResizeObserver: env.ResizeObserver,
    IntersectionObserver: env.IntersectionObserver,
    MutationObserver: env.MutationObserver,
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    navigator: window.navigator,
    location: window.location,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  try {
    vm.runInNewContext(source, sandbox, { filename: sourcePath, timeout: 30000 })
  } catch (error) {
    fail(`加载 bundle 失败（${sourcePath}）：\n${error && error.stack ? error.stack : error}`)
  }
  if (!loaded || !loaded.exports) fail(`bundle 没有调用 __ModuleLoader__.load：${sourcePath}`)

  // 保留 bundle 自己注册样式的插入顺序（后面的覆盖前面的），只做去重，
  // 避免按长度排序改变级联顺序、把主题变量覆盖错。
  const seen = new Set()
  const cssParts = []
  for (const text of styleTexts) {
    if (!text || text.trim() === '' || seen.has(text)) continue
    seen.add(text)
    cssParts.push(text)
  }
  const css = cssParts.join('\n')

  return {
    exports: loaded.exports,
    css,
    sourcePath,
    document,
    window,
    styleTexts,
  }
}

// #endregion

// #region vnode → HTML

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const ATTR_ALIASES = {
  className: 'class',
  htmlFor: 'for',
  tabIndex: 'tabindex',
  colSpan: 'colspan',
  rowSpan: 'rowspan',
  maxLength: 'maxlength',
  minLength: 'minlength',
  readOnly: 'readonly',
  autoFocus: 'autofocus',
  autoComplete: 'autocomplete',
  viewBox: 'viewBox',
  preserveAspectRatio: 'preserveAspectRatio',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
  xmlnsXlink: 'xmlns:xlink',
}

const BOOLEAN_ATTRS = new Set([
  'disabled', 'checked', 'selected', 'hidden', 'readonly', 'required',
  'multiple', 'open', 'autofocus', 'novalidate', 'formnovalidate',
])

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kebabStyleName(name) {
  if (name.startsWith('--')) return name
  if (name === 'msTransform') return '-ms-transform'
  const prefixed = name.replace(/^(Webkit|Moz|O)(?=[A-Z])/, (match) => `-${match.toLowerCase()}`)
  return prefixed.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}

const UNITLESS_STYLES = new Set([
  'line-height', 'opacity', 'font-weight', 'z-index', 'flex', 'flex-grow',
  'flex-shrink', 'order', 'zoom', 'aspect-ratio', 'flex-basis',
])

function styleToString(style) {
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [name, raw] of Object.entries(style)) {
    if (raw === null || raw === undefined || raw === false) continue
    const key = kebabStyleName(name)
    let value = raw
    if (typeof value === 'number' && value !== 0 && !UNITLESS_STYLES.has(key)) value = `${value}px`
    parts.push(`${key}:${value}`)
  }
  return parts.join(';')
}

function buildAttributes(type, props) {
  const attrs = []
  for (const [rawName, rawValue] of Object.entries(props || {})) {
    if (rawName === 'children' || rawName === 'key' || rawName === 'ref') continue
    if (rawName === '__self' || rawName === '__source') continue
    if (rawName === 'dangerouslySetInnerHTML') continue
    if (rawName === 'value' && type === 'select') continue
    if (rawName === 'value' && type === 'option') continue
    if (rawName === 'selected' && type === 'option') continue
    if (typeof rawValue === 'function' || typeof rawValue === 'symbol') continue
    if (rawValue === undefined || rawValue === null) continue

    let name = rawName
    if (rawName === 'className') {
      name = 'class'
    } else if (ATTR_ALIASES[rawName]) {
      name = ATTR_ALIASES[rawName]
    } else if (!rawName.includes('-') && /[A-Z]/.test(rawName)) {
      name = rawName.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
    }

    if (name === 'class') {
      const value = Array.isArray(rawValue) ? rawValue.filter(Boolean).join(' ') : String(rawValue)
      if (value) attrs.push(`class="${escapeAttr(value)}"`)
      continue
    }
    if (name === 'style') {
      const value = styleToString(rawValue)
      if (value) attrs.push(`style="${escapeAttr(value)}"`)
      continue
    }
    if (name.startsWith('aria-') || name.startsWith('data-')) {
      attrs.push(`${name}="${escapeAttr(String(rawValue))}"`)
      continue
    }
    if (name === 'value' && type === 'option') continue
    if (BOOLEAN_ATTRS.has(name)) {
      if (rawValue === true || rawValue === '') attrs.push(`${name}=""`)
      continue
    }
    if (rawValue === false) continue
    if (rawValue === true) {
      attrs.push(`${name}=""`)
      continue
    }
    attrs.push(`${name}="${escapeAttr(String(rawValue))}"`)
  }
  return attrs.length ? ` ${attrs.join(' ')}` : ''
}

function serializeNode(node, options = {}) {
  if (!node) return ''
  if (node.text !== undefined) return escapeText(node.text)
  if (node.fragment) return node.children.map((child) => serializeNode(child, options)).join('')

  const { type, props, children } = node
  if (typeof type !== 'string') fail(`序列化遇到非字符串标签：${String(type)}`)

  if (type === 'select') {
    const attrs = buildAttributes(type, props)
    const inner = children.map((child) => serializeNode(child, { selectValue: props.value })).join('')
    return `<select${attrs}>${inner}</select>`
  }

  if (type === 'option') {
    const attrs = []
    for (const [name, value] of Object.entries(props || {})) {
      if (name === 'children' || name === 'key' || name === 'selected' || name === 'value') continue
      if (value === undefined || value === null || value === false || typeof value === 'function') continue
      attrs.push(`${name}="${escapeAttr(String(value))}"`)
    }
    if (props && props.value !== undefined && props.value !== null) attrs.push(`value="${escapeAttr(String(props.value))}"`)
    const selected = (props && props.selected === true)
      || (options.selectValue !== undefined && options.selectValue !== null && props && String(props.value) === String(options.selectValue))
    if (selected) attrs.push('selected=""')
    const inner = children.map((child) => serializeNode(child, options)).join('')
    return `<option${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner}</option>`
  }

  const attrs = buildAttributes(type, props)
  if (VOID_TAGS.has(type)) return `<${type}${attrs}>`
  const rawHtml = props && props.dangerouslySetInnerHTML && typeof props.dangerouslySetInnerHTML.__html === 'string'
    ? props.dangerouslySetInnerHTML.__html
    : null
  const inner = rawHtml !== null
    ? rawHtml
    : children.map((child) => serializeNode(child, options)).join('')
  return `<${type}${attrs}>${inner}</${type}>`
}

function pickChildren(node) {
  const positional = Array.isArray(node.children) ? node.children : []
  const fromProps = node.props && node.props.children !== undefined ? node.props.children : undefined
  const source = positional.length > 0 ? positional : fromProps === undefined ? [] : [fromProps]
  const flat = []
  for (const item of source) {
    if (Array.isArray(item)) flat.push(...item)
    else flat.push(item)
  }
  return flat
}

function mountNode(node, hooks, depth = 0, path = '0') {
  if (depth > 200) fail('组件树递归超过 200 层，疑似存在渲染死循环。')
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    const children = []
    for (let index = 0; index < node.length; index += 1) {
      const mounted = mountNode(node[index], hooks, depth + 1, `${path}/a${index}`)
      if (mounted) children.push(mounted)
    }
    return { fragment: true, children }
  }
  if (typeof node !== 'object' || node.type === undefined) {
    fail(`无法渲染的节点：${JSON.stringify(node)}`)
  }

  const { type } = node
  const props = node.props || {}

  if (typeof type === 'function') {
    if (type.__previewContext && type.__previewContext._stack) {
      const context = type.__previewContext
      context._stack.push(props.value)
      try {
        return mountNode(type(props), hooks, depth + 1, `${path}/ctx`)
      } finally {
        context._stack.pop()
      }
    }
    if (type.__previewContext && type.__previewContext._stack === undefined) {
      return mountNode(type(props), hooks, depth + 1, `${path}/ctx`)
    }

    const key = `${path}|${type.name || 'anonymous'}`
    let output
    if (type.prototype && typeof type.prototype.render === 'function') {
      let instance = hooks.instanceMap.get(key)
      if (!instance) {
        instance = new type(props)
        hooks.instanceMap.set(key, instance)
      }
      instance.props = props
      output = instance.render()
      if (typeof instance.componentDidMount === 'function') {
        // 用 effect 队列在本次渲染后执行，避免在 render 里做副作用
        output = output
        hooks.pendingLifecycle = hooks.pendingLifecycle || []
        hooks.pendingLifecycle.push(() => instance.componentDidMount())
      }
    } else {
      hooks.enter(key)
      try {
        output = type(props)
      } finally {
        hooks.leave()
      }
    }
    return mountNode(output, hooks, depth + 1, `${key}/r`)
  }

  if (type === 'fragment') {
    const kids = pickChildren(node)
    const children = []
    for (let index = 0; index < kids.length; index += 1) {
      const mounted = mountNode(kids[index], hooks, depth + 1, `${path}/f${index}`)
      if (mounted) children.push(mounted)
    }
    return { fragment: true, children }
  }

  const kids = pickChildren(node)
  const children = []
  for (let index = 0; index < kids.length; index += 1) {
    const mounted = mountNode(kids[index], hooks, depth + 1, `${path}/h${index}`)
    if (mounted) children.push(mounted)
  }
  return { type, props, children }
}

// #endregion

// #region 旧 bundle 的演示 ctx（createHost 需要）

const DEMO_ROLES = SEATS.map((seat) => seat.roleId)
const DEMO_LABELS = Object.fromEntries(SEATS.map((seat) => [seat.roleId, seat.name]))
const DEMO_RUNNING = new Set(['shangshu', 'hubu', 'gongbu'])
const DEMO_STATUS_TEXT =
  'Chrome、Edge 和内置 Node 都可用。我把「真实组件预览生成器」交给队友做，现在已经能出图了。'
const DEMO_NODES = new Map([
  ['demo-1', { kind: 'assistant', anchorSeq: 1, data: { blocks: [{ kind: 'text', text: DEMO_STATUS_TEXT }] } }],
])

function createDemoContext() {
  const members = DEMO_ROLES.map((role) => ({ id: `sess-${role}`, name: role, phase: 'active' }))
  const tasks = [
    { id: 'task-1', subject: '拆解 0.5.1 侧栏验收清单', status: 'in_progress', ownerName: 'zhongshu' },
    { id: 'task-2', subject: '复算朝堂统计投影', status: 'in_progress', ownerName: 'hubu' },
    { id: 'task-3', subject: '补齐右侧栏窄宽度回归', status: 'pending', ownerName: 'xingbu' },
    { id: 'task-4', subject: '整理 @ 部门入口说明', status: 'pending', ownerName: 'lipu' },
    { id: 'task-5', subject: '删除未渲染的旧样式', status: 'completed', ownerName: 'gongbu' },
    { id: 'task-6', subject: '核对十席角色文案', status: 'completed', ownerName: 'libu' },
  ]

  const byId = {}
  const ids = []
  for (const role of DEMO_ROLES) {
    const id = `sess-${role}`
    ids.push(id)
    byId[id] = {
      id,
      name: DEMO_LABELS[role],
      updatedAt: 1_760_000_000_000 + DEMO_ROLES.indexOf(role),
      running: DEMO_RUNNING.has(role),
      workspaceId: 'demo-workspace',
    }
  }
  byId[LEAD_SESSION] = { ...byId[LEAD_SESSION], subagent: undefined }

  const team = { members, tasks }
  const sessionList = {
    getSnapshot: () => ({
      ids: ids.slice(),
      byId,
      projectionsBySession: {
        [LEAD_SESSION]: {
          sessionId: LEAD_SESSION,
          values: {
            agentTeam: team,
            agentPreset: 'sansheng-liubu',
            subagentCatalog: [],
          },
        },
      },
      phase: 'ready',
    }),
    subscribe: () => () => {},
  }

  const statuses = new Map()
  for (const role of DEMO_ROLES) {
    statuses.set(`sess-${role}`, { running: DEMO_RUNNING.has(role) })
  }
  const statusStore = {
    getSnapshot: () => statuses,
    subscribe: () => () => {},
  }

  const catalogSnapshot = {
    status: 'ready',
    error: null,
    current: { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' },
    default: { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' },
    groups: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          {
            id: 'gpt-6-astra',
            name: 'GPT-6 Astra',
            reasoning: {
              defaultEffort: 'high',
              efforts: [
                { id: 'low', name: '低' },
                { id: 'medium', name: '中' },
                { id: 'high', name: '高' },
              ],
            },
          },
          {
            id: 'gpt-6-mini',
            name: 'GPT-6 Mini',
            reasoning: {
              defaultEffort: 'medium',
              efforts: [
                { id: 'low', name: '低' },
                { id: 'medium', name: '中' },
              ],
            },
          },
        ],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-v4',
            name: 'DeepSeek V4',
            reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: '高' }] },
          },
        ],
      },
    ],
  }

  const binding = {
    session: {
      projections: {
        faceOf: () => ({ getSnapshot: () => ({ model: { name: 'GPT-6 Astra' } }) }),
      },
      prompt: async () => ({ ok: true }),
    },
  }

  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sessions: {
      list: sessionList,
      statuses: statusStore,
      binding: () => binding,
      subagentAddress: (sessionId) => (sessionId === LEAD_SESSION ? undefined : { parentSessionId: LEAD_SESSION, childSessionId: sessionId }),
      refreshProjections: async () => {},
    },
    uiWorkspace: {
      selection: {
        getSnapshot: () => ({ sessionId: LEAD_SESSION }),
        subscribe: () => () => {},
        set: () => {},
      },
      currentWorkspaceId: 'demo-workspace',
      openSession: () => {},
      startSession: () => {},
    },
    uiConversation: {
      binding: () => ({
        target: () => ({ getSnapshot: () => ({ nodes: DEMO_NODES }) }),
      }),
    },
    modelDirectories: {
      catalog: {
        load: async () => ({
          default: catalogSnapshot.current,
          groups: catalogSnapshot.groups,
          failures: [],
        }),
        store: { getSnapshot: () => ({ value: catalogSnapshot, status: 'ready', error: null }) },
      },
      directoryFor: () => ({
        load: () => Promise.resolve(),
        select: () => Promise.resolve({ ok: true }),
        store: {
          getSnapshot: () => catalogSnapshot,
          subscribe: () => () => {},
        },
      }),
    },
    remote: {
      agentPresets: {
        list: async () => ({ ok: true, value: { presets: [] } }),
        select: async () => ({ ok: true }),
      },
      session: {
        selectModel: async () => ({ ok: true }),
      },
      commands: {
        execute: async (_agentId, line) => ({ commandId: 'preview-command', result: { kind: 'success', text: line } }),
      },
      subagents: {
        prompt: async () => ({ messageId: 'preview-msg' }),
      },
    },
    get: () => undefined,
    layout: { selectPanel: () => {} },
    sidebarRight: { openTab: () => {}, openTabIn: () => {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: { register: () => () => {}, inject: (name, callback) => callback() },
  }

  return { ctx, team, catalogSnapshot }
}

// #endregion

// #region 选择要渲染的组件

/* #region 真实 Host 模式（--live）
   与打桩模式共用同一套 vm/hooks/序列化/截图；区别只在于 fetch：
   这里把 bundle 的 fetch 桥到 workbench/host 真正注册的路由，账本用内存 store，
   绝不碰 %USERPROFILE%\.dsh\sansheng-liubu\workbench.json。 */

function createLiveSessionController(onPrompt) {
  let next = 1
  const sessions = new Map()
  const calls = { create: [], prompt: [], inspect: [], selectModel: [], cancel: [] }
  const controller = {
    calls,
    sessions,
    async create(request = {}) {
      calls.create.push(request)
      const existing = [...sessions.values()].find(
        (row) => row.workspaceId === (request.workspaceId ?? null) && request.sessionId === undefined,
      )
      if (existing !== undefined) return { sessionId: existing.sessionId, agentPreset: existing.agentPreset ?? null }
      const sessionId = request.sessionId ?? `sess_live_${next++}`
      sessions.set(sessionId, {
        sessionId,
        workspaceId: request.workspaceId ?? null,
        agentPreset: request.agentPreset ?? null,
        running: false,
        accepted: new Set(),
      })
      return { sessionId, agentPreset: request.agentPreset ?? null }
    },
    async inspect(sessionId) {
      calls.inspect.push(sessionId)
      const row = sessions.get(sessionId)
      if (row === undefined) throw Object.assign(new Error('not found'), { code: 'session/not-found' })
      return { sessionId, attached: true }
    },
    async prompt(request) {
      calls.prompt.push(request)
      const row = sessions.get(request.sessionId)
      if (row === undefined) throw Object.assign(new Error('no session'), { code: 'session/conflict' })
      const text = request?.content?.[0]?.text ?? ''
      if (typeof onPrompt === 'function') onPrompt({ sessionId: request.sessionId, requestId: request.requestId, text })
      if (row.accepted.has(request.requestId)) return { accepted: true }
      row.accepted.add(request.requestId)
      row.running = true
      return { accepted: true }
    },
    cancel(request) {
      calls.cancel.push(request)
      const row = sessions.get(request?.sessionId)
      if (row !== undefined) row.running = false
      return { accepted: true }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      return { selected: { provider: request?.provider ?? null, model: request?.model ?? null } }
    },
    async list() {
      return {
        items: [...sessions.values()].map((row) => ({
          sessionId: row.sessionId,
          running: row.running,
          agentAvailable: true,
          updatedAt: '',
          blank: false,
        })),
      }
    },
  }
  return controller
}

/** 把标准 fetch 调用桥到 workbench/host 注册的 route handler。 */
function createLiveFetch(handlers, live) {
  return async function liveFetch(input, init = {}) {
    const raw = typeof input === 'string'
      ? input
      : input && typeof input.url === 'string'
        ? input.url
        : String(input)
    const url = new URL(raw, 'http://preview.local')
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    const path = url.pathname
    const handler = handlers.get(path)
    const bodyText = init && init.body !== undefined && init.body !== null
      ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body))
      : ''

    if (typeof handler !== 'function') {
      const entry = { method, path, query: url.search, status: 404, note: '未注册路由' }
      live.requests.push(entry)
      log(`[live] ${method} ${path} → 404（未注册路由）`)
      return makeResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: `未注册路由：${path}` } })
    }

    const req = {
      method,
      url: `${path}${url.search}`,
      headers: Object.assign({}, init && init.headers),
      async *[Symbol.asyncIterator]() {
        if (bodyText !== '') yield Buffer.from(bodyText, 'utf8')
      },
    }
    const headers = {}
    let body = ''
    const res = {
      statusCode: 200,
      headers,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value },
      getHeader(name) { return headers[String(name).toLowerCase()] },
      writeHead(status, extra) {
        this.statusCode = status
        if (extra && typeof extra === 'object') {
          for (const [key, value] of Object.entries(extra)) headers[String(key).toLowerCase()] = value
        }
        this.headersSent = true
        return this
      },
      write(chunk) { body += chunk === undefined ? '' : String(chunk); return true },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) body += String(chunk)
        this.writableEnded = true
      },
      on() {}, once() {}, off() {}, emit() {}, removeListener() {},
    }

    let failure = null
    try {
      await handler(req, res)
    } catch (error) {
      failure = error
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'LIVE_BRIDGE_CRASH', message: String(error?.message ?? error) } }))
      }
    }

    let payload = {}
    try { payload = body === '' ? {} : JSON.parse(body) } catch { payload = { raw: body } }
    const entry = { method, path, query: url.search, status: res.statusCode }
    live.requests.push(entry)
    log(`[live] ${method} ${path}${url.search} → ${res.statusCode}`)
    if (failure) log(`[live] handler 抛错：${failure?.stack ?? failure}`)

    if (path.endsWith('/dispatch')) {
      const record = payload && payload.value ? payload.value.dispatch : null
      live.dispatches.push({
        status: record ? (record.status || record.state || null) : null,
        httpStatus: res.statusCode,
        payload,
      })
      log(`[live] dispatch.status=${record ? (record.status || record.state) : '(无)'}`)
    }
    if (path.endsWith('/task/cancel')) {
      live.cancellations.push({ httpStatus: res.statusCode, payload })
      log(`[live] cancel.status=${payload?.value?.task?.status ?? '(无)'}`)
    }
    if (path.endsWith('/artifact/revision')) {
      live.revisions.push({ httpStatus: res.statusCode, payload })
      log(`[live] revision.task.kind=${payload?.value?.task?.kind ?? '(无)'}`)
    }

    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      statusText: res.statusCode === 200 ? 'OK' : 'Error',
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => JSON.parse(JSON.stringify(payload)),
      text: async () => body,
    }
  }
}

async function setupLiveHost() {
  const hostModule = await import(pathToFileURL(join(ROOT, 'workbench/host/index.mjs')).href)
  const storeModule = await import(pathToFileURL(join(ROOT, 'workbench/core/store.mjs')).href)
  const clock = () => Date.now()
  const store = new storeModule.WorkbenchStore({
    file: null,
    clock,
    env: { DSH_HOME: join(SCRATCH, 'live-home') },
  })
  const live = {
    requests: [],
    dispatches: [],
    cancellations: [],
    revisions: [],
    prompts: [],
    projectId: null,
    controller: null,
  }
  const controller = createLiveSessionController((entry) => {
    live.prompts.push(entry)
    log(`[live] 伪 sessionController 收到 prompt（${entry.text.length} 字符）：${entry.text.slice(0, 80).replace(/\\s+/g, ' ')}…`)
  })
  live.controller = controller

  const handlers = new Map()
  const webServer = {
    register(registration = {}) {
      const path = registration.path
      if (typeof path !== 'string' || typeof registration.handler !== 'function') {
        throw new Error('webServer.register 需要 path 与 handler')
      }
      handlers.set(path, registration.handler)
      return () => { handlers.delete(path) }
    },
  }

  const ctx = {
    webServer,
    // 故意先不给 sessionController：让 Host 走 ctx.inject(['sessionController']) 的晚挂路径。
    inject(deps, callback) {
      const scoped = { webServer, sessionController: controller }
      try {
        callback(scoped)
      } catch (error) {
        log(`[live] ctx.inject 回调失败：${error?.message ?? error}`)
      }
      return () => {}
    },
    uiWorkspace: {
      currentWorkspaceId: 'ws_demo',
      openSession(sessionId) { log(`[live] openSession(${sessionId})（替身，仅记录）`) },
      selection: {
        getSnapshot: () => ({ workspaceId: 'ws_demo' }),
        set(value) { log(`[live] uiWorkspace.selection.set(${JSON.stringify(value)})`) },
      },
    },
  }

  const host = hostModule.createWorkbenchHost(ctx, {
    store,
    clock,
    load: false,
    startReconciler: false,
    longPollMs: 0,
    pollIntervalMs: 10,
    log: (message) => log(`[host] ${message}`),
  })
  if (host.registered === false) fail(`真实 Host 路由未注册：${host.warning || '未知原因'}`)
  if (host.hasSessions !== true) fail('真实 Host 没有挂上伪 sessionController（inject 晚挂失败）')

  live.host = host
  live.routes = host.routes
  live.fetchLive = createLiveFetch(handlers, live)
  log(`[live] Host 就绪：账本 file=${String(store.file)}，路由 ${host.routes.paths?.length ?? handlers.size} 条，hasSessions=${host.hasSessions}`)
  return live
}

async function registerLiveProject(live) {
  const response = await live.fetchLive(`${ROUTE_PREFIX}/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hostWorkspaceId: 'ws_demo',
      displayNameCache: '演示项目',
      canonicalRoot: 'C:\\\\demo',
    }),
  })
  const payload = await response.json()
  const project = payload && payload.value && payload.value.project
  if (!response.ok || !project || typeof project.id !== 'string') {
    fail(`通过真实 POST /project 注册项目失败（HTTP ${response.status}）：${JSON.stringify(payload)}`)
  }
  live.projectId = project.id
  log(`[live] 已通过真实 /project 注册项目：${project.id}`)
  return project.id
}

function createLiveUiContext() {
  return {
    uiWorkspace: {
      currentWorkspaceId: 'ws_demo',
      openSession(sessionId) { log(`[live] bundle 请求打开会话 ${sessionId}`) },
      selection: {
        getSnapshot: () => ({ workspaceId: 'ws_demo' }),
        set(value) { log(`[live] selection.set(${JSON.stringify(value)})`) },
      },
    },
  }
}

function findAllMounted(node, predicate, out = []) {
  if (!node) return out
  if (predicate(node)) out.push(node)
  if (node.fragment) {
    for (const child of node.children) findAllMounted(child, predicate, out)
  } else if (Array.isArray(node.children)) {
    for (const child of node.children) findAllMounted(child, predicate, out)
  }
  return out
}

function textOf(node) {
  return mountedText(node).replace(/\\s+/g, ' ').trim()
}

function findClass(node, className) {
  return findMounted(node, (child) => classNameOf(child).includes(className))
}

function findSeatCard(tree, roleName) {
  return findMounted(tree, (node) => {
    if (!classNameOf(node).includes('wb-card')) return false
    const text = textOf(node)
    return text.includes(roleName)
  })
}

function findClickableByText(node, needle) {
  return findMounted(node, (child) => {
    if (child.type !== 'button') return false
    return textOf(child).includes(needle)
  })
}

async function liveSettle(hooks, rootVNode, label) {
  const result = await settle(hooks, rootVNode, 4000)
  log(`[live] ${label}：${result.settled ? '稳定' : '未稳定'}，${result.passes} 轮，${result.elapsedMs}ms`)
  return result.tree
}

async function liveWait(hooks, rootVNode, predicate, label, budgetMs = 4000) {
  const started = Date.now()
  let tree = null
  let passes = 0
  while (Date.now() - started < budgetMs) {
    const result = await settle(hooks, rootVNode, 1000)
    tree = result.tree
    passes += result.passes
    if (predicate(tree)) {
      log(`[live] ${label}：满足（${Date.now() - started}ms，${passes} 轮）`)
      return { tree, passes, ok: true }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 30))
  }
  log(`[live] ${label}：超时未满足（${budgetMs}ms）`)
  return { tree, passes, ok: false }
}

async function connectSeatLive(hooks, rootVNode, tree, roleName) {
  const card = findSeatCard(tree, roleName)
  if (!card) fail(`[live] 在朝堂里找不到「${roleName}」卡片`)
  const before = textOf(card)
  const button = findMounted(card, (node) => classNameOf(node).includes('wb-connect'))
  if (!button) fail(`[live]「${roleName}」卡片没有「接通」按钮：${before}`)
  log(`[live] 点击「${roleName} · 接通」；点击前：${before}`)
  if (!clickMounted(button)) fail(`[live]「${roleName} · 接通」的 onClick 不可调用`)
  const waited = await liveWait(
    hooks,
    rootVNode,
    (nextTree) => {
      const nextCard = findSeatCard(nextTree, roleName)
      return Boolean(nextCard) && !textOf(nextCard).includes('未接通') && !classNameOf(nextCard).includes('is-pending')
    },
    `等待「${roleName}」接通`,
  )
  const afterCard = findSeatCard(waited.tree, roleName)
  const after = afterCard ? textOf(afterCard) : '(卡片消失)'
  log(`[live]「${roleName}」点击后：${after}`)
  return { tree: waited.tree, before, after, ok: waited.ok, passes: waited.passes }
}

async function openTaskFormLive(hooks, rootVNode, tree) {
  const newButton = findClickableByText(tree, '新建')
  if (!newButton) fail('[live] 任务页找不到「新建」按钮')
  clickMounted(newButton)
  const opened = await liveWait(hooks, rootVNode, (next) => Boolean(findClass(next, 'wb-form')), '等待任务表单展开')
  if (!opened.ok) fail('[live] 点击「新建」后表单没有出现')
  return opened.tree
}

async function setFormFieldLive(hooks, rootVNode, tree, className, value) {
  const form = findClass(tree, 'wb-form')
  if (!form) fail(`[live] 找不到任务表单（设置 ${className} 时）`)
  const field = findClass(form, className)
  if (!field || !field.props || typeof field.props.onChange !== 'function') {
    fail(`[live] 任务表单里找不到可输入的 .${className}`)
  }
  field.props.onChange({ target: { value }, currentTarget: { value } })
  return liveSettle(hooks, rootVNode, `填写 ${className}=${value}`)
}

async function submitTaskFormLive(hooks, rootVNode, tree) {
  const form = findClass(tree, 'wb-form')
  if (!form || !form.props || typeof form.props.onSubmit !== 'function') fail('[live] 任务表单没有 onSubmit')
  form.props.onSubmit({ preventDefault() {}, target: {}, currentTarget: {} })
  return liveSettle(hooks, rootVNode, '提交任务草稿')
}

async function dispatchTaskLive(hooks, rootVNode, tree, title) {
  const taskCard = findMounted(tree, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
  if (!taskCard) fail(`[live] 任务列表里找不到「${title}」`)
  const before = textOf(taskCard)
  const button = findClickableByText(taskCard, '派工')
  if (!button) fail(`[live]「${title}」没有「派工」按钮：${before}`)
  log(`[live] 点击「派工」；点击前：${before}`)
  clickMounted(button)
  const waited = await liveWait(
    hooks,
    rootVNode,
    (next) => {
      const card = findMounted(next, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
      const text = card ? textOf(card) : ''
      return Boolean(card) && !text.includes('排队') && !text.includes('草稿') && (text.includes('执行中') || text.includes('正在运行'))
    },
    '等待任务进入运行态',
  )
  const afterCard = findMounted(waited.tree, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
  const after = afterCard ? textOf(afterCard) : '(任务消失)'
  log(`[live]「派工」后：${after}`)
  return { tree: waited.tree, before, after, ok: waited.ok, passes: waited.passes }
}

async function createDraftTaskThroughFormLive(hooks, rootVNode, tree, title, objective) {
  let next = await openTaskFormLive(hooks, rootVNode, tree)
  let passes = 0
  for (const [className, value] of [
    ['wb-input', title],
    ['wb-textarea', objective],
    ['wb-select', 'gongbu'],
  ]) {
    next = await setFormFieldLive(hooks, rootVNode, next, className, value)
    passes += 1
  }
  next = await submitTaskFormLive(hooks, rootVNode, next)
  const drafted = await liveWait(
    hooks,
    rootVNode,
    (candidate) => Boolean(findMounted(candidate, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))),
    '等待草稿任务出现在列表',
  )
  if (!drafted.ok) fail(`[live] 表单提交后任务列表没有出现「${title}」`)
  next = drafted.tree
  passes += drafted.passes
  log(`[live] 表单已存为草稿：${title}`)
  return { tree: next, passes }
}

async function cancelTaskLive(hooks, rootVNode, tree, title) {
  const taskCard = findMounted(tree, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
  if (!taskCard) fail(`[live] 任务列表里找不到「${title}」`)
  const before = textOf(taskCard)
  const button = findClickableByText(taskCard, '取消')
  if (!button) fail(`[live]「${title}」没有「取消」按钮：${before}`)
  log(`[live] 点击「取消」；点击前：${before}`)
  clickMounted(button)
  const waited = await liveWait(
    hooks,
    rootVNode,
    (next) => {
      const card = findMounted(next, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
      if (!card) return false
      const text = textOf(card)
      return text.includes('已取消') && !findClickableByText(card, '取消')
    },
    '等待任务变成已取消且取消按钮消失',
  )
  const afterCard = findMounted(waited.tree, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes(title))
  const after = afterCard ? textOf(afterCard) : '(任务消失)'
  log(`[live]「取消」后：${after}`)
  return { tree: waited.tree, before, after, ok: waited.ok, passes: waited.passes }
}

async function openArtifactLive(hooks, rootVNode, tree, name) {
  const row = findMounted(tree, (node) => classNameOf(node).includes('wb-artifact') && textOf(node).includes(name))
  if (!row) fail(`[live] 成果列表里找不到「${name}」`)
  const before = textOf(row)
  const className = classNameOf(row)
  clickMounted(row)
  const opened = await liveWait(hooks, rootVNode, (next) => Boolean(findClass(next, 'wb-drawer')), '等待成果详情抽屉')
  if (!opened.ok) fail('[live] 点击成果行后详情抽屉没有出现')
  log(`[live] 已打开成果「${name}」；行 class="${className}"`)
  return { tree: opened.tree, before, className, passes: opened.passes }
}

async function openRevisionFormLive(hooks, rootVNode, tree) {
  const drawer = findClass(tree, 'wb-drawer')
  if (!drawer) fail('[live] 成果抽屉不存在')
  const button = findClickableByText(drawer, '找主责部门修改')
  if (!button) fail('[live] 成果抽屉里没有「找主责部门修改」')
  clickMounted(button)
  const opened = await liveWait(
    hooks,
    rootVNode,
    (next) => Boolean(findClass(findClass(next, 'wb-drawer'), 'wb-form')),
    '等待修订表单展开',
  )
  if (!opened.ok) fail('[live] 点击「找主责部门修改」后表单没有出现')
  return { tree: opened.tree, passes: opened.passes }
}

async function submitRevisionLive(hooks, rootVNode, tree, instruction) {
  const field = findClass(findClass(tree, 'wb-drawer'), 'wb-textarea')
  if (!field || !field.props || typeof field.props.onChange !== 'function') fail('[live] 修订表单里没有可输入的 textarea')
  field.props.onChange({ target: { value: instruction }, currentTarget: { value: instruction } })
  let next = await liveSettle(hooks, rootVNode, '填写修订说明')
  const form = findClass(findClass(next, 'wb-drawer'), 'wb-form')
  if (!form || !form.props || typeof form.props.onSubmit !== 'function') fail('[live] 修订表单没有 onSubmit')
  log('[live] 点击「存为草稿」提交修订')
  form.props.onSubmit({ preventDefault() {}, target: {}, currentTarget: {} })
  const waited = await liveWait(
    hooks,
    rootVNode,
    (candidate) => Boolean(findMounted(candidate, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes('修订'))),
    '等待修订任务出现在任务页',
  )
  next = waited.tree
  log(`[live] 修订后任务页可见：${Boolean(findMounted(next, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes('修订')))}`)
  return { tree: next, ok: waited.ok, passes: waited.passes + 1 }
}

async function postLiveJson(live, path, body) {
  const response = await live.fetchLive(`${ROUTE_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok || !payload?.ok) {
    fail(`[live] POST ${path} 失败：HTTP ${response.status} ${JSON.stringify(payload)}`)
  }
  return { response, payload }
}

async function prepareLiveScenario(live, scenario) {
  if (scenario !== 'revise' && scenario !== 'missing') return
  log(`[live] 准备 ${scenario} 场景：真实 POST /connect + POST /task，成果走 service.registerArtifact`)
  await postLiveJson(live, '/connect', { projectId: live.projectId, roleId: 'gongbu' })
  const created = await postLiveJson(live, '/task', {
    projectId: live.projectId,
    title: scenario === 'revise' ? '修订载体任务' : '失效载体任务',
    objective: '为成果页场景准备一条真实任务。',
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    status: 'draft',
  })
  const task = created.payload.value && created.payload.value.task
  if (!task || typeof task.id !== 'string') fail('[live] /task 没有返回 task.id')
  const artifactInput = scenario === 'missing'
    ? {
      projectId: live.projectId,
      taskId: task.id,
      ownerRoleId: 'gongbu',
      fileRef: join(SCRATCH, 'live-missing', '不存在的验收单.pdf'),
      displayName: '已失效验收单.pdf',
      mediaType: 'application/pdf',
      verification: { status: 'verified' },
    }
    : {
      projectId: live.projectId,
      taskId: task.id,
      ownerRoleId: 'gongbu',
      fileRef: join(ROOT, 'docs/preview/v01-live-court-400-light.png'),
      displayName: '待修订预览截图.png',
      mediaType: 'image/png',
      verification: { status: 'verified' },
    }
  // 仓库没有 POST /artifact 端点（routes.mjs 只有 /artifact/revision），
  // 所以按 Lead 允许的方式直接调 service.registerArtifact；这条不是 HTTP。
  const registered = live.host.service.registerArtifact(artifactInput)
  log(`[live] 直接调用 service.registerArtifact（非 HTTP）：${registered.artifact.id}，existence=${registered.artifact.existence}`)
  live.preparedArtifact = registered.artifact
}

async function runLiveScenario({ hooks, rootVNode, view, live, projectId, scenario }) {
  let tree = await liveSettle(hooks, rootVNode, '首屏 bootstrap')
  const assertions = []
  let passes = 0

  if (scenario === 'court') {
    const connected = await connectSeatLive(hooks, rootVNode, tree, '丞相')
    tree = connected.tree
    passes += connected.passes
    assertions.push({
      name: '丞相接通后从「未接通」变「空闲」',
      ok: connected.ok && connected.after.includes('空闲'),
      before: connected.before,
      after: connected.after,
    })
    const courtNotice = findMounted(connected.tree, (node) => classNameOf(node).includes('wb-alert'))
    const courtNoticeClass = courtNotice ? classNameOf(courtNotice) : ''
    const courtNoticeText = courtNotice ? textOf(courtNotice) : ''
    log(`[live] 接通提示：class="${courtNoticeClass}" text="${courtNoticeText}"`)
    assertions.push({
      name: '接通成功提示为绿色信息条（is-info）',
      ok: courtNoticeClass.includes('is-info') && courtNoticeText.includes('已接通'),
      before: '(无)',
      after: courtNoticeText,
    })
  } else if (scenario === 'tasks' || scenario === 'cancel') {
    const connected = await connectSeatLive(hooks, rootVNode, tree, '工部')
    tree = connected.tree
    passes += connected.passes
    assertions.push({
      name: '工部接通',
      ok: connected.ok,
      before: connected.before,
      after: connected.after,
    })

    const switched = await switchPreviewState(hooks, rootVNode, 'tasks', '', tree)
    tree = switched.tree
    passes += switched.passes
    log(`[live] 已切到任务页：${switched.clickedTab || '(未切换)'}`)

    const title = '实机验证：预览器直连 Host'
    const objective = '确认 --live 模式能把任务单真正送进工部会话。'
    // 真实路径：新建 → 存为草稿 → 任务行点「派工」，不经过 queued 接口。
    const drafted = await createDraftTaskThroughFormLive(hooks, rootVNode, tree, title, objective)
    tree = drafted.tree
    passes += drafted.passes

    const dispatched = await dispatchTaskLive(hooks, rootVNode, tree, title)
    const dispatchRecord = live.dispatches.length > 0 ? live.dispatches[live.dispatches.length - 1] : null
    if (dispatchRecord) {
      log(`[live] /dispatch 返回：HTTP ${dispatchRecord.httpStatus} ${JSON.stringify(dispatchRecord.payload)}`)
    }
    tree = dispatched.tree
    passes += dispatched.passes
    assertions.push({
      name: '派工后任务离开排队态、进入执行中',
      ok: dispatched.ok && !dispatched.after.includes('排队') && !dispatched.after.includes('草稿')
        && (dispatched.after.includes('执行中') || dispatched.after.includes('正在运行')),
      before: dispatched.before,
      after: dispatched.after,
    })
    const noticeNode = findMounted(dispatched.tree, (node) => classNameOf(node).includes('wb-alert'))
    const noticeClass = noticeNode ? classNameOf(noticeNode) : ''
    const noticeText = noticeNode ? textOf(noticeNode) : ''
    log(`[live] 派工提示：class="${noticeClass}" text="${noticeText}"`)
    assertions.push({
      name: '派工成功提示为绿色信息条（is-info）',
      ok: noticeClass.includes('is-info') && noticeText.includes('已派出'),
      before: '(无)',
      after: noticeText,
    })

    if (scenario === 'cancel') {
      const cancelled = await cancelTaskLive(hooks, rootVNode, tree, title)
      tree = cancelled.tree
      passes += cancelled.passes
      const cancelRecord = live.cancellations.length > 0 ? live.cancellations[live.cancellations.length - 1] : null
      if (cancelRecord) {
        log(`[live] /task/cancel 返回：HTTP ${cancelRecord.httpStatus} ${JSON.stringify(cancelRecord.payload)}`)
      }
      const cancelledTask = cancelRecord?.payload?.value?.task
      assertions.push({
        name: '任务状态变为已取消且取消按钮消失',
        ok: cancelled.ok && cancelled.after.includes('已取消') && !cancelled.after.includes('派工')
          && !cancelled.after.includes('取消取消'),
        before: cancelled.before,
        after: cancelled.after,
      })
      assertions.push({
        name: 'POST /task/cancel 返回 task.status=cancelled',
        ok: cancelRecord?.httpStatus === 200 && cancelledTask?.status === 'cancelled',
        before: '(无)',
        after: `HTTP ${cancelRecord?.httpStatus ?? '(无)'} status=${cancelledTask?.status ?? '(无)'}`,
      })
    }
  } else if (scenario === 'revise') {
    const switched = await switchPreviewState(hooks, rootVNode, 'artifacts', '', tree)
    tree = switched.tree
    passes += switched.passes
    log(`[live] 已切到成果页：${switched.clickedTab || '(未切换)'}`)

    const name = live.preparedArtifact?.displayName
    if (!name) fail('[live] revise 场景没有准备好的成果')
    const opened = await openArtifactLive(hooks, rootVNode, tree, name)
    tree = opened.tree
    passes += opened.passes

    const reviseOpened = await openRevisionFormLive(hooks, rootVNode, tree)
    tree = reviseOpened.tree
    passes += reviseOpened.passes

    const submitted = await submitRevisionLive(
      hooks,
      rootVNode,
      tree,
      '请把标题改得更清楚，并补一张 800px 宽的截图。',
    )
    tree = submitted.tree
    passes += submitted.passes

    const revisionRecord = live.revisions.length > 0 ? live.revisions[live.revisions.length - 1] : null
    const revisionTask = revisionRecord?.payload?.value?.task
    if (revisionRecord) {
      log(`[live] /artifact/revision 返回：HTTP ${revisionRecord.httpStatus} ${JSON.stringify(revisionRecord.payload)}`)
    }
    assertions.push({
      name: 'POST /artifact/revision 返回 200 且任务是 artifact-revision',
      ok: revisionRecord?.httpStatus === 200
        && revisionTask?.kind === 'revision'
        && revisionTask?.scope?.kind === 'artifact-revision',
      before: '(无)',
      after: `HTTP ${revisionRecord?.httpStatus ?? '(无)'} kind=${revisionTask?.kind ?? '(无)'} scope=${revisionTask?.scope?.kind ?? '(无)'}`,
    })
    const revisionRow = findMounted(submitted.tree, (node) => classNameOf(node).includes('wb-task') && textOf(node).includes('修订'))
    assertions.push({
      name: '任务页出现带「修订」标签的新任务行',
      ok: Boolean(revisionRow) && submitted.ok,
      before: '(无)',
      after: revisionRow ? textOf(revisionRow) : '(未找到)',
    })
  } else if (scenario === 'missing') {
    const switched = await switchPreviewState(hooks, rootVNode, 'artifacts', '', tree)
    tree = switched.tree
    passes += switched.passes
    log(`[live] 已切到成果页：${switched.clickedTab || '(未切换)'}`)

    const name = live.preparedArtifact?.displayName
    if (!name) fail('[live] missing 场景没有准备好的成果')
    const row = findMounted(tree, (node) => classNameOf(node).includes('wb-artifact') && textOf(node).includes(name))
    const rowClass = row ? classNameOf(row) : ''
    const rowText = row ? textOf(row) : ''
    log(`[live] 失效成果行：class="${rowClass}" text="${rowText}"`)
    assertions.push({
      name: '缺失文件显示虚线淡红卡（is-missing）',
      ok: Boolean(row) && rowClass.includes('is-missing'),
      before: '(无)',
      after: rowClass,
    })
    assertions.push({
      name: '缺失文件行显示「· 文件已失效」',
      ok: Boolean(row) && rowText.includes('文件已失效'),
      before: '(无)',
      after: rowText,
    })
  } else {
    fail(`--live 未知场景：${scenario}`)
  }

  const dispatch = live.dispatches.length > 0 ? live.dispatches[live.dispatches.length - 1] : null
  return {
    tree,
    passes,
    assertions,
    requests: live.requests,
    dispatches: live.dispatches,
    cancellations: live.cancellations,
    revisions: live.revisions,
    preparedArtifact: live.preparedArtifact ?? null,
    dispatchStatus: dispatch ? dispatch.status : null,
    prompts: live.prompts,
    projectId,
    controllerCalls: live.controller.calls,
  }
}

/* #endregion */

function pickComponent(exports) {
  const keys = Object.keys(exports || {})
  const preview = exports && exports.__preview
  if (preview) {
    if (typeof preview === 'function') {
      return { component: preview, props: {}, mode: '__preview(function)' }
    }
    if (typeof preview === 'object') {
      const component = preview.component || preview.default || preview.render
      if (typeof component === 'function') {
        return { component, props: preview.props || {}, mode: '__preview(object)' }
      }
    }
  }

  const preferred = [
    'SanshengWorkbenchPanel',
    'WorkbenchPanel',
    'SanshengPanel',
    'Workbench',
    'Panel',
    'default',
  ]
  for (const name of preferred) {
    const value = exports && exports[name]
    if (typeof value === 'function') {
      return { component: value, props: {}, mode: `exports.${name}` }
    }
  }

  // 兜底：任何名字里带 panel/workbench 的函数组件
  for (const name of keys) {
    const value = exports[name]
    if (typeof value === 'function' && /panel|workbench/i.test(name) && !/^create/.test(name)) {
      return { component: value, props: {}, mode: `exports.${name}(name-match)` }
    }
  }

  return { component: null, props: {}, mode: 'placeholder', keys }
}

// #endregion

// #region 渲染流程

async function tick(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
}

function flushLifecycle(hooks) {
  const queue = hooks.pendingLifecycle || []
  hooks.pendingLifecycle = []
  for (const callback of queue) callback()
}

async function settle(hooks, rootVNode, budgetMs = 1500) {
  const started = Date.now()
  let tree = null
  let passes = 0
  let settled = false
  while (passes < 80) {
    passes += 1
    hooks.beginRender()
    tree = mountNode(rootVNode, hooks, 0, 'root')
    hooks.runEffects()
    flushLifecycle(hooks)
    await tick(3)
    if (passes > 6) await new Promise((resolveWait) => setTimeout(resolveWait, 4))
    if (!hooks.consumeDirty()) {
      // 给「effect 里再排一个短定时器」的组件一点时间：最多多等一个 60ms 窗口。
      if (passes <= 3 && Date.now() - started < 400) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 60))
        if (hooks.consumeDirty()) {
          if (Date.now() - started > budgetMs) break
          continue
        }
      }
      settled = true
      break
    }
    if (Date.now() - started > budgetMs) break
  }
  return { tree, passes, settled, elapsedMs: Date.now() - started }
}

function mountedText(node) {
  if (!node) return ''
  if (node.text !== undefined) return String(node.text)
  if (node.fragment) return node.children.map(mountedText).join('')
  const parts = []
  if (node.props && typeof node.props.children === 'string') parts.push(node.props.children)
  if (Array.isArray(node.children)) parts.push(node.children.map(mountedText).join(''))
  return parts.join('')
}

function findMounted(node, predicate) {
  if (!node) return null
  if (predicate(node)) return node
  if (node.fragment) {
    for (const child of node.children) {
      const hit = findMounted(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findMounted(child, predicate)
      if (hit) return hit
    }
  }
  return null
}

function classNameOf(node) {
  const value = node && node.props ? node.props.className : ''
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

function clickMounted(node) {
  if (!node || !node.props || typeof node.props.onClick !== 'function') return false
  try {
    node.props.onClick({
      preventDefault() {},
      stopPropagation() {},
      target: {},
      currentTarget: {},
    })
    return true
  } catch (error) {
    log(`模拟点击失败：${error && error.message ? error.message : error}`)
    return false
  }
}

/* 静态 HTML 里没有 React 运行时，Chrome 里点页签不会触发组件状态。
   这里直接在替身的 vnode 上调 onClick，再重渲染一遍抓取目标页签/抽屉。 */
async function switchPreviewState(hooks, rootVNode, view, openText, initialTree) {
  const labels = { court: '朝堂', tasks: '任务', artifacts: '成果' }
  const label = labels[view]
  const result = { clickedTab: null, openedArtifact: null }
  if (!label) return { ...result, tree: initialTree, passes: 0 }
  const tab = findMounted(initialTree, (node) => {
    const classes = classNameOf(node)
    return node.type === 'button' && classes.includes('wb-tab') && mountedText(node).includes(label)
  })
  if (!tab) {
    log(`没有找到「${label}」页签，保持当前视图`)
    return { ...result, tree: initialTree, passes: 0 }
  }
  clickMounted(tab)
  let next = await settle(hooks, rootVNode, 1500)
  let extraPasses = next.passes
  result.clickedTab = label
  if (openText) {
    const artifact = findMounted(next.tree, (node) => {
      const classes = classNameOf(node)
      if (!classes.includes('wb-artifact')) return false
      const haystack = `${mountedText(node)} ${node.props && node.props.title ? node.props.title : ''}`
      return haystack.includes(openText)
    })
    if (!artifact) {
      log(`成果页里没有匹配「${openText}」的行，抽屉不打开`)
    } else if (clickMounted(artifact)) {
      result.openedArtifact = openText
      next = await settle(hooks, rootVNode, 1500)
      extraPasses += next.passes
    }
  }
  return { ...result, tree: next.tree, passes: extraPasses }
}

/* 在真实 Chrome 里按最终 DOM 的 rect 重算连线。
   React 替身环境里 getBoundingClientRect 全是 0，bundle 的 measure() 会退到
   computeRailLayout 的几何坐标；那套坐标和真实 CSS 布局（rail 内边距、
   行高、卡片实际高度）不是同一套，端点会落在卡片上方。这里在页面加载后
   用真浏览器的 rect 重写 4 条 path，公式与 bundle 的 branchPathD / trunk 完全一致：
     分叉：M cx0 y0 V mid C cx0 y1 cx1 mid cx1 y1   (mid = y0 + (y1-y0)*0.55)
     主干：M cx bottom L cx group.top
   只跑一次（成功即 done），失败留给后续 tick 重试，不挂 MutationObserver。 */
const WIRE_RECOMPUTE = `
(function () {
  var done = false;
  function r(value) { return Math.round(Number(value) * 10) / 10; }
  function rel(element, box) {
    var rect = element.getBoundingClientRect();
    return {
      top: rect.top - box.top,
      bottom: rect.bottom - box.top,
      left: rect.left - box.left,
      cx: rect.left - box.left + rect.width / 2,
      width: rect.width,
      height: rect.height
    };
  }
  function recompute() {
    if (done) return;
    var tree = document.querySelector('.wb-tree');
    if (!tree) return;
    var svg = tree.querySelector('svg.wb-wires');
    var leadEl = tree.querySelector('.wb-lead-row .wb-card');
    var trioEls = tree.querySelectorAll('.wb-trio > .wb-card');
    var groupEl = tree.querySelector('.wb-group');
    var pathEls = tree.querySelectorAll('svg.wb-wires path');
    if (!svg || !leadEl || trioEls.length < 3 || !groupEl || pathEls.length < 4) return;

    var box = tree.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;

    var lead = rel(leadEl, box);
    var sansheng = [rel(trioEls[0], box), rel(trioEls[1], box), rel(trioEls[2], box)];
    var group = rel(groupEl, box);
    var before = [];
    for (var i = 0; i < pathEls.length; i++) before.push(pathEls[i].getAttribute('d') || '');

    var y0 = lead.bottom;
    for (var j = 0; j < 3; j++) {
      var y1 = sansheng[j].top;
      if (!(y1 > y0)) return;
      var mid = y0 + (y1 - y0) * 0.55;
      pathEls[j].setAttribute('d',
        'M ' + r(lead.cx) + ' ' + r(y0) +
        ' V ' + r(mid) +
        ' C ' + r(lead.cx) + ' ' + r(y1) + ' ' + r(sansheng[j].cx) + ' ' + r(mid) +
        ' ' + r(sansheng[j].cx) + ' ' + r(y1));
    }
    if (!(group.top > sansheng[1].bottom)) return;
    pathEls[3].setAttribute('d',
      'M ' + r(sansheng[1].cx) + ' ' + r(sansheng[1].bottom) +
      ' L ' + r(sansheng[1].cx) + ' ' + r(group.top));

    svg.setAttribute('width', String(Math.round(box.width)));
    svg.setAttribute('height', String(Math.round(box.height)));

    var after = [];
    for (var k = 0; k < pathEls.length; k++) after.push(pathEls[k].getAttribute('d') || '');
    var report = {
      applied: true,
      box: { width: box.width, height: box.height },
      lead: lead,
      sansheng: sansheng,
      group: group,
      before: before,
      after: after
    };
    var marker = document.getElementById('pv-wires');
    if (!marker) {
      marker = document.createElement('script');
      marker.type = 'application/json';
      marker.id = 'pv-wires';
      document.body.appendChild(marker);
    }
    marker.textContent = JSON.stringify(report);
    document.documentElement.setAttribute('data-pv-wires', 'applied');
    done = true;
  }
  function tick() {
    try { recompute(); } catch (error) {
      document.documentElement.setAttribute('data-pv-wires', 'error:' + String(error && error.message || error));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
  requestAnimationFrame(function () { requestAnimationFrame(tick); });
  window.addEventListener('load', tick);
  setTimeout(tick, 60);
  setTimeout(tick, 250);
  setTimeout(tick, 800);
})();
`

function buildPage({ css, panelHtml, width, theme }) {
  const dark = theme === 'dark'
  const shellCss = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:#eef0f4;color:#1f2329;
  font-family:"Segoe UI","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.pv-shell{width:${width}px;min-height:100vh;display:flex;flex-direction:column;background:#f7f8fa;overflow:hidden}
.pv-chat-head{
  flex:0 0 auto;display:flex;align-items:center;gap:8px;
  padding:10px 12px;background:#ffffff;border-bottom:1px solid #e2e6ec;
  font-size:12px;line-height:18px;color:#5b6472;
}
.pv-chat-avatar{
  width:24px;height:24px;border-radius:50%;
  background:linear-gradient(135deg,#5b8def,#8a63f4);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;
}
.pv-chat-title{font-weight:600;color:#1f2329;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-chat-sub{margin-left:auto;font-size:11px;color:#8b93a1;white-space:nowrap}
.pv-panel{flex:1 1 auto;min-height:0;padding:10px 12px 16px;overflow:visible}
.pv-shell .sl-root{height:auto!important;min-height:0!important;background:transparent!important;color:inherit}
.pv-shell .sl-body{background:transparent}
.pv-shell .sl-body-sidebar{padding:0;overflow:visible}
.pv-shell .sl-body-sidebar .sl-right{overflow:visible;padding-right:0}
.pv-placeholder{
  border:1px dashed #b6bfcc;border-radius:8px;padding:12px;background:#fff;color:#1f2329;
  font-size:12px;line-height:1.5;
}
.pv-placeholder h3{margin:0 0 6px;font-size:13px}
.pv-placeholder pre{
  margin:8px 0 0;padding:8px;background:#f2f4f7;border-radius:6px;
  font-size:11px;white-space:pre-wrap;word-break:break-all;color:#475063;
}
html.dark body{background:#0e1014;color:#e8eaee}
html.dark .pv-shell{background:#111318}
html.dark .pv-chat-head{background:#16181d;border-bottom-color:#262a32;color:#a9b0bd}
html.dark .pv-chat-title{color:#e8eaee}
html.dark .pv-chat-sub{color:#7f8794}
html.dark .pv-placeholder{background:#1a1d24;border-color:#333a46;color:#e8eaee}
html.dark .pv-placeholder pre{background:#22262f;color:#c7cedb}
`

  const darkOverride = dark
    ? `
/* 兜底：bundle 若用媒体查询切暗色，--blink-settings=preferredColorScheme=0 已生效；
   若用 .dark 类名切暗色，这里保证外壳的语义变量也进入暗色。 */
html.dark{
  color-scheme:dark;
  --dsw-alias-bg-layer-1:#1f222a;
  --dsw-alias-bg-layer-2:#16181d;
  --dsw-alias-bg-layer-3:rgba(255,255,255,.10);
  --dsw-alias-label-primary:#e8eaee;
  --dsw-alias-label-secondary:#b7bcc6;
  --dsw-alias-label-tertiary:#8b93a1;
  --dsw-alias-label-caption:#7f8794;
  --dsw-alias-border-l1:rgba(255,255,255,.12);
  --dsw-alias-border-l2:rgba(255,255,255,.18);
  --dsw-alias-border-l3:rgba(255,255,255,.28);
  --dsw-alias-state-business-primary:#6b8afd;
  --dsw-alias-state-error-primary:#f2777a;
}
`
    : ''

  const html = `<!doctype html>
<html lang="zh-CN"${dark ? ' class="dark" data-theme="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1">
<title>三省六部 · 工作台预览 (${theme} / ${width}px)</title>
<style>
${shellCss}
${css}
${darkOverride}
</style>
</head>
<body>
<div class="pv-shell" data-dsw-theme="${theme}" data-pv-width="${width}">
  <header class="pv-chat-head">
    <div class="pv-chat-avatar">三</div>
    <div class="pv-chat-title">三省六部 · 工作台</div>
    <div class="pv-chat-sub">${theme} · ${width}px</div>
  </header>
  <main class="pv-panel">
${panelHtml}
  </main>
</div>
<script>
${WIRE_RECOMPUTE}
</script>
<div id="pv-height" hidden></div>
<script>
(function () {
  function measure() {
    var shell = document.querySelector('.pv-shell');
    var shellHeight = shell ? Math.ceil(shell.getBoundingClientRect().height) : 0;
    var height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      shellHeight
    );
    var marker = document.getElementById('pv-height');
    if (marker) marker.textContent = String(height);
  }
  measure();
  requestAnimationFrame(function () { measure(); });
  setTimeout(measure, 80);
})();
</script>
</body>
</html>
`
  return html
}

function measureHeight(chrome, htmlPath, width, theme, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--hide-scrollbars',
    `--window-size=${width},200`,
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3000',
    '--dump-dom',
    `--user-data-dir=${profileDir}`,
  ]
  if (theme === 'dark') args.push('--blink-settings=preferredColorScheme=0')
  args.push(pathToFileURL(htmlPath).href)
  const result = chromeRun(chrome, args, '量高')
  const dom = String(result.stdout || '')
  const match = /id="pv-height"[^>]*>([0-9]+)</.exec(dom)
  if (!match) {
    fail(`量高失败：页面里没有写回 #pv-height。dump-dom 前 500 字符：\n${dom.slice(0, 500)}`)
  }
  const measured = Number.parseInt(match[1], 10)
  const height = Math.max(200, Math.min(4000, measured))

  // 连线重算脚本把真实 rect 与 before/after d 写进 #pv-wires（JSON）。
  // 旧 bundle 没有 .wb-tree，这个标记不存在，属正常情况。
  let wires = null
  const wireMatch = /id="pv-wires"[^>]*>([\s\S]*?)<\/script>/.exec(dom)
  if (wireMatch) {
    const raw = wireMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    try {
      wires = JSON.parse(raw)
    } catch (error) {
      log(`连线重算结果解析失败：${error && error.message ? error.message : error}`)
    }
  }
  return { height, wires, dom }
}

function screenshot(chrome, htmlPath, pngPath, width, height, theme, scale, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    '--virtual-time-budget=2000',
    `--screenshot=${pngPath}`,
    `--user-data-dir=${profileDir}`,
  ]
  if (theme === 'dark') args.push('--blink-settings=preferredColorScheme=0')
  args.push(pathToFileURL(htmlPath).href)
  chromeRun(chrome, args, '截图')
  if (!existsSync(pngPath)) fail(`Chrome 没有写出截图：${pngPath}`)
  const size = readPngSize(pngPath)
  const expectedWidth = width * scale
  if (size.width !== expectedWidth) {
    fail(`截图宽度异常：期望 ${expectedWidth}px，实际 ${size.width}px（${pngPath}）`)
  }
  if (size.bytes < 3000) {
    fail(`截图疑似空白：${pngPath} 只有 ${size.bytes} 字节`)
  }
  return size
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const theme = String(options.theme)
  if (theme !== 'light' && theme !== 'dark') fail(`--theme 只能是 light 或 dark，收到：${theme}`)
  const width = Number.parseInt(options.width, 10)
  if (!Number.isFinite(width) || width < 200 || width > 1200) fail(`--width 需要在 200–1200 之间，收到：${options.width}`)
  const scale = Number.parseInt(options.scale, 10)
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) fail(`--scale 需要在 1–4 之间，收到：${options.scale}`)
  const name = String(options.name)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`--name 只允许字母、数字、点、下划线和短横线，收到：${name}`)
  const view = String(options.view || 'court')
  if (!['court', 'tasks', 'artifacts'].includes(view)) fail(`--view 只能是 court / tasks / artifacts，收到：${view}`)
  const openText = String(options.open || '')
  const scenario = options.live ? String(options.scenario || inferLiveScenario(name, view)) : ''
  if (options.live && !['court', 'tasks', 'cancel', 'revise', 'missing'].includes(scenario)) {
    fail(`--scenario 只能是 court / tasks / cancel / revise / missing，收到：${scenario}`)
  }
  const effectiveView = scenario === 'revise' || scenario === 'missing'
    ? 'artifacts'
    : (scenario === 'cancel' ? 'tasks' : (openText && view === 'court' ? 'artifacts' : view))

  const bundlePath = resolve(ROOT, options.bundle)
  const outDir = resolve(ROOT, options.out)
  ensureDir(SCRATCH)
  ensureDir(outDir)

  if (!existsSync(bundlePath)) {
    fail(`bundle 不存在：${bundlePath}\n（相对路径按仓库根目录解析：${ROOT}）`)
  }

  const pngPath = join(outDir, `${name}-${width}-${theme}.png`)
  const htmlPath = join(SCRATCH, `${name}-${width}-${theme}.html`)
  const profileDir = join(SCRATCH, 'chrome-profile')
  ensureDir(profileDir)

  let live = null
  if (options.live) {
    log('模式：--live（真实 Host 路由，内存账本，不使用固定数据）')
    live = await setupLiveHost()
    await registerLiveProject(live)
    await prepareLiveScenario(live, scenario)
  }

  log(`加载 bundle：${bundlePath}`)
  const hooks = createHooks()
  const loaded = loadBundle(bundlePath, hooks, { theme, fetchStub: live ? live.fetchLive : null })
  log(`bundle 导出键：${Object.keys(loaded.exports).join(', ') || '(空)'}`)
  log(`捕获 CSS：${loaded.css.length} 字符`)

  const picked = pickComponent(loaded.exports)
  log(`渲染入口：${picked.mode}`)

  let component = picked.component
  let props = { ...picked.props }
  let placeholder = false
  let entryMode = picked.mode

  if (live && typeof loaded.exports.WorkbenchRail === 'function') {
    // 真实 Host 模式下用 rail 本体（WorkbenchPanel 会丢掉 projectId 并走工作区推导，
    // 这里已经有真实注册出来的项目号，直接喂给它）。
    component = loaded.exports.WorkbenchRail
    props = { ctx: createLiveUiContext(), projectId: live.projectId, compact: true }
    entryMode = 'exports.WorkbenchRail(live)'
    log(`渲染入口改为 exports.WorkbenchRail（projectId=${live.projectId}）`)
  } else if (typeof component !== 'function') {
    placeholder = true
    const keyList = (picked.keys || Object.keys(loaded.exports)).join(', ') || '(空)'
    log(`没有找到面板组件，退化为占位 div。bundle 导出键：${keyList}`)
    component = () => hooks.React.createElement(
      'div',
      { className: 'pv-placeholder' },
      hooks.React.createElement('h3', null, '预览占位'),
      hooks.React.createElement('p', null, '这个 bundle 没有导出 __preview，也没有可识别的默认面板组件。'),
      hooks.React.createElement('pre', null, `导出键：${keyList}`),
    )
    props = {}
  } else if (typeof loaded.exports.createHost === 'function') {
    try {
      const demo = createDemoContext()
      props = {
        ...props,
        host: loaded.exports.createHost(demo.ctx),
        sessionId: LEAD_SESSION,
        compact: true,
      }
      log('已用 createHost(ctx) 构造旧式 host')
    } catch (error) {
      log(`createHost 失败，改为直接传 props：${error && error.message ? error.message : error}`)
    }
  }

  if (!live && props.projectId === undefined) props.projectId = 'prj_demo1'
  if (!live && props.sessionId === undefined) props.sessionId = LEAD_SESSION
  if (props.compact === undefined) props.compact = true

  const rootVNode = hooks.React.createElement(component, props)
  const settleResult = await settle(hooks, rootVNode, 1500)
  log(`渲染稳定：${settleResult.settled ? '是' : '否（达到 1.5s 预算）'}，${settleResult.passes} 轮，${settleResult.elapsedMs}ms`)

  let tree = settleResult.tree
  let stateSwitch = { clickedTab: null, openedArtifact: null }
  let liveScenario = null
  if (live) {
    liveScenario = await runLiveScenario({
      hooks,
      rootVNode,
      view: effectiveView,
      live,
      projectId: live.projectId,
      scenario,
    })
    tree = liveScenario.tree
    settleResult.passes += liveScenario.passes
    for (const assertion of liveScenario.assertions) {
      log(`[live] 断言「${assertion.name}」：${assertion.ok ? '通过' : '未通过'}；after=${assertion.after}`)
    }
    log(`[live] 请求 ${liveScenario.requests.length} 次；dispatch.status=${liveScenario.dispatchStatus ?? '(无)'}；prompt ${liveScenario.prompts.length} 条`)
  } else if (effectiveView !== 'court' || openText) {
    const switched = await switchPreviewState(hooks, rootVNode, effectiveView, openText, tree)
    tree = switched.tree
    stateSwitch = { clickedTab: switched.clickedTab, openedArtifact: switched.openedArtifact }
    settleResult.passes += switched.passes
    log(`视图切换：${stateSwitch.clickedTab || '(未切换)'}${stateSwitch.openedArtifact ? `，已打开成果「${stateSwitch.openedArtifact}」` : ''}`)
  }

  const panelHtml = serializeNode(tree)
  const html = buildPage({ css: loaded.css, panelHtml, width, theme })
  writeFileSync(htmlPath, html, 'utf8')
  log(`HTML：${htmlPath}（${html.length} 字符，面板 DOM ${panelHtml.length} 字符）`)

  const chrome = findChrome(options.chrome)
  log(`Chrome：${chrome}`)
  const measured = measureHeight(chrome, htmlPath, width, theme, profileDir)
  const height = measured.height
  log(`页面 scrollHeight：${height}px`)

  const wires = measured.wires
  if (wires && wires.applied) {
    log(`连线重算：已按真实 DOM rect 重写 ${wires.after.length} 条 path`)
    log(`  分叉[0] before：${wires.before[0]}`)
    log(`  分叉[0] after ：${wires.after[0]}`)
    log(`  丞相底边 y=${wires.lead.bottom}，三省顶边 y=${wires.sansheng.map((card) => card.top).join('/')}，六部组顶边 y=${wires.group.top}`)
    log(`  端点：分支终点 y 与卡片 top 相等；主干终点 y 与 group.top 相等（${wires.group.top}）`)
  } else {
    log('连线重算：页面里没有 .wb-tree 或未写入 #pv-wires（旧 bundle / 占位渲染属正常）')
  }

  const size = screenshot(chrome, htmlPath, pngPath, width, height, theme, scale, profileDir)
  log(`截图：${pngPath}（${size.width}x${size.height}，${size.bytes} 字节，scale=${scale}）`)

  const sourceLines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).length
  const report = {
    bundle: bundlePath,
    bundleBase: options.bundle,
    bundleBytes: statSync(bundlePath).size,
    entry: entryMode,
    placeholder,
    live: liveScenario
      ? {
        projectId: liveScenario.projectId,
        requests: liveScenario.requests,
        dispatches: liveScenario.dispatches,
        cancellations: liveScenario.cancellations,
        revisions: liveScenario.revisions,
        preparedArtifact: liveScenario.preparedArtifact,
        dispatchStatus: liveScenario.dispatchStatus,
        prompts: liveScenario.prompts.map((entry) => ({
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          text: entry.text.slice(0, 200),
          chars: entry.text.length,
        })),
        assertions: liveScenario.assertions,
        controllerCalls: liveScenario.controllerCalls,
      }
      : null,
    theme,
    width,
    scale,
    view: effectiveView,
    scenario: scenario || null,
    openedArtifact: stateSwitch.openedArtifact,
    html: htmlPath,
    png: pngPath,
    pngSize: { width: size.width, height: size.height, bytes: size.bytes },
    scrollHeight: height,
    passes: settleResult.passes,
    settled: settleResult.settled,
    elapsedMs: settleResult.elapsedMs,
    cssLength: loaded.css.length,
    exportKeys: Object.keys(loaded.exports),
    wireRecompute: wires && wires.applied
      ? {
        applied: true,
        box: wires.box,
        branchBefore: wires.before[0],
        branchAfter: wires.after[0],
        trunkBefore: wires.before[3],
        trunkAfter: wires.after[3],
        leadBottom: wires.lead.bottom,
        sanshengTops: wires.sansheng.map((card) => card.top),
        groupTop: wires.group.top,
      }
      : null,
    scriptLines: sourceLines,
  }
  if (liveScenario) {
    const liveLogPath = join(SCRATCH, `${name}-${width}-${theme}-live.json`)
    writeFileSync(liveLogPath, JSON.stringify({
      bundle: bundlePath,
      projectId: liveScenario.projectId,
      requests: liveScenario.requests,
      dispatches: liveScenario.dispatches,
      cancellations: liveScenario.cancellations,
      revisions: liveScenario.revisions,
      preparedArtifact: liveScenario.preparedArtifact,
      dispatchStatus: liveScenario.dispatchStatus,
      prompts: liveScenario.prompts,
      assertions: liveScenario.assertions,
      controllerCalls: liveScenario.controllerCalls,
    }, null, 2), 'utf8')
    log(`[live] 请求/派发/prompt 日志：${liveLogPath}`)
  }
  process.stdout.write(`PREVIEW_RESULT ${JSON.stringify(report)}\n`)
}

main().catch((error) => {
  if (error && error.previewFailure) {
    process.stderr.write(`\n[preview-workbench] 失败：${error.message}\n`)
  } else {
    process.stderr.write(`\n[preview-workbench] 未预期错误：${error && error.stack ? error.stack : error}\n`)
  }
  process.exitCode = 1
})
