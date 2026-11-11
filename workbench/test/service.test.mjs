// Host 侧业务服务测试：项目隔离、CAS、幂等派发、结果去重、完成判定三分支。
// 全部用真实 WorkbenchStore（内存账本），不 mock 数据层——幂等与状态机就在那一层，
// 换成假 store 会把要验的东西验掉。

import testDefault from 'node:test'
import assert from 'node:assert/strict'
import { WorkbenchStore } from '../core/store.mjs'
import { createWorkbenchService, ServiceError } from '../host/service.mjs'

const FIXED_NOW = Date.parse('2026-11-09T12:00:00.000Z')

/**
 * 固定时钟 + 可复现随机源：ID 可复现且互不相同，便于断言“只生成了一条”。
 * 种子来自当前用例名，这样每个用例都从同一条 ID 序列开头跑：
 * 不会因为别的用例多写了几条记录，就把这里的 ID 推到别处去。
 */
function makeService(seed = 'default') {
  // 单调递增计数器 + 奇数乘法打散：每次 pick 都取一个新的 32 位整数。
  // 直接返回 counter++ 会和字母表长度 36 同周期（12 位 ID 每 36 步就重演同一串，
  // 于是「同一次运行里先建任务甲、再建任务乙」可能拿到同一个 ID）；
  // 乘一个奇数再取 32 位无符号，保证整数性、单调可复现，且不落在 36 的周期上。
  let counter = hashSeed(seed)
  const random = () => Math.imul(counter++, 2654435761) >>> 0
  const store = new WorkbenchStore({
    file: null,
    clock: () => FIXED_NOW,
    random,
  })
  const service = createWorkbenchService({ store, clock: () => FIXED_NOW })
  return { store, service }
}

/** 当前用例名：随机种子取自它，保证每个用例的 ID 序列彼此独立。 */
let currentTest = 'seed'

/** 包一层 node:test：进入用例时记下名字，供 makeService 取种子。 */
function test(name, fn) {
  return testDefault(name, (t) => {
    currentTest = name
    return fn(t)
  })
}

/** 把用例名里的 ID 前缀说明清掉，只留可哈希的字符。 */
function seedOfCurrent() {
  return currentTest
}
function hashSeed(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % 100000
}

/** 建两个项目，各自把一个部门接通，返回常用 ID。 */
function seed() {
  const { store, service } = makeService(seedOfCurrent())
  const a = service.registerProject({ hostWorkspaceId: 'ws-a', displayNameCache: '项目A' }).project
  const b = service.registerProject({ hostWorkspaceId: 'ws-b', displayNameCache: '项目B' }).project
  service.bindDepartmentSession({ projectId: a.id, roleId: 'libu', sessionId: 'sess-a-libu' })
  service.bindDepartmentSession({ projectId: b.id, roleId: 'libu', sessionId: 'sess-b-libu' })
  return { store, service, a, b }
}

function expectCode(fn, code) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, `期望抛出 ${code}，实际没抛`)
  assert.ok(caught instanceof ServiceError, `期望 ServiceError，实际 ${caught?.name}`)
  assert.equal(caught.code, code, `错误码不符：${caught.code} / ${caught.message}`)
  return caught
}

// ---------- 项目 ----------

test('registerProject 同一工作区只建一个项目', () => {
  const { service } = makeService(seedOfCurrent())
  const first = service.registerProject({ hostWorkspaceId: 'ws-a', displayNameCache: '甲' })
  assert.equal(first.duplicate, false)
  const again = service.registerProject({ hostWorkspaceId: 'ws-a', displayNameCache: '甲改名' })
  assert.equal(again.duplicate, true)
  assert.equal(again.project.id, first.project.id, '重复登记不换 projectId')
  assert.equal(again.project.displayNameCache, '甲改名', '名称可更新')
  assert.equal(service.listProjects().length, 1)
  assert.equal(service.listProjects()[0].seatCount, 10)
})

