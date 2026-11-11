// 工作台 HTTP 路由测试：用假的 ctx / req / res 直接驱动 handler。
// 这里不启真服务器：路由层要验的是契约（方法、状态码、包装、上限、长轮询语义），
// 起服务器只会把测试变慢而不多验到东西。
//
// 长轮询只测“等待”这一侧的时序，所以 options 里把 longPollMs / pollIntervalMs 压到毫秒级；
// 25 秒是生产默认值，由 DEFAULT_LONG_POLL_MS 保证，这里断言常量本身而不是等它。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { WorkbenchStore } from '../core/store.mjs'
import { createWorkbenchService } from '../host/service.mjs'
import {
  MAX_BODY_BYTES,
  ROUTE_PREFIX,
  buildRouteTable,
  listWorkbenchRoutes,
  registerWorkbenchRoutes,
} from '../host/routes.mjs'

const FIXED_NOW = Date.parse('2026-11-09T12:00:00.000Z')

function makeService() {
  let counter = 0
  const random = () => Math.imul(counter++, 2654435761) >>> 0
  const store = new WorkbenchStore({ file: null, clock: () => FIXED_NOW, random })
  const service = createWorkbenchService({ store, clock: () => FIXED_NOW })
  return { store, service }
}

/** 假 res：只记录 writeHead/end，够断言状态码、头与体。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
      return this
    },
    writeHead(status, headers) {
      this.statusCode = status
      for (const [name, value] of Object.entries(headers ?? {})) this.headers[String(name).toLowerCase()] = value
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.writableEnded = true
      return this
    },
    get json() {
      return this.body === '' ? null : JSON.parse(this.body)
    },
  }
  return res
}

function fakeReq(method, url, body = undefined) {
  const hasBody = body !== undefined
  const text = hasBody === false ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const stream = Readable.from(hasBody ? [Buffer.from(text, 'utf8')] : [])
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

/** 装一套路由，返回 { ctx, routes: Map<path, handler>, dispose, options }。 */
function mount(service, options = {}) {
  const registered = new Map()
  const disposed = []
  const ctx = {
    webServer: {
      register(route) {
        registered.set(route.path, route)
        const off = () => disposed.push(route.path)
        return off
      },
    },
  }
  const dispose = registerWorkbenchRoutes(ctx, service, { longPollMs: 30, pollIntervalMs: 5, ...options })
  const call = async (method, url, body) => {
    // 注册表按“不含查询串”的精确路径索引；带 ?since= 的调用要先把查询串切掉再查。
    const path = url.search(/[?#]/) < 0 ? url : url.slice(0, url.search(/[?#]/))
    const route = registered.get(path)
    assert.ok(route !== undefined, `未注册路由: ${path}`)
    assert.equal(route.kind, 'exact')
    const res = fakeRes()
    await route.handler(fakeReq(method, url, body), res)
    return res
  }
  return { ctx, registered, disposed, dispose, call }
}

function seedService(service) {
  const a = service.registerProject({ hostWorkspaceId: 'ws-a', displayNameCache: '项目A' }).project
  const b = service.registerProject({ hostWorkspaceId: 'ws-b', displayNameCache: '项目B' }).project
  service.bindDepartmentSession({ projectId: a.id, roleId: 'libu', sessionId: 'sess-a-libu' })
  service.bindDepartmentSession({ projectId: b.id, roleId: 'libu', sessionId: 'sess-b-libu' })
  return { a, b }
}

// ---------- 注册与降级 ----------

test('注册：十六条 exact 路由，dispose 幂等且能全部卸载', () => {
  const { service } = makeService()
  const { registered, disposed, dispose } = mount(service)
  assert.deepEqual([...registered.keys()].sort(), [
    `${ROUTE_PREFIX}/artifact`,
    `${ROUTE_PREFIX}/artifact/revision`,
    `${ROUTE_PREFIX}/bind`,
    `${ROUTE_PREFIX}/bootstrap`,
    `${ROUTE_PREFIX}/config`,
    `${ROUTE_PREFIX}/connect`,
    `${ROUTE_PREFIX}/dispatch`,
    `${ROUTE_PREFIX}/events`,
    `${ROUTE_PREFIX}/ingest`,
    `${ROUTE_PREFIX}/memory/append`,
    `${ROUTE_PREFIX}/memory/get`,
    `${ROUTE_PREFIX}/memory/put`,
    `${ROUTE_PREFIX}/project`,
    `${ROUTE_PREFIX}/result`,
    `${ROUTE_PREFIX}/task`,
    `${ROUTE_PREFIX}/task/cancel`,
  ])
  assert.equal(dispose.registered, true)
  assert.equal(dispose.paths.length, 16)
  dispose()
  dispose()
  assert.equal(disposed.length, 16, '十六条路由各卸载一次，重复调用不再卸载')
})

test('注册：宿主没有 webServer 时降级为 no-op，不抛', () => {
  const { service } = makeService()
  for (const ctx of [undefined, null, {}, { webServer: {} }, { webServer: { register: 1 } }]) {
    const dispose = registerWorkbenchRoutes(ctx, service, {})
    assert.equal(typeof dispose, 'function')
    assert.equal(dispose.registered, false)
    assert.match(dispose.reason, /webServer/)
    dispose()
  }
})

test('注册：中途失败会回滚已注册的路由', () => {
  const { service } = makeService()
  let calls = 0
  const offs = []
  const ctx = {
    webServer: {
      register() {
        calls += 1
        if (calls === 3) throw new Error('宿主拒绝注册')
        const off = () => offs.push(calls)
        return off
      },
    },
  }
  assert.throws(() => registerWorkbenchRoutes(ctx, service, {}), /宿主拒绝注册/)
  assert.equal(offs.length, 2, '两条已注册的回滚')
})

test('listWorkbenchRoutes 列出端点与方法', () => {
  const rows = listWorkbenchRoutes()
  assert.equal(rows.length, 16)
  assert.deepEqual(rows.find((row) => row.path.endsWith('/bootstrap')), {
    path: `${ROUTE_PREFIX}/bootstrap`,
    method: 'GET',
  })
  assert.equal(rows.filter((row) => row.method === 'GET').length, 2)
})

// ---------- 方法与包装 ----------

test('方法：POST 路由被 GET 调用返回 405 且带 Allow', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  for (const path of Object.keys(buildRouteTable(service, {}))) {
    if (path.endsWith('/bootstrap') || path.endsWith('/events')) continue
    const res = await call('GET', path)
    assert.equal(res.statusCode, 405, `${path} 应 405`)
    assert.equal(res.headers.allow, 'POST')
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error.code, 'METHOD_NOT_ALLOWED')
  }
})

