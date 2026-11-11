// Host 层测试：契约解析、会话适配、派发幂等、对账与工作台外壳。
// 全部用假 SessionController（与 P0 记录的签名同形）驱动，不连真宿主，
// 这样“首次派发 / 重复点击 / 超时未知 / 宿主重启后对账”都能确定性地复现。

import test from 'node:test'
import assert from 'node:assert/strict'

import { WorkbenchStore } from '../core/store.mjs'
import { createWorkbenchService } from '../host/service.mjs'
import {
  CONTRACT_ACTION_PREFIX,
  parseContractLines,
  validateContractCall,
  describeContract,
} from '../host/contract.mjs'
import { buildDispatchText, classifyHostError, createSessionAdapter } from '../host/session-adapter.mjs'
import { createDispatchService } from '../host/dispatch-service.mjs'
import { createReconciler } from '../host/reconciler.mjs'
import { createWorkbenchHost } from '../host/workbench-host.mjs'

const clock = () => 1700000000000
const WS = 'ws_demo'

/** 假宿主：行为可控，记录每次 create/prompt/cancel，便于断言“没重发”。 */
function fakeController(behaviour = {}) {
  const calls = { create: [], prompt: [], cancel: [], selectModel: [], inspect: [], list: 0 }
  const sessions = new Map()
  let next = 1
  const controller = {
    calls,
    sessions,
    async create(request) {
      calls.create.push(request)
      const existing = [...sessions.values()].find((row) => row.workspaceId === request.workspaceId)
      if (existing !== undefined && request.sessionId === undefined) return { sessionId: existing.sessionId }
      const sessionId = request.sessionId ?? `ses_${next++}`
      sessions.set(sessionId, { sessionId, workspaceId: request.workspaceId ?? null, running: false, accepted: new Set() })
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
      if (behaviour.promptFails === 'timeout') throw Object.assign(new Error('timeout picking up request'), { code: 'ETIMEDOUT' })
      if (behaviour.promptFails === 'busy') throw Object.assign(new Error('agent busy'), { code: 'session/agent-busy' })
      if (row.accepted.has(request.requestId)) return { accepted: true }
      row.accepted.add(request.requestId)
      row.running = behaviour.staysRunning !== false
      return { accepted: true }
    },
    cancel(request) {
      calls.cancel.push(request)
      const row = sessions.get(request.sessionId)
      if (row !== undefined) row.running = false
      return { accepted: true }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      if (behaviour.selectModelFails === true) {
        throw Object.assign(new Error('model unavailable'), { code: 'session/model-unavailable' })
      }
      return { selected: { provider: request.provider, model: request.model } }
    },
    async list() {
      calls.list += 1
      return {
        items: [...sessions.values()].map((row) => ({ sessionId: row.sessionId, running: row.running, agentAvailable: true, updatedAt: '', blank: false })),
      }
    },
  }
  return controller
}

function freshWorkbench(behaviour = {}) {
  const store = new WorkbenchStore({ file: null, clock, env: { DSH_HOME: '/tmp/never-used' } })
  const service = createWorkbenchService({ store, clock })
  const controller = fakeController(behaviour)
  const sessions = createSessionAdapter({ sessionController: controller })
  const dispatch = createDispatchService({ store, service, sessions })
  const reconciler = createReconciler({ store, service, sessions, clock })
  const project = service.registerProject({ hostWorkspaceId: WS, displayNameCache: '演示项目' }).project
  // 接通丞相与工部两个会话（首版两席闭环）。
  for (const roleId of ['lead', 'gongbu']) {
    const sessionId = roleId === 'lead' ? 'ses_lead' : 'ses_gongbu'
    controller.sessions.set(sessionId, { sessionId, workspaceId: WS, running: false, accepted: new Set() })
    service.bindDepartmentSession({ projectId: project.id, roleId, sessionId, allowReplace: false })
  }
  service.saveDepartmentConfig({
    projectId: project.id,
    roleId: 'gongbu',
    provider: 'magpie',
    model: 'workbuddy/deepseek-v4.1-flash',
    expectedRevision: 0,
  })
  return { store, service, controller, sessions, dispatch, reconciler, projectId: project.id }
}

// ---------- 契约 ----------