test('listSeats 十席布局：未接通时 pending，接通后 connected', () => {
  const { service, a } = seed()
  const seats = service.listSeats(a.id)
  assert.equal(seats.length, 10)
  assert.deepEqual(seats.map((seat) => seat.roleId), [
    'lead', 'zhongshu', 'shangshu', 'menxia', 'libu', 'hubu', 'lipu', 'bingbu', 'xingbu', 'gongbu',
  ])
  const libu = seats.find((seat) => seat.roleId === 'libu')
  assert.equal(libu.connected, true)
  assert.equal(libu.pending, false)
  assert.equal(libu.binding.currentSessionId, 'sess-a-libu')
  assert.equal(libu.binding.bindingGeneration, 1)
  const hubu = seats.find((seat) => seat.roleId === 'hubu')
  assert.equal(hubu.connected, false)
  assert.equal(hubu.pending, true)
  assert.equal(hubu.pendingLabel, '尚未接通')
  // 只暴露 provider/model 名字，不含任何凭据字段
  for (const seat of seats) {
    assert.deepEqual(Object.keys(seat.config).sort(), ['configRevision', 'configured', 'model', 'provider', 'reasoningEffort'])
  }
  assert.equal(service.layout().ministries.length, 2)
})

// ---------- 项目隔离 ----------

test('项目隔离：A 的 taskId 在 B 上被拒为 CROSS_PROJECT', () => {
  const { service, a, b } = seed()
  const task = service.createTask({ projectId: a.id, title: '甲任务', objective: '做甲事', ownerRoleId: 'libu' }).task
  expectCode(() => service.getTask(b.id, task.id), 'CROSS_PROJECT')
  expectCode(() => service.cancelTask({ projectId: b.id, taskId: task.id }), 'CROSS_PROJECT')
  expectCode(() => service.dispatchTask({
    projectId: b.id,
    taskId: task.id,
    idempotencyKey: 'k1',
  }), 'CROSS_PROJECT')
  expectCode(() => service.requestTaskInput({ projectId: b.id, taskId: task.id, reason: '要资料' }), 'CROSS_PROJECT')
})

test('项目隔离：伪造/不存在的 ID 一律 NOT_FOUND，且不泄露归属', () => {
  const { service, a } = seed()
  // 形状合法但不存在
  const fakeTask = expectCode(() => service.getTask(a.id, 'task_doesnotexist'), 'NOT_FOUND')
  assert.ok(!JSON.stringify(fakeTask).includes('proj_'), '错误里不带任何项目 ID')
  // 形状非法
  expectCode(() => service.getTask(a.id, 'not-a-task-id'), 'NOT_FOUND')
  // 不存在的项目
  expectCode(() => service.listSeats('proj_ghost'), 'NOT_FOUND')
  expectCode(() => service.registerProject({ hostWorkspaceId: '' }), 'INVALID_INPUT')
  // 项目 A 的会话绑不到项目 B 之外的地方时不会串项目
  const conflict = expectCode(() => service.bindDepartmentSession({
    projectId: a.id,
    roleId: 'hubu',
    sessionId: 'sess-b-libu',
  }), 'SESSION_CONFLICT')
  assert.equal(conflict.details.heldBy.projectId, b_idOf(service), 'heldBy 指向真实持有者，便于 UI 解释')
})

/** 找项目 B 的 id（测试里只为了断言 heldBy，不参与业务）。 */
function b_idOf(service) {
  return service.listProjects().find((row) => row.hostWorkspaceId === 'ws-b').id
}

test('项目隔离：跨项目成果引用与尝试引用被拒', () => {
  const { store, service, a, b } = seed()
  const taskA = service.createTask({ projectId: a.id, title: '甲', objective: '甲目标', ownerRoleId: 'libu' }).task
  const taskB = service.createTask({ projectId: b.id, title: '乙', objective: '乙目标', ownerRoleId: 'libu' }).task
  const artB = service.registerArtifact({ projectId: b.id, taskId: taskB.id, displayName: '乙成果' }).artifact
  const dispatched = service.dispatchTask({ projectId: a.id, taskId: taskA.id, idempotencyKey: 'd-a' })
  // 用 B 的成果引用给 A 的任务交报告：拒绝
  const err = expectCode(() => service.reportTaskResult({
    projectId: a.id,
    taskId: taskA.id,
    attemptId: dispatched.attempt.id,
    report: { summary: '做完了', artifactRefs: [artB.id] },
    runTerminal: 'succeeded',
  }), 'CROSS_PROJECT')
  assert.ok(!JSON.stringify(err).includes(taskB.id), '不泄露另一项目的任务 ID')
  // 用 B 的尝试给 A 的任务报结果：CROSS_PROJECT
  assert.ok(store.getTask(taskB.id) !== undefined)
})