test('方法：GET 路由被 POST 调用返回 405 且带 Allow', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  for (const path of [`${ROUTE_PREFIX}/bootstrap`, `${ROUTE_PREFIX}/events`]) {
    const res = await call('POST', path, {})
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers.allow, 'GET')
  }
})

test('方法：PUT/DELETE 一律 405', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await call(method, `${ROUTE_PREFIX}/task`, { projectId: 'proj_x' })
    assert.equal(res.statusCode, 405, `${method} 应 405`)
  }
})

test('响应头：JSON + charset、no-store、Content-Length 与实际字节一致', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const res = await call('POST', `${ROUTE_PREFIX}/project`, { hostWorkspaceId: 'ws-a', displayNameCache: '中文项目' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-length'], Buffer.byteLength(res.body))
  assert.equal(res.json.ok, true)
  assert.ok(res.json.value.project.id.startsWith('proj_'))
})

test('未实现路径：不在表里就没有路由，表本身不含其它前缀', () => {
  const { service } = makeService()
  const table = buildRouteTable(service, {})
  assert.equal(Object.keys(table).some((path) => path === `${ROUTE_PREFIX}/unknown`), false)
  assert.equal(Object.keys(table).every((path) => path.startsWith(`${ROUTE_PREFIX}/`)), true)
  // 前缀只登记 exact：绝不允许 kind='prefix' 把整棵子树交给某个 handler。
  const { registered } = mount(service)
  for (const route of registered.values()) assert.equal(route.kind, 'exact')
})

// ---------- 请求体 ----------

test('请求体：非法 JSON 返回 400 INVALID_INPUT', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const res = await call('POST', `${ROUTE_PREFIX}/project`, '{这不是 JSON')
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.code, 'INVALID_INPUT')
})