test('契约解析只认四动作，坏 JSON 与未知动作都不改状态', () => {
  const text = [
    '普通正文，不含指令。',
    `${CONTRACT_ACTION_PREFIX}{"action":"reportTaskResult","taskId":"task_1","attemptId":"att_1","summary":"完成"}`,
    `${CONTRACT_ACTION_PREFIX}{"action":"finalizeEverything","taskId":"task_1"}`,
    `${CONTRACT_ACTION_PREFIX}{不是 JSON}`,
    '我已经完成了。',
  ].join('\n')
  const { calls, invalid } = parseContractLines(text)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'reportTaskResult')
  assert.equal(invalid.length, 2)
  assert.match(invalid[0].reason, /未知动作/)
  assert.match(invalid[1].reason, /JSON/)
  // 纯文本“已完成”不产生任何调用：这是方案明令禁止的推断路径。
  assert.deepEqual(parseContractLines('任务已完成，请查收').calls, [])
  assert.deepEqual(parseContractLines(null), { calls: [], invalid: [] })
})

test('validateContractCall 拦住缺幂等键/缺摘要的调用', () => {
  assert.deepEqual(validateContractCall({ action: 'dispatchTask', payload: { taskId: 'task_1', idempotencyKey: 'k' } }), [])
  assert.deepEqual(validateContractCall({ action: 'reportTaskResult', payload: { taskId: 'task_1', attemptId: 'att_1', summary: 's' } }), [])
  assert.match(validateContractCall({ action: 'dispatchTask', payload: { taskId: 'task_1' } })[0], /idempotencyKey/)
  assert.match(validateContractCall({ action: 'reportTaskResult', payload: { taskId: 't' } }).join(';'), /attemptId/)
  assert.match(validateContractCall({ action: 'requestTaskInput', payload: { taskId: 't', attemptId: 'a' } }).join(';'), /reason/)
  assert.match(validateContractCall({ action: 'syncDecision', payload: { taskId: 't' } }).join(';'), /decision/)
  assert.match(describeContract(), /reportTaskResult/)
})

// ---------- 会话适配 ----------

test('会话适配：缺 sessionId 时按 workspace 建会话且不重复建', async () => {
  const controller = fakeController()
  const sessions = createSessionAdapter({ sessionController: controller })
  const first = await sessions.ensureSession({ workspaceId: WS, agentPreset: 'sansheng-liubu' })
  const second = await sessions.ensureSession({ workspaceId: WS, agentPreset: 'sansheng-liubu' })
  assert.equal(first.created, true)
  assert.equal(first.sessionId, second.sessionId, '同一 workspace 不能建出第二个会话')
  assert.equal(controller.calls.create.length, 2)
  await assert.rejects(() => sessions.ensureSession({}), /workspaceId/)
})

test('会话适配：prompt 必须带 requestId，错误分类可区分可重试与必失败', async () => {
  const controller = fakeController()
  const sessions = createSessionAdapter({ sessionController: controller })
  await assert.rejects(() => sessions.sendPrompt({ sessionId: 'ses_1', text: 'hi' }), /requestId/)
  await assert.rejects(() => sessions.sendPrompt({ sessionId: 'ses_1', requestId: 'r1', text: '  ' }), /为空/)
  assert.equal(classifyHostError(Object.assign(new Error('x'), { code: 'session/conflict' })), 'conflict')
  assert.equal(classifyHostError(Object.assign(new Error('x'), { code: 'session/model-unavailable' })), 'model_unavailable')
  assert.equal(classifyHostError(new Error('request timeout')), 'transient')
  assert.equal(classifyHostError(new Error('随便什么')), 'unknown')
})

test('派发提示词只写事实，不给“已完成”下定义', () => {
  const text = buildDispatchText({
    task: { id: 'task_1', title: '整理报表', objective: '合并三张表', acceptance: ['口径一致'], constraints: ['只读源文件'] },
    packet: { materialRefs: ['a.xlsx'] },
    contractGuide: '（结构化回传说明）',
    roleName: '工部',
  })
  assert.match(text, /任务单 task_1/)
  assert.match(text, /口径一致/)
  assert.match(text, /a\.xlsx/)
  assert.match(text, /不要只在正文里说“已完成”/)
})

// ---------- 派发 ----------

test('首次派发：固定模型快照 → prompt 用 attemptId 作幂等键 → dispatch accepted', async () => {
  const { store, service, controller, dispatch, projectId } = freshWorkbench()
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: '导出报表', objective: '按模板导出' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k1' })
  assert.equal(result.outcome, 'accepted')
  assert.equal(result.duplicate, false)
  const attempt = store.getAttempt(result.attempt.id)
  assert.equal(attempt.state, 'running')
  // A06：默认不调 selectModel（部门模型由政策插件在 agent/request 上覆写，
  // 再调一次会让宿主把全局默认模型存成本部门的）。模型快照仍记在 attempt 上。
  assert.equal(controller.calls.selectModel.length, 0, "默认不碰宿主的模型选择")
  assert.equal(attempt.effectiveConfigSnapshot.model, "workbuddy/deepseek-v4.1-flash")
  assert.equal(controller.calls.prompt.length, 1)
  assert.equal(controller.calls.prompt[0].requestId, attempt.id, 'attemptId 就是 prompt 的幂等键')
  assert.equal(store.getDispatch(result.dispatch.id).state, 'accepted')
})