test('项目隔离：另一项目的 attemptId 报结果被拒', () => {
  const { service, a, b } = seed()
  const taskA = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task
  const taskB = service.createTask({ projectId: b.id, title: '乙', objective: '乙', ownerRoleId: 'libu' }).task
  const dispB = service.dispatchTask({ projectId: b.id, taskId: taskB.id, idempotencyKey: 'kb' })
  expectCode(() => service.reportTaskResult({
    projectId: a.id,
    taskId: taskA.id,
    attemptId: dispB.attempt.id,
    report: { summary: '串了' },
    runTerminal: 'succeeded',
  }), 'CROSS_PROJECT')
})

// ---------- 配置 CAS ----------

test('saveDepartmentConfig 走 CAS：旧 revision 冲突并带回当前值', () => {
  const { service, a } = seed()
  const first = service.saveDepartmentConfig({
    projectId: a.id,
    roleId: 'libu',
    provider: 'deepseek',
    model: 'v4',
    reasoningEffort: 'high',
    expectedRevision: 0,
  })
  assert.equal(first.configRevision, 1)
  const conflict = expectCode(() => service.saveDepartmentConfig({
    projectId: a.id,
    roleId: 'libu',
    provider: 'openai',
    model: 'gpt',
    expectedRevision: 0,
  }), 'CONFIG_CONFLICT')
  assert.equal(conflict.details.expectedRevision, 0)
  assert.equal(conflict.details.currentRevision, 1)
  assert.deepEqual(conflict.details.current, { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' })
  // 读回新 revision 后可以成功
  const ok = service.saveDepartmentConfig({
    projectId: a.id,
    roleId: 'libu',
    provider: 'openai',
    model: 'gpt',
    expectedRevision: conflict.details.currentRevision,
  })
  assert.equal(ok.configRevision, 2)
  expectCode(() => service.saveDepartmentConfig({
    projectId: a.id,
    roleId: 'libu',
    provider: 'x',
    model: 'y',
    expectedRevision: '1',
  }), 'INVALID_INPUT')
})

test('绑定：同一会话被别处持有 → SESSION_CONFLICT；换绑需 allowReplace', () => {
  const { service, a } = seed()
  const bound = service.bindDepartmentSession({ projectId: a.id, roleId: 'hubu', sessionId: 'sess-hubu-1' })
  assert.equal(bound.seat.connected, true)
  const conflict = expectCode(() => service.bindDepartmentSession({
    projectId: a.id,
    roleId: 'hubu',
    sessionId: 'sess-hubu-2',
  }), 'SESSION_CONFLICT')
  assert.equal(conflict.details.currentSessionId, 'sess-hubu-1')
  const replaced = service.bindDepartmentSession({
    projectId: a.id,
    roleId: 'hubu',
    sessionId: 'sess-hubu-2',
    allowReplace: true,
  })
  assert.equal(replaced.binding.bindingGeneration, 2)
  assert.equal(replaced.binding.historySessionRefs.length, 1, '旧会话进历史，不删除')
})

// ---------- 派发 ----------

test('dispatchTask 写 dispatch+contextPacket+attempt，同幂等键只一条', () => {
  const { store, service, a } = seed()
  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲目标', ownerRoleId: 'libu' }).task
  const first = service.dispatchTask({
    projectId: a.id,
    taskId: task.id,
    idempotencyKey: 'idem-1',
    packet: { excerpts: ['原始需求'], expectedOutputs: ['报告'] },
  })
  assert.equal(first.duplicate, false)
  assert.equal(first.dispatch.status, 'prepared')
  assert.equal(first.attempt.state, 'queued')
  assert.equal(first.attempt.sessionId, 'sess-a-libu')
  assert.equal(first.attempt.effectiveConfigSnapshot.provider, null)
  assert.equal(first.contextPacket.version, 1)
  assert.deepEqual(first.contextPacket.excerpts, ['原始需求'])

  const again = service.dispatchTask({ projectId: a.id, taskId: task.id, idempotencyKey: 'idem-1' })
  assert.equal(again.duplicate, true)
  assert.equal(again.dispatch.id, first.dispatch.id, '幂等命中返回原派发')
  assert.equal(again.attempt.id, first.attempt.id)
  assert.equal(store.state.dispatches.size, 1, '账本里只有一条派发')
  assert.equal(store.state.attempts.size, 1, '也为幂等，只有一条尝试')

  // 换个键：新派发，上下文包版本递增
  const second = service.dispatchTask({ projectId: a.id, taskId: task.id, idempotencyKey: 'idem-2' })
  assert.equal(second.duplicate, false)
  assert.equal(second.contextPacket.version, 2)
  assert.equal(store.state.dispatches.size, 2)
})

test('dispatchTask：未接通、已终态、目标与主责不一致都拒绝', () => {
  const { service, a } = seed()
  // 未接通会话的部门不能直接入队（默认 queued），只能先存草稿
  expectCode(() => service.createTask({ projectId: a.id, title: '丙', objective: '丙', ownerRoleId: 'hubu' }), 'INVALID_STATE')
  const task = service.createTask({ projectId: a.id, title: '甲', objective: '甲', ownerRoleId: 'hubu', status: 'draft' }).task
  expectCode(() => service.dispatchTask({ projectId: a.id, taskId: task.id, idempotencyKey: 'k' }), 'INVALID_STATE')
  const queued = service.createTask({ projectId: a.id, title: '乙', objective: '乙', ownerRoleId: 'libu' }).task
  expectCode(() => service.dispatchTask({
    projectId: a.id,
    taskId: queued.id,
    idempotencyKey: 'k2',
    targetRoleId: 'hubu',
  }), 'DISPATCH_INVALID')
  // 换绑后旧 bindingGeneration 派发失败
  const first = service.bindDepartmentSession({ projectId: a.id, roleId: 'hubu', sessionId: 'sess-hubu' })
  const fresh = service.createTask({ projectId: a.id, title: '丁', objective: '丁', ownerRoleId: 'hubu' }).task
  service.bindDepartmentSession({ projectId: a.id, roleId: 'hubu', sessionId: 'sess-hubu-2', allowReplace: true })
  const staleGeneration = first.binding.bindingGeneration
  expectCode(() => service.dispatchTask({
    projectId: a.id,
    taskId: fresh.id,
    idempotencyKey: 'k3',
    bindingGeneration: staleGeneration,
  }), 'SESSION_CONFLICT')
})

// ---------- 结果与完成判定 ----------

/** 建任务 → 派发 → 让任务进入 running，返回三件套。 */
function runningTask(ctx, projectId = ctx.a.id) {
  const task = ctx.service.createTask({ projectId, title: '任务', objective: '目标', ownerRoleId: 'libu' }).task
  const dispatched = ctx.service.dispatchTask({ projectId, taskId: task.id, idempotencyKey: `key-${task.id}` })
  const started = ctx.service.startAttempt({
    projectId,
    taskId: task.id,
    attemptId: dispatched.attempt.id,
    hostRunId: 'run-1',
  })
  return { task: started.task, attempt: dispatched.attempt, dispatch: dispatched.dispatch }
}

test('完成判定分支一：报告+终态成功+成果有效 → completed', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  const artifact = ctx.service.registerArtifact({ projectId: ctx.a.id, taskId: task.id, displayName: 'report.md' }).artifact
  const out = ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '已完成分析', artifactRefs: [artifact.id], checks: [{ name: '自检', ok: true }] },
    runTerminal: 'succeeded',
    sourceMessageRef: 'msg-1',
  })
  assert.equal(out.duplicate, false)
  assert.equal(out.decision.applied, true)
  assert.equal(out.decision.status, 'completed')
  assert.equal(out.task.status, 'completed')
  assert.ok(out.task.reportReceivedAt !== null)
  assert.ok(out.task.endedAt !== null)
})