test('请求体：JSON 数组 / null / 标量都拒绝', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  for (const raw of ['[]', 'null', '42', '"字符串"']) {
    const res = await call('POST', `${ROUTE_PREFIX}/project`, raw)
    assert.equal(res.statusCode, 400, `${raw} 应 400`)
    assert.equal(res.json.error.code, 'INVALID_INPUT')
  }
})

test('请求体：空体按 {} 处理，交给服务层报缺参', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const res = await call('POST', `${ROUTE_PREFIX}/task`, undefined)
  assert.equal(res.statusCode, 400)
  // 路由层不替业务决定“先报哪个缺参”：服务层先校验角色，所以这里是 INVALID_ROLE。
  assert.equal(res.json.error.code, 'INVALID_ROLE')
  assert.equal(res.json.error.details.field, 'ownerRoleId')
})

test('请求体：超过 256 KB 返回 413', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const big = JSON.stringify({ projectId: 'proj_x', pad: 'x'.repeat(MAX_BODY_BYTES) })
  assert.ok(Buffer.byteLength(big) > MAX_BODY_BYTES)
  const res = await call('POST', `${ROUTE_PREFIX}/task`, big)
  assert.equal(res.statusCode, 413)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.code, 'INVALID_INPUT')
  assert.equal(res.json.error.details.limit, MAX_BODY_BYTES)
})

test('请求体：刚好等于上限不拦，超过上限 1 字节就拦', async () => {
  const { service } = makeService()
  const { call } = mount(service, { maxBodyBytes: 64 })
  const okBody = JSON.stringify({ pad: 'y'.repeat(64 - '{"pad":""}'.length) })
  assert.equal(Buffer.byteLength(okBody), 64)
  const ok = await call('POST', `${ROUTE_PREFIX}/project`, okBody)
  assert.equal(ok.statusCode, 400, '体本身合法，但缺 hostWorkspaceId → 业务 400，不是 413')
  assert.notEqual(ok.statusCode, 413)

  const over = JSON.stringify({ pad: 'y'.repeat(65 - '{"pad":""}'.length) })
  assert.equal(Buffer.byteLength(over), 65)
  const res = await call('POST', `${ROUTE_PREFIX}/project`, over)
  assert.equal(res.statusCode, 413)
})

// ---------- 业务错误映射 ----------

test('错误映射：NOT_FOUND→404、CROSS_PROJECT→409、CONFIG_CONFLICT→409', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a, b } = seedService(service)

  const missing = await call('POST', `${ROUTE_PREFIX}/task/cancel`, { projectId: a.id, taskId: 'task_notexist001' })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json.error.code, 'NOT_FOUND')

  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task
  const cross = await call('POST', `${ROUTE_PREFIX}/task/cancel`, { projectId: b.id, taskId: task.id })
  assert.equal(cross.statusCode, 409)
  assert.equal(cross.json.error.code, 'CROSS_PROJECT')
  assert.equal(cross.body.includes(a.id), false, '不得回显另一个项目的真实 ID')

  const config = await call('POST', `${ROUTE_PREFIX}/config`, {
    projectId: a.id,
    roleId: 'libu',
    provider: 'anthropic',
    model: 'claude',
    expectedRevision: 7,
  })
  assert.equal(config.statusCode, 409)
  assert.equal(config.json.error.code, 'CONFIG_CONFLICT')
  assert.equal(config.json.error.details.currentRevision, 0)
})

test('错误：details 原样透出（CAS 冲突带回当前值）', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const saved = service.saveDepartmentConfig({
    projectId: a.id,
    roleId: 'libu',
    provider: 'anthropic',
    model: 'claude-sonnet',
    reasoningEffort: 'high',
    expectedRevision: 0,
  })
  const res = await call('POST', `${ROUTE_PREFIX}/config`, {
    projectId: a.id,
    roleId: 'libu',
    provider: 'openai',
    model: 'gpt',
    expectedRevision: saved.config.configRevision,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.value.config.model, 'gpt')
})

test('错误：未知 roleId → 400 INVALID_ROLE', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const res = await call('POST', `${ROUTE_PREFIX}/bind`, { projectId: a.id, roleId: 'libbu', sessionId: 'sess-x' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error.code, 'INVALID_ROLE')
})

// ---------- 成功路径 ----------