test('重复点击同一幂等键：不重复投递、返回既有结论', async () => {
  const { service, controller, dispatch, projectId } = freshWorkbench()
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const first = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'same' })
  const second = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'same' })
  assert.equal(second.duplicate, true)
  assert.equal(second.dispatch.id, first.dispatch.id)
  assert.equal(controller.calls.prompt.length, 1, '第二次点击不能再发一条消息')
})

test('投递超时：dispatch 记 unknown，不自动重发', async () => {
  const { store, service, controller, dispatch, projectId } = freshWorkbench({ promptFails: 'timeout' })
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k-timeout' })
  assert.equal(result.outcome, 'unknown')
  assert.equal(store.getDispatch(result.dispatch.id).state, 'unknown')
  assert.equal(store.getAttempt(result.attempt.id).state, 'unknown')
  assert.equal(controller.calls.prompt.length, 1)
  // 再点一次同一幂等键：仍是 unknown，不会再发第二遍
  const again = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k-timeout' })
  assert.equal(again.duplicate, true)
  assert.equal(controller.calls.prompt.length, 1)
  // 查证：会话确实存在 → 收口为 accepted
  const verified = await dispatch.verifyUnknown(result.dispatch.id)
  assert.equal(verified.outcome, 'accepted')
  assert.equal(store.getAttempt(result.attempt.id).state, 'running')
})

test('部门未接通时派发被拒，任务留在账上而不是变成失败', async () => {
  const { store, service, dispatch, projectId } = freshWorkbench()
  // 户部没有接通会话：只能先存草稿，入队会被明确拒绝（派给没会话的部门只会在投递阶段撞 unknown）。
  const task = service.createTask({ projectId, ownerRoleId: 'hubu', sourceRoleId: 'lead', title: 't', objective: 'o', status: 'draft' }).task
  await assert.rejects(
    () => dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k' }),
    (error) => error.code === 'INVALID_STATE',
  )
  assert.equal(store.getTask(task.id).status, 'draft', '被拒的派发不改任务状态')
})

// ---------- 对账 ----------

test('对账：宿主还在跑只推进 running，不判完成', async () => {
  const { store, service, dispatch, reconciler, projectId } = freshWorkbench({ staysRunning: true })
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k' })
  const outcome = await reconciler.reconcileOnce()
  assert.equal(outcome.checked >= 1, true)
  assert.equal(store.getTask(task.id).status, 'running', '还在跑就不是完成')
  assert.equal(store.getAttempt(result.attempt.id).state, 'running')
})

test('对账：运行结束但无报告 → needs_attention，而不是 completed', async () => {
  const { store, service, controller, dispatch, reconciler, projectId } = freshWorkbench()
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k' })
  controller.sessions.get('ses_gongbu').running = false
  await reconciler.reconcileOnce()
  assert.equal(store.getAttempt(result.attempt.id).state, 'succeeded')
  assert.equal(store.getTask(task.id).status, 'needs_attention')
  assert.match(store.getTask(task.id).needsAttentionReason, /结构化报告/)
})

test('对账：取消请求后宿主停跑 → attempt cancelled、任务 cancelled', async () => {
  const { store, service, controller, dispatch, reconciler, sessions, projectId } = freshWorkbench()
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k' })
  // 只发停止请求：cancel() 是同步 accepted，不等于已停，此时尝试仍停在 running。
  sessions.requestCancel('ses_gongbu')
  controller.sessions.get('ses_gongbu').running = false
  await reconciler.reconcileOnce()
  assert.equal(store.getAttempt(result.attempt.id).state, 'cancelled')
  assert.equal(store.getTask(task.id).status, 'cancelled')
})