test('完成判定分支二：终态成功但报告不可信 → needs_attention', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  const out = ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '看起来完成了', blockedReason: '缺少关键数据' },
    runTerminal: 'succeeded',
  })
  assert.equal(out.decision.status, 'needs_attention')
  assert.equal(out.task.status, 'needs_attention')
  assert.match(out.task.needsAttentionReason, /有效/)
  // needs_attention 不是完成：没有 completed 时间
  assert.equal(out.task.endedAt, null)
})

test('完成判定分支三：报告先到、宿主未结束 → 登记但不完成，终态后补齐', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  const first = ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '分析完成，等运行收尾' },
    runTerminal: 'running',
  })
  // 报告本身写进了账（status 不是 completed 就是证据），但任务没被判完成
  assert.equal(first.decision.status, 'running', '运行未结束不判完成')
  assert.equal(first.task.status, 'running')
  assert.ok(first.task.reportReceivedAt !== null, '报告先到时先登记报告时间（候选）')
  assert.ok(first.result.id.startsWith('res_'), '结果已登记为候选')
  // 终态后到：reportRunTerminal 把它推进到 completed
  const second = ctx.service.reportRunTerminal({ projectId: ctx.a.id, taskId: task.id, runTerminal: 'succeeded' })
  assert.equal(second.task.status, 'completed')
  assert.equal(second.decision.applied, true)
})