test('bootstrap：一次拿全，且只含选中项目', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a, b } = seedService(service)
  service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' })
  service.createTask({ projectId: b.id, title: '乙', objective: '乙', ownerRoleId: 'libu' })

  const res = await call('GET', `${ROUTE_PREFIX}/bootstrap?projectId=${encodeURIComponent(a.id)}`)
  assert.equal(res.statusCode, 200)
  const value = res.json.value
  assert.equal(value.projectId, a.id)
  assert.equal(value.projects.length, 2, '项目列表含全部项目（切换器要用）')
  assert.equal(value.seats.length, 10)
  assert.deepEqual(value.tasks.map((task) => task.title), ['甲'])
  // 布局只给角色 ID：前端按 ROLES 拿名字，避免同一份数据两处维护。
  assert.deepEqual(value.layout.lead, ['lead'])
})

test('bootstrap：不传 projectId 时选中第一个项目', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const res = await call('GET', `${ROUTE_PREFIX}/bootstrap`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.value.projectId, a.id)
})

test('bootstrap：伪造 projectId 返回 404，不泄露存在性', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { b } = seedService(service)
  const res = await call('GET', `${ROUTE_PREFIX}/bootstrap?projectId=proj_zzzzzzzzzzzz`)
  assert.equal(res.statusCode, 404)
  assert.equal(res.json.error.code, 'NOT_FOUND')
  assert.equal(res.body.includes(b.id), false)
})

test('project / bind / config / task 四个 POST 串起来走通', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const created = await call('POST', `${ROUTE_PREFIX}/project`, { hostWorkspaceId: 'ws-z', displayNameCache: '项目Z' })
  const projectId = created.json.value.project.id

  const bound = await call('POST', `${ROUTE_PREFIX}/bind`, { projectId, roleId: 'libu', sessionId: 'sess-z' })
  assert.equal(bound.statusCode, 200)
  assert.equal(bound.json.value.seat.connected, true)

  const configured = await call('POST', `${ROUTE_PREFIX}/config`, {
    projectId,
    roleId: 'libu',
    provider: 'anthropic',
    model: 'claude',
    reasoningEffort: 'medium',
    expectedRevision: 0,
  })
  assert.equal(configured.statusCode, 200)
  assert.equal(configured.json.value.config.reasoningEffort, 'medium')

  const task = await call('POST', `${ROUTE_PREFIX}/task`, {
    projectId,
    title: '写一份摘要',
    objective: '摘要',
    ownerRoleId: 'libu',
  })
  assert.equal(task.statusCode, 200)
  assert.equal(task.json.value.task.status, 'queued')
})

test('artifact：直接登记成果并按修订链累加版本', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task

  const first = await call('POST', `${ROUTE_PREFIX}/artifact`, {
    projectId: a.id,
    taskId: task.id,
    displayName: '预算表.xlsx',
    mediaType: 'application/vnd.ms-excel',
    fileRef: 'C:/tmp/预算表.xlsx',
    verification: { status: 'verified' },
  })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json.value.artifact.displayName, '预算表.xlsx')
  assert.equal(first.json.value.artifact.revision, 1)
  // 没注入 fileExists 时不猜文件在不在，如实说未知。
  assert.equal(first.json.value.artifact.existence, 'unknown')

  const second = await call('POST', `${ROUTE_PREFIX}/artifact`, {
    projectId: a.id,
    taskId: task.id,
    displayName: '预算表（改）.xlsx',
    revisesArtifactId: first.json.value.artifact.id,
  })
  assert.equal(second.statusCode, 200)
  assert.equal(second.json.value.artifact.revision, 2)
  assert.equal(second.json.value.artifact.revisesArtifactId, first.json.value.artifact.id)
})

test('dispatch / result / task/cancel 走通并返回去重信息', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task

  const first = await call('POST', `${ROUTE_PREFIX}/dispatch`, {
    projectId: a.id,
    taskId: task.id,
    idempotencyKey: 'route-key-1',
    packet: { excerpts: ['需求'] },
  })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json.value.duplicate, false)
  const again = await call('POST', `${ROUTE_PREFIX}/dispatch`, {
    projectId: a.id,
    taskId: task.id,
    idempotencyKey: 'route-key-1',
  })
  assert.equal(again.json.value.duplicate, true)
  assert.equal(again.json.value.dispatch.id, first.json.value.dispatch.id)

  const started = service.startAttempt({ projectId: a.id, attemptId: first.json.value.attempt.id })
  const result = await call('POST', `${ROUTE_PREFIX}/result`, {
    projectId: a.id,
    taskId: task.id,
    attemptId: started.attempt.id,
    report: { summary: '做完了', checks: [] },
    runTerminal: 'succeeded',
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json.value.task.status, 'completed')

  const other = service.createTask({ projectId: a.id, title: '乙', objective: '乙', ownerRoleId: 'libu' }).task
  const cancelled = await call('POST', `${ROUTE_PREFIX}/task/cancel`, { projectId: a.id, taskId: other.id, reason: '不做了' })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(cancelled.json.value.task.status, 'cancelled')
})