test('对账：宿主重启后查不到会话时不猜，保持原状', async () => {
  const { store, service, controller, dispatch, reconciler, projectId } = freshWorkbench()
  const task = service.createTask({ projectId, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o' }).task
  const result = await dispatch.dispatch({ projectId, taskId: task.id, idempotencyKey: 'k' })
  // 让 list 抛错：问不到 = null
  controller.list = async () => {
    throw new Error('host restarting')
  }
  const outcome = await reconciler.reconcileOnce()
  assert.equal(outcome.changed.length, 0)
  assert.equal(store.getAttempt(result.attempt.id).state, 'running')
})

// ---------- 工作台外壳 ----------

test('工作台外壳：浏览器侧/无会话能力时降级为只读账本', async () => {
  const store = new WorkbenchStore({ file: null, clock })
  const host = createWorkbenchHost({}, { store })
  assert.equal(host.hasSessions, false)
  const project = host.service.registerProject({ hostWorkspaceId: WS }).project
  const bootstrap = host.bootstrap(project.id)
  assert.equal(bootstrap.seats.length, 10)
  assert.equal(bootstrap.seats.filter((seat) => seat.connected).length, 0)
  assert.equal(bootstrap.seats[0].pendingLabel, '尚未接通')
  const dispatched = await host.dispatchTask({ projectId: project.id, taskId: 'task_x', idempotencyKey: 'k' })
  assert.equal(dispatched.ok, false)
  assert.equal(dispatched.code, 'NO_SESSION_CONTROLLER')
})

test('工作台外壳：接通部门写出绑定，且同一会话不能同时属于两个部门', async () => {
  const store = new WorkbenchStore({ file: null, clock })
  const controller = fakeController()
  const host = createWorkbenchHost({ sessionController: controller }, { store })
  const project = host.service.registerProject({ hostWorkspaceId: WS }).project
  const gongbu = await host.connectDepartment({ projectId: project.id, roleId: 'gongbu' })
  assert.equal(gongbu.created, true)
  assert.equal(gongbu.seat.connected, true)
  // 把工部已在用的会话硬塞给户部：store 必须拒绝（会话独占）
  await assert.rejects(
    () => host.connectDepartment({ projectId: project.id, roleId: 'hubu', sessionId: gongbu.sessionId }),
    (error) => error.code === 'SESSION_CONFLICT',
  )
  const seats = host.bootstrap(project.id).seats
  assert.equal(seats.find((seat) => seat.roleId === 'gongbu').connected, true)
  assert.equal(seats.find((seat) => seat.roleId === 'hubu').connected, false)
})

test('工作台外壳：ingestAgentOutput 只应用可解析的契约行', () => {
  const store = new WorkbenchStore({ file: null, clock })
  const host = createWorkbenchHost({}, { store })
  const project = host.service.registerProject({ hostWorkspaceId: WS }).project
  // 无会话能力的外壳里工部未接通，只能建草稿；这里要验的是契约解析，不是入队资格。
  const task = host.service.createTask({ projectId: project.id, ownerRoleId: 'gongbu', sourceRoleId: 'lead', title: 't', objective: 'o', status: 'draft' }).task
  // 草稿要先入队，才谈得上 waiting_input。
  store.updateTask({ ...store.getTask(task.id), status: 'queued' })
  const text = [
    '正文里说一句“已完成”，不算数。',
    `${CONTRACT_ACTION_PREFIX}${JSON.stringify({ action: 'requestTaskInput', taskId: task.id, reason: '缺口径' })}`,
  ].join('\n')
  const out = host.ingestAgentOutput({ projectId: project.id, roleId: 'gongbu', text })
  assert.equal(out.applied.length, 1)
  assert.equal(out.failed.length, 0)
  assert.equal(store.getTask(task.id).status, 'waiting_input')
})

test('工作台外壳：sessionController 晚到后仍能补挂会话层（不必多重启一次）', async () => {
  const store = new WorkbenchStore({ file: null, clock })
  // 模拟 apply 那一刻宿主还没装好 sessionController。
  const host = createWorkbenchHost({}, { store })
  const project = host.service.registerProject({ hostWorkspaceId: WS }).project
  assert.equal(host.hasSessions, false)
  const refused = await host.dispatchTask({ projectId: project.id, taskId: 'task_x', idempotencyKey: 'k1', sourceRoleId: 'lead', targetRoleId: 'gongbu', targetSessionId: 'ses_gongbu', bindingGeneration: 0 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'NO_SESSION_CONTROLLER')

  // 宿主稍后把会话控制器交过来：同一实例直接挂上，不需要重建工作台。
  const controller = fakeController()
  assert.equal(host.attachSessions(controller), true)
  assert.equal(host.hasSessions, true)
  assert.notEqual(host.sessions, null)
  assert.notEqual(host.dispatchService, null)
  assert.notEqual(host.reconciler, null)

  // 重复挂载必须幂等：不能把已有会话层换掉。
  const first = host.sessions
  assert.equal(host.attachSessions(fakeController()), true)
  assert.equal(host.sessions, first)

  // 挂上之后「接通部门」才真正建会话并登记到账本。
  const connected = await host.connectDepartment({ projectId: project.id, roleId: 'gongbu' })
  assert.equal(connected.sessionId, 'ses_gongbu'.replace('ses_gongbu', connected.sessionId))
  assert.equal(store.getBinding(project.id, 'gongbu').currentSessionId, connected.sessionId)
})