test('结果去重：同 (attemptId, reportVersion) 与同 sourceMessageRef 只登记一次', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  const payload = {
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '第一次提交' },
    runTerminal: 'succeeded',
    sourceMessageRef: 'msg-9',
  }
  const first = ctx.service.reportTaskResult(payload)
  assert.equal(first.duplicate, false)
  const revision = ctx.store.getTask(task.id).revision
  const second = ctx.service.reportTaskResult(payload)
  assert.equal(second.duplicate, true)
  assert.equal(second.result.id, first.result.id)
  assert.equal(second.decision.applied, false)
  assert.equal(ctx.store.getTask(task.id).revision, revision, '重复事件不改任务 revision')
  // 换 reportVersion 但同 sourceMessageRef：仍算重复
  const third = ctx.service.reportTaskResult({ ...payload, reportVersion: 2 })
  assert.equal(third.duplicate, true)
  assert.equal(ctx.store.listResults(undefined).filter((row) => row.taskId === task.id).length, 1)
})

test('结果：伪造成果引用被拒，不留半条结果', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  expectCode(() => ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '带假附件', artifactRefs: ['art_fake123'] },
    runTerminal: 'succeeded',
  }), 'NOT_FOUND')
  assert.equal(ctx.store.listResults(undefined).length, 0)
  expectCode(() => ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '   ' },
  }), 'INVALID_INPUT')
  expectCode(() => ctx.service.reportTaskResult({
    projectId: ctx.a.id,
    taskId: task.id,
    attemptId: attempt.id,
    report: { summary: '好' },
    runTerminal: 'done',
  }), 'INVALID_INPUT')
})

test('cancelTask：业务落 cancelled，运行中的尝试只到 cancel_requested', () => {
  const ctx = seed()
  const { task, attempt } = runningTask(ctx)
  const out = ctx.service.cancelTask({ projectId: ctx.a.id, taskId: task.id, reason: '不再需要' })
  assert.equal(out.task.status, 'cancelled')
  assert.equal(out.task.cancelReason, '不再需要')
  assert.equal(out.attempt.state, 'cancel_requested')
  assert.equal(out.cancelRequest.attemptId, attempt.id)
  assert.equal(out.cancelRequest.hostRunId, 'run-1')
  // 已终态再取消：applied=false，状态不变
  const again = ctx.service.cancelTask({ projectId: ctx.a.id, taskId: task.id })
  assert.equal(again.applied, false)
  assert.equal(again.task.status, 'cancelled')
})

test('requestTaskInput 进入 waiting_input，supplyTaskInput 回到 running', () => {
  const ctx = seed()
  const { task } = runningTask(ctx)
  const asked = ctx.service.requestTaskInput({
    projectId: ctx.a.id,
    taskId: task.id,
    reason: '缺少原始数据',
    missingItems: ['数据文件'],
  })
  assert.equal(asked.task.status, 'waiting_input')
  assert.equal(asked.task.waitingReason, '缺少原始数据')
  assert.deepEqual(asked.missingItems, ['数据文件'])
  const supplied = ctx.service.supplyTaskInput({ projectId: ctx.a.id, taskId: task.id })
  assert.equal(supplied.task.status, 'running')
})