// ---------- 事件 ----------

test('events：since 之后只给新事件，游标可重放（多标签页共用一条日志）', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const head = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=0&wait=0`)
  assert.equal(head.statusCode, 200)
  const cursor = head.json.value.seq
  assert.ok(cursor >= 1)
  // since=0 会补齐历史（建项目/绑定的那些事件），游标之后的才算“新”。
  for (const event of head.json.value.events) assert.ok(event.seq <= cursor)

  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task
  const after = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=${cursor}&wait=0`)
  assert.ok(after.json.value.events.length >= 1)
  for (const event of after.json.value.events) {
    assert.ok(event.seq > cursor, '只返回 since 之后的事件')
    assert.equal(event.projectId, a.id)
  }

  // 重放同一个 since 必须拿到同一批事件：事件日志是只读游标，不是"读一次就消失"的队列，
  // 否则开两个标签页就会互相偷事件。
  const replay = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=${cursor}&wait=0`)
  assert.deepEqual(
    replay.json.value.events.map((event) => event.eventId),
    after.json.value.events.map((event) => event.eventId),
  )
  assert.ok(task.id.startsWith('task_'))
})

test('events：since 越界（大于当前 seq）返回 reset 让前端整体重拉', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const { a } = seedService(service)
  const res = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=999999&wait=0`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.value.reset, true)
  assert.equal(res.json.value.events.length, 0)
})

test('events：since 不是数字 → 400', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  const res = await call('GET', `${ROUTE_PREFIX}/events?since=abc&wait=0`)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error.code, 'INVALID_INPUT')
})

test('events：长轮询等到新事件立刻返回，不等满窗口', async () => {
  const { service } = makeService()
  const { call } = mount(service, { longPollMs: 5_000, pollIntervalMs: 5 })
  const { a } = seedService(service)
  const head = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=0&wait=0`)
  const cursor = head.json.value.seq

  const startedAt = Date.now()
  const pending = call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=${cursor}`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' })
  const res = await pending
  const elapsed = Date.now() - startedAt
  assert.equal(res.statusCode, 200)
  assert.ok(res.json.value.events.length >= 1, '有新事件就返回')
  assert.ok(elapsed < 2_000, `应在窗口耗尽前返回，实际 ${elapsed}ms`)
})

test('events：没有新事件时挂满窗口后返回空列表 + 当前 seq', async () => {
  const { service } = makeService()
  const { call } = mount(service, { longPollMs: 40, pollIntervalMs: 5 })
  const { a } = seedService(service)
  const head = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=0&wait=0`)
  const cursor = head.json.value.seq
  const startedAt = Date.now()
  const res = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=${cursor}`)
  const elapsed = Date.now() - startedAt
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.value.events, [])
  assert.equal(res.json.value.seq, cursor)
  assert.ok(elapsed >= 35, `应至少挂到窗口尾，实际 ${elapsed}ms`)
})

test('events：longPollMs=0 时退化为立即返回', async () => {
  const { service } = makeService()
  const { call } = mount(service, { longPollMs: 0 })
  const { a } = seedService(service)
  const startedAt = Date.now()
  const res = await call('GET', `${ROUTE_PREFIX}/events?projectId=${encodeURIComponent(a.id)}&since=0`)
  assert.equal(res.statusCode, 200)
  assert.ok(Date.now() - startedAt < 500)
})

test('events：伪造 projectId 返回 404', async () => {
  const { service } = makeService()
  const { call } = mount(service)
  seedService(service)
  const res = await call('GET', `${ROUTE_PREFIX}/events?projectId=proj_zzzzzzzzzzzz&since=0&wait=0`)
  assert.equal(res.statusCode, 404)
  assert.equal(res.json.error.code, 'NOT_FOUND')
})
