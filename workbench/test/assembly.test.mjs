// 装配层测试：index.mjs 把 store / service / 会话层 / HTTP 路由拼在一起的那一层。
// 这里专门验「宿主稍后才给 sessionController」这条真实时序——它决定用户要不要多重启一次。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { createWorkbenchHost } from '../host/index.mjs'
import { WorkbenchStore } from '../core/store.mjs'

const clock = () => 1700000000000
const WS = 'ws_demo'

/** 最小 webServer 替身：记下注册的路由，卸载时清掉。 */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** 最小 cordis 替身：inject 只把回调存起来，测试手动触发「依赖出现」。 */
function fakeCtx({ webServer = null, controller = null } = {}) {
  const pending = []
  return {
    webServer,
    sessionController: controller,
    get: () => undefined,
    inject(deps, callback) {
      pending.push({ deps, callback })
      return { dispose() {} }
    },
    fire(dep, scoped) {
      const hit = pending.filter((row) => row.deps.includes(dep))
      for (const row of hit) row.callback(scoped)
      return hit.length
    },
    pending,
  }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
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

function fakeReq(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(text, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

async function callRoute(webServer, suffix, method, body) {
  const route = [...webServer.routes.values()].find((item) => String(item.path).endsWith(suffix))
  assert.notEqual(route, undefined, `未注册路由：${suffix}`)
  const res = fakeRes()
  await route.handler(fakeReq(method, route.path, body), res)
  return res.json
}

/** 所有测试都用内存账本，绝不碰 %DSH_HOME% 下的真账本。 */
function memoryStore() {
  return new WorkbenchStore({ file: null, clock })
}

function tinyController(seed = ['ses_gongbu']) {
  const sessions = new Map()
  const prompts = []
  for (const sessionId of seed) {
    sessions.set(sessionId, { sessionId, workspaceId: WS, running: false, accepted: new Set() })
  }
  return {
    prompts,
    sessions,
    async create(request) {
      const sessionId = request.sessionId ?? 'ses_auto'
      sessions.set(sessionId, { sessionId, workspaceId: request.workspaceId ?? WS, running: false, accepted: new Set() })
      return { sessionId }
    },
    async prompt(request) {
      prompts.push(request)
      const row = sessions.get(request.sessionId)
      if (row === undefined || !row.accepted) throw Object.assign(new Error('no session'), { code: 'session/conflict' })
      row.accepted.add(request.requestId)
      return { accepted: true }
    },
    cancel() {
      return { accepted: true }
    },
  }
}

test('装配层：宿主先有 webServer、后有 sessionController 时，派发从“只落账”升级为真投递', async () => {
  const store = memoryStore()
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ webServer })

  const host = createWorkbenchHost(ctx, { store, startReconciler: false })
  assert.equal(host.store, store)
  assert.equal(host.registered, true)
  assert.equal(webServer.routes.size, 16)
  assert.equal(host.hasSessions, false)

  const project = host.service.registerProject({ hostWorkspaceId: WS }).project
  const bound = host.service.bindDepartmentSession({ projectId: project.id, roleId: 'gongbu', sessionId: 'ses_gongbu' })
  const generation = bound.binding.bindingGeneration
  const task = host.service.createTask({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: '接线后派发',
    objective: 'o',
    status: 'queued',
  }).task

  // 还没有会话层：路由只落账，状态停在 prepared，不伪装成已发送。
  const before = await callRoute(webServer, '/dispatch', 'POST', {
    projectId: project.id,
    taskId: task.id,
    idempotencyKey: 'k-ledger',
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_gongbu',
    bindingGeneration: generation,
  })
  assert.equal(before.ok, true)
  assert.equal(before.value.dispatch.status, 'prepared')

  // 宿主晚到：装配层自己把会话层补挂上，不需要重建工作台、也不需要多重启一次。
  const controller = tinyController()
  assert.equal(ctx.fire('sessionController', { sessionController: controller }), 1)
  assert.equal(host.hasSessions, true)
  assert.notEqual(host.dispatchService, null)
  assert.notEqual(host.reconciler, null)

  // 同一份账本、同一张任务，换新的幂等键再派一次：这次真的投递到会话。
  const after = await callRoute(webServer, '/dispatch', 'POST', {
    projectId: project.id,
    taskId: task.id,
    idempotencyKey: 'k-live',
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_gongbu',
    bindingGeneration: generation,
  })
  assert.equal(after.ok, true)
  assert.equal(after.value.dispatch.state ?? after.value.dispatch.status, 'accepted')
  assert.equal(controller.prompts.length, 1)

  host.dispose()
  assert.equal(webServer.routes.size, 0)
})

test('装配层：重复挂载会话层是幂等的，不会把已挂上的换掉', () => {
  const store = memoryStore()
  const ctx = fakeCtx({ webServer: fakeWebServer() })
  const host = createWorkbenchHost(ctx, { store, startReconciler: false })
  assert.equal(host.hasSessions, false)

  assert.equal(host.attachSessions(tinyController()), true)
  const first = host.sessions
  assert.equal(host.attachSessions(tinyController()), true)
  assert.equal(host.sessions, first)
  host.dispose()
})

test('A05 两席闭环：丞相派工给工部 → 工部回执 → 成果登记 → 任务完成', async () => {
  const store = memoryStore()
  const webServer = fakeWebServer()
  const controller = tinyController(['ses_gongbu'])
  const ctx = fakeCtx({ webServer, controller })

  const host = createWorkbenchHost(ctx, { store, startReconciler: false })
  assert.equal(host.hasSessions, true, '有 sessionController 时就该能派发')

  // 1) 项目 + 工部接通（丞相那一席由账本自带，不需要建会话也能当派发方）
  const project = host.service.registerProject({ hostWorkspaceId: WS, displayNameCache: '闭环' }).project
  const bound = host.service.bindDepartmentSession({ projectId: project.id, roleId: 'gongbu', sessionId: 'ses_gongbu' })

  // 2) 丞相开任务并派给工部
  const task = host.service.createTask({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: '做一版预算',
    objective: '给出预算表',
    status: 'queued',
  }).task

  const dispatched = await callRoute(webServer, '/dispatch', 'POST', {
    projectId: project.id,
    taskId: task.id,
    targetRoleId: 'gongbu',
    idempotencyKey: 'loop-1',
    targetSessionId: 'ses_gongbu',
    bindingGeneration: bound.binding.bindingGeneration,
  })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  assert.equal(dispatched.value.dispatch.status, 'accepted')
  assert.equal(controller.prompts.length, 1, '工部会话应真实收到一条任务单')
  assert.ok(controller.prompts[0].content[0].text.includes('做一版预算'))

  const attempt = store.listAttempts(task.id)[0]
  assert.ok(attempt, '派发要落一条 attempt')

  // 3) 工部登记成果，再用契约行回执（正文里说“已完成”不算）
  const artifact = host.service.registerArtifact({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    taskId: task.id,
    displayName: '预算表',
    fileRef: 'C:/work/预算.xlsx',
    verification: { status: 'verified' },
  }).artifact

  const ingest = await callRoute(webServer, '/ingest', 'POST', {
    projectId: project.id,
    roleId: 'gongbu',
    text: `【三省六部】${JSON.stringify({
      action: 'reportTaskResult',
      taskId: task.id,
      attemptId: attempt.id,
      reportVersion: 1,
      report: {
        summary: '预算表已出',
        checks: [{ name: '合计对得上', ok: true, detail: '与台账一致' }],
        artifactRefs: [artifact.id],
      },
    })}`,
  })
  assert.equal(ingest.ok, true, JSON.stringify(ingest))
  assert.equal(ingest.value.applied.length, 1, JSON.stringify(ingest.value.failed))

  // 4) 会话跑完：报告 + 终态成功 + 成果有效 → 任务完成
  host.service.reportRunTerminal({
    projectId: project.id,
    taskId: task.id,
    attemptId: attempt.id,
    runTerminal: 'succeeded',
  })
  const done = store.getTask(task.id)
  assert.equal(done.status, 'completed')
  assert.ok(store.listResults(task.id).length >= 1, '回执要落成 Result，而不是只改任务状态')
  assert.equal(store.listArtifacts(project.id).length, 1)
  assert.equal(store.getDispatch(dispatched.value.dispatch.id).status, 'accepted')
});