test('syncDecision 只登记带来源的决定事件，不广播', () => {
  const ctx = seed()
  const { task } = runningTask(ctx)
  const out = ctx.service.syncDecision({
    projectId: ctx.a.id,
    taskId: task.id,
    content: '同意按方案 B 执行',
    sourceSessionId: 'sess-lead',
    roleId: 'lead',
  })
  assert.equal(out.event.type, 'decision.synced')
  assert.equal(out.event.payload.content, '同意按方案 B 执行')
  assert.equal(out.event.payload.sourceSessionId, 'sess-lead')
  assert.equal(out.task.id, task.id)
  expectCode(() => ctx.service.syncDecision({ projectId: ctx.a.id, content: '  ' }), 'INVALID_INPUT')
})

// ---------- 投影与事件 ----------

test('bootstrap 一次拿全且只含选中项目的数据', () => {
  const ctx = seed()
  const taskA = ctx.service.createTask({ projectId: ctx.a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task
  const taskB = ctx.service.createTask({ projectId: ctx.b.id, title: '乙', objective: '乙', ownerRoleId: 'libu' }).task
  const view = ctx.service.bootstrap(ctx.a.id)
  assert.equal(view.projectId, ctx.a.id)
  assert.equal(view.projects.length, 2)
  assert.equal(view.seats.length, 10)
  assert.deepEqual(view.tasks.map((row) => row.id), [taskA.id])
  assert.ok(!view.tasks.some((row) => row.id === taskB.id), '不串项目任务')
  assert.equal(view.eventSeq, ctx.store.eventSeq)
  // 不传 projectId 时取第一个项目
  const fallback = ctx.service.bootstrap()
  assert.equal(fallback.projectId, view.projects[0].id)
  expectCode(() => ctx.service.bootstrap('proj_ghost'), 'NOT_FOUND')
})

test('listEvents since 语义：只给新事件，越界给 reset', () => {
  const ctx = seed()
  const before = ctx.service.listEvents(ctx.a.id, 0)
  assert.ok(before.events.length > 0)
  assert.ok(before.events.every((row) => row.projectId === ctx.a.id), '只返回本项目事件')
  const last = before.seq
  const empty = ctx.service.listEvents(ctx.a.id, last)
  assert.equal(empty.events.length, 0)
  assert.equal(empty.seq, last)
  // 产生一条新事件，且只属于项目 A（项目 B 的事件不该出现在 A 的游标里）
  ctx.service.createTask({ projectId: ctx.a.id, title: '新', objective: '新', ownerRoleId: 'libu' })
  const mine = ctx.store.listEvents(ctx.a.id).filter((row) => row.seq > last)
  const after = ctx.service.listEvents(ctx.a.id, last)
  if (mine.length > 0) {
    assert.equal(after.events.length, mine.length)
    assert.deepEqual(after.events.map((row) => row.seq), mine.map((row) => row.seq))
  } else {
    assert.equal(after.events.length, 0)
  }
  assert.ok(after.events.every((row) => row.projectId === ctx.a.id))
  // 用当前 seq 当游标再问一次必须为空（since 语义是“严格大于”）
  assert.equal(ctx.service.listEvents(ctx.a.id, after.seq).events.length, 0)
  // since 超过当前 seq：账本被替换/回滚，前端应全量重拉
  const reset = ctx.service.listEvents(ctx.a.id, last + 9999)
  assert.equal(reset.reset, true)
})

test('成果登记与查询同样受项目隔离', () => {
  const ctx = seed()
  const task = ctx.service.createTask({ projectId: ctx.a.id, title: '甲', objective: '甲', ownerRoleId: 'libu' }).task
  const art = ctx.service.registerArtifact({
    projectId: ctx.a.id,
    taskId: task.id,
    displayName: '交付物',
    verification: { status: 'verified' },
  }).artifact
  assert.equal(ctx.service.getArtifact(ctx.a.id, art.id).displayName, '交付物')
  expectCode(() => ctx.service.getArtifact(ctx.b.id, art.id), 'CROSS_PROJECT')
  assert.equal(ctx.service.listArtifacts(ctx.b.id).length, 0)
})

test('未知部门与缺参数走 INVALID_ROLE / INVALID_INPUT', () => {
  const ctx = seed()
  expectCode(() => ctx.service.listTasks(ctx.a.id, { ownerRoleId: 'unknown' }), 'INVALID_ROLE')
  expectCode(() => ctx.service.createTask({ projectId: ctx.a.id, objective: 'x', ownerRoleId: 'libu' }), 'INVALID_INPUT')
  expectCode(() => ctx.service.createTask({ projectId: ctx.a.id, title: 'x', objective: 'y', ownerRoleId: 'hufu' }), 'INVALID_ROLE')
  expectCode(() => ctx.service.bindDepartmentSession({ projectId: ctx.a.id, roleId: 'libu', sessionId: '' }), 'INVALID_INPUT')
})

// ---------- A20：目录冲突 ----------

test('A20 同目录/父子目录登记成另一个项目时明确报冲突，不宣称隔离', () => {
  const { service } = makeService(seedOfCurrent())
  service.registerProject({ hostWorkspaceId: 'ws-a', canonicalRoot: 'C:\\work\\alpha' })
  // 大小写、分隔符、末尾斜杠都算同一目录
  const same = expectCode(
    () => service.registerProject({ hostWorkspaceId: 'ws-b', canonicalRoot: 'c:/work/alpha/' }),
    'DUPLICATE_PROJECT',
  )
  assert.equal(same.details.relation, 'same')
  assert.equal(same.details.otherHostWorkspaceId, 'ws-a')
  assert.equal(same.details.hint, 'allowSharedRoot')

  const nested = expectCode(
    () => service.registerProject({ hostWorkspaceId: 'ws-c', canonicalRoot: 'C:\\work\\alpha\\sub' }),
    'DUPLICATE_PROJECT',
  )
  assert.equal(nested.details.relation, 'nested')

  // 显式放行：仍然登记，但把识别到的关系带回去，让 UI 有话说
  const shared = service.registerProject({
    hostWorkspaceId: 'ws-d',
    canonicalRoot: 'C:\\work\\alpha',
    allowSharedRoot: true,
  })
  assert.equal(shared.duplicate, false)
  assert.equal(shared.sharedRoot.relation, 'same')

  // 不同目录互不干扰
  const other = service.registerProject({ hostWorkspaceId: 'ws-e', canonicalRoot: 'D:\\other' })
  assert.equal(other.duplicate, false)
  assert.equal(other.sharedRoot, null)
  // 无关目录不该被误判为同一个：alpha 与 alphabeta 是不同目录
  const notPrefix = service.registerProject({ hostWorkspaceId: 'ws-f', canonicalRoot: 'C:\\work\\alphabeta' })
  assert.equal(notPrefix.duplicate, false)
})

// ---------- A22 / A23：成果修订与失效显示 ----------

test('A22 成果修订只开一条修订任务给原主责部门，派发自带原成果引用', () => {
  const ctx = seed()
  const task = ctx.service.createTask({
    projectId: ctx.a.id, ownerRoleId: 'libu', title: '写报告', objective: '产出报告',
  }).task
  const artifact = ctx.service.registerArtifact({
    projectId: ctx.a.id, taskId: task.id, fileRef: 'C:/work/a/report.md', displayName: '报告',
  }).artifact
  assert.equal(artifact.revision, 1)

  const revised = ctx.service.requestArtifactRevision({
    projectId: ctx.a.id, artifactId: artifact.id, instruction: '只改第三节的结论',
  })
  assert.equal(revised.task.kind, 'revision')
  assert.equal(revised.task.ownerRoleId, 'libu', '仍归原主责部门，不重跑整套三省')
  assert.equal(revised.task.sourceRoleId, 'lead')
  assert.equal(revised.task.reviseOfArtifactId, artifact.id)
  assert.equal(revised.task.artifactRevision, 1)
  assert.equal(revised.task.scope.kind, 'artifact-revision')
  assert.equal(revised.task.objective, '只改第三节的结论')
  assert.equal(revised.task.status, 'draft', '默认草稿：不替用户立刻派工')

  // 派发时若没显式给 materialRefs，自动带上「哪份成果的哪一版」
  const dispatched = ctx.service.dispatchTask({
    projectId: ctx.a.id, taskId: revised.task.id, targetRoleId: 'libu', idempotencyKey: 'rev-1',
  })
  assert.deepEqual(dispatched.contextPacket.materialRefs, [{ artifactId: artifact.id, revision: 1, title: "报告" }])

  // 新成果接到旧成果上：版本 +1，且跨项目修订被拒
  const next = ctx.service.registerArtifact({
    projectId: ctx.a.id, taskId: revised.task.id, fileRef: 'C:/work/a/report-v2.md',
    displayName: '报告 v2', revisesArtifactId: artifact.id,
  }).artifact
  assert.equal(next.revision, 2)
  assert.equal(next.revisesArtifactId, artifact.id)

  const bTask = ctx.service.createTask({ projectId: ctx.b.id, ownerRoleId: 'libu', title: 'b', objective: 'b' }).task
  const foreign = ctx.service.registerArtifact({ projectId: ctx.b.id, taskId: bTask.id }).artifact
  expectCode(
    () => ctx.service.registerArtifact({ projectId: ctx.a.id, taskId: task.id, revisesArtifactId: foreign.id }),
    'CROSS_PROJECT',
  )
})

test('A23 成果文件不见了显示 missing，探不了就是 unknown，绝不猜成 ok', () => {
  const { store } = makeService(seedOfCurrent())
  // 文件系统由宿主注入：这里只验投影怎么读结论
  const existing = new Set(['C:/work/keep.md'])
  const service = createWorkbenchService({
    store, clock: () => FIXED_NOW, fileExists: (path) => existing.has(path),
  })
  const project = service.registerProject({ hostWorkspaceId: 'ws-a' }).project
  service.bindDepartmentSession({ projectId: project.id, roleId: 'libu', sessionId: 'sess-a-libu' })
  const task = service.createTask({ projectId: project.id, ownerRoleId: 'libu', title: 't', objective: 'o' }).task
  const kept = service.registerArtifact({ projectId: project.id, taskId: task.id, fileRef: 'C:/work/keep.md' }).artifact
  const gone = service.registerArtifact({ projectId: project.id, taskId: task.id, fileRef: 'C:/work/gone.md' }).artifact
  const remote = service.registerArtifact({ projectId: project.id, taskId: task.id, fileRef: null }).artifact

  assert.equal(kept.existence, 'ok')
  assert.equal(gone.existence, 'missing')
  assert.equal(remote.existence, 'unknown', '没有本地路径就不下结论')

  const boot = service.bootstrap(project.id)
  assert.deepEqual(boot.artifacts.map((row) => row.existence), ['ok', 'missing', 'unknown'])
  // 账本不因“文件没了”被改写：历史仍留着
  assert.equal(store.listArtifacts(project.id).length, 3)
  assert.equal(store.listArtifacts(project.id)[1].fileRef, 'C:/work/gone.md')
})

test('草稿直接派工会先入队，不会出现「消息已发、账上不前进」', () => {
  const { store, service } = makeService(seedOfCurrent())
  const project = service.registerProject({ hostWorkspaceId: 'ws-draft', displayNameCache: '草稿项目' }).project
  const binding = service.bindDepartmentSession({ projectId: project.id, roleId: 'gongbu', sessionId: 'ses_draft_gongbu' })

  // 界面上的真实路径：先存草稿，再点派工。
  const draft = service.createTask({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: '草稿直派',
    objective: '确认草稿派工会先入队',
    status: 'draft',
  }).task
  assert.equal(draft.status, 'draft')

  const result = service.dispatchTask({
    projectId: project.id,
    taskId: draft.id,
    idempotencyKey: 'ui:' + draft.id,
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_draft_gongbu',
    bindingGeneration: binding.binding.bindingGeneration,
  })

  // 派发记录落地，任务也从 draft 推进到 queued（否则 beginAttempt 会拒绝）。
  assert.ok(result.dispatch && result.dispatch.id)
  const after = store.getTask(draft.id)
  assert.equal(after.status, 'queued')
  assert.ok(after.queuedAt)
  // 同一个幂等键再派一次：返回既有记录，不新建第二条。
  const again = service.dispatchTask({
    projectId: project.id,
    taskId: draft.id,
    idempotencyKey: 'ui:' + draft.id,
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_draft_gongbu',
    bindingGeneration: binding.binding.bindingGeneration,
  })
  assert.equal(again.duplicate, true)
  assert.equal(again.dispatch.id, result.dispatch.id)
})
