// 任务生命周期测试：重点验证「完成判定三分支」与乱序/重复事件不回退状态。
// 这些是 v0.1 最容易出错的地方，全部用纯函数直接断言，不依赖 store 或宿主。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TaskError,
  TASK_TRANSITIONS,
  isStaleSeq,
  isRegressingEvent,
  createTask,
  startTask,
  beginAttempt,
  validateReport,
  checkCompletion,
  evaluateCompletion,
  decide,
  requestInput,
  supplyInput,
  completeTask,
  failTask,
  cancelTask,
  applyDecision,
  isOpenTask,
} from '../core/tasks.mjs'
import { WorkbenchStore } from '../core/store.mjs'

const clock = () => 1700000000000

function draftTask(overrides = {}) {
  return createTask(
    {
      projectId: 'proj_a',
      title: '整理季度报表',
      objective: '把三份表合并成一份差异表',
      ownerRoleId: 'hubu',
      sourceRoleId: 'zhongshu',
      ...overrides,
    },
    { newTaskId: () => 'task_1', now: clock },
  )
}

function runningTask() {
  const task = startTask(draftTask(), { now: clock })
  return beginAttempt(task, { id: 'att_1', projectId: 'proj_a', taskId: 'task_1' }, { now: clock })
}

const goodReport = {
  attemptId: 'att_1',
  taskId: 'task_1',
  summary: '差异 12 处，已附差异表',
  checks: [{ name: '数量核对', ok: true }],
  artifactRefs: ['art_1'],
}

test('createTask 只建草稿，缺字段或未知席直接拒绝', () => {
  const task = draftTask()
  assert.equal(task.status, 'draft')
  assert.equal(task.ownerRoleId, 'hubu')
  assert.equal(task.sourceRoleId, 'zhongshu')
  assert.equal(task.activeAttemptId, null)
  assert.equal(task.revision, 1)
  assert.deepEqual(task.attempts, [])
  assert.throws(() => createTask({ title: 'x', objective: 'y', ownerRoleId: 'hubu' }), TaskError)
  assert.throws(() => draftTask({ ownerRoleId: 'hufu' }), /未知主责部门/)
  assert.throws(() => draftTask({ sourceRoleId: 'nobody' }), /未知来源部门/)
  assert.throws(() => draftTask({ objective: '  ' }), /objective/)
})

test('TASK_TRANSITIONS 与方案一致且不可变', () => {
  assert.ok(Object.isFrozen(TASK_TRANSITIONS))
  const pairs = TASK_TRANSITIONS.map(([from, to]) => `${from}->${to}`)
  for (const expected of ['draft->queued', 'running->completed', 'running->needs_attention', 'needs_attention->completed', 'waiting_input->running']) {
    assert.ok(pairs.includes(expected), `缺少迁移 ${expected}`)
  }
  assert.ok(!pairs.includes('completed->running'), '终态不能被复活')
  assert.ok(Object.isFrozen(TASK_TRANSITIONS[0]))
})

test('startTask 只从草稿或待补充入队', () => {
  const queued = startTask(draftTask(), { now: clock })
  assert.equal(queued.status, 'queued')
  assert.equal(queued.revision, 2)
  assert.throws(() => startTask(queued), /只有草稿或待补充/)
  const waiting = requestInput(runningTask(), '缺少上月口径', { now: clock }).task
  assert.equal(waiting.status, 'waiting_input')
  assert.equal(startTask(waiting, { now: clock }).status, 'queued')
})

test('beginAttempt 绑定新尝试并保留历史', () => {
  const task = runningTask()
  assert.equal(task.status, 'running')
  assert.equal(task.activeAttemptId, 'att_1')
  assert.deepEqual(task.attempts, ['att_1'])
  // 旧尝试仍活跃时不允许并发换绑：先对账再重试
  assert.throws(
    () => beginAttempt(task, { id: 'att_2', projectId: 'proj_a', taskId: 'task_1' }),
    (error) => error.code === 'ACTIVE_ATTEMPT',
  )
  const settled = { ...task, activeAttemptId: null, status: 'needs_attention' }
  const retried = beginAttempt(settled, { id: 'att_2', projectId: 'proj_a', taskId: 'task_1' }, { now: clock })
  assert.equal(retried.activeAttemptId, 'att_2')
  assert.deepEqual(retried.attempts, ['att_1', 'att_2'], '旧尝试不能被覆盖')
  assert.throws(() => beginAttempt({ ...task, status: 'completed' }, { id: 'att_3', projectId: 'proj_a', taskId: 'task_1' }), /不能开始新的尝试/)
  assert.throws(
    () => beginAttempt({ ...task, status: 'queued' }, { id: 'att_2', projectId: 'proj_b', taskId: 'task_1' }),
    /不属于同一项目/,
  )
  assert.throws(
    () => beginAttempt({ ...task, status: 'queued' }, { id: 'att_2', projectId: 'proj_a', taskId: 'task_9' }),
    /别的任务/,
  )
  assert.throws(() => beginAttempt({ ...task, status: 'queued' }, null), /尝试记录不合法/)
})

test('beginAttempt 不再被已取消的旧尝试挡住重试', () => {
  const running = runningTask()
  // 取消后 activeAttemptId 仍指向旧尝试（保留审计），旧 Attempt 已转 cancelled 终态 → 允许重试
  const cancelledLookup = (id) => ({ id, state: 'cancelled' })
  const next = { id: 'att_2', projectId: 'proj_a', taskId: 'task_1' }
  const retried = beginAttempt(running, next, { now: clock, attemptLookup: cancelledLookup })
  assert.equal(retried.status, 'running')
  assert.equal(retried.activeAttemptId, 'att_2')
  assert.deepEqual(retried.attempts, ['att_1', 'att_2'], '旧尝试保留在历史里')
  // running 但当前尝试已 unknown/failed/succeeded 终态时同样放行
  for (const state of ['failed', 'succeeded']) {
    assert.equal(beginAttempt(running, next, { now: clock, attemptLookup: (id) => ({ id, state }) }).activeAttemptId, 'att_2')
  }
  // needs_attention 下旧尝试已取消：不被 ACTIVE_ATTEMPT 挡住
  const needsAttention = { ...running, status: 'needs_attention' }
  const retriedAfterCancel = beginAttempt(needsAttention, next, { now: clock, attemptLookup: cancelledLookup })
  assert.equal(retriedAfterCancel.status, 'running')
  assert.equal(retriedAfterCancel.needsAttentionReason, null)
  // 旧尝试 still running / unknown / cancel_requested：仍在活动，必须挡住
  const queuedAttempt = (id) => ({ id, state: 'queued' })
  const unknownAttempt = (id) => ({ id, state: 'unknown' })
  for (const lookup of [queuedAttempt, unknownAttempt]) {
    assert.throws(
      () => beginAttempt(running, next, { now: clock, attemptLookup: lookup }),
      (error) => error.code === 'ACTIVE_ATTEMPT',
    )
    assert.throws(
      () => beginAttempt(needsAttention, next, { now: clock, attemptLookup: lookup }),
      (error) => error.code === 'ACTIVE_ATTEMPT',
    )
  }
  // 不注入 attemptLookup 时无法证明旧尝试已对账 → 保持旧行为（非空即挡）
  assert.throws(
    () => beginAttempt(running, next, { now: clock }),
    (error) => error.code === 'ACTIVE_ATTEMPT',
  )
  // needs_attention 且 activeAttemptId 为空 → 本来就不受影响
  assert.equal(beginAttempt({ ...running, activeAttemptId: null, status: 'needs_attention' }, next, { now: clock }).activeAttemptId, 'att_2')
})

test('validateReport 只认结构化字段', () => {
  assert.deepEqual(validateReport(goodReport), [])
  assert.deepEqual(validateReport({ attemptId: 'a', taskId: 't', summary: 's' }), [])
  assert.deepEqual(validateReport(null), ['报告必须是对象'])
  const errors = validateReport({ summary: '  ', artifactRefs: ['res_1'], checks: 'ok' })
  assert.ok(errors.some((row) => row.includes('attemptId')))
  assert.ok(errors.some((row) => row.includes('taskId')))
  assert.ok(errors.some((row) => row.includes('摘要为空')))
  assert.ok(errors.some((row) => row.includes('成果引用形状非法')))
  assert.ok(errors.some((row) => row.includes('checks 必须是数组')))
  assert.ok(validateReport({ attemptId: 'a', taskId: 't', summary: 's', artifactRefs: 'art_1' }).some((row) => row.includes('artifactRefs')))
})

test('checkCompletion 三条条件各占一票', () => {
  const all = checkCompletion({ report: goodReport, runTerminal: 'succeeded', artifactRefs: ['art_1'], artifactLookup: () => ({ id: 'art_1' }) })
  assert.deepEqual(all, { reportOk: true, runOk: true, refsValid: true, blockers: [], ok: true })

  const noReport = checkCompletion({ report: null, runTerminal: 'succeeded' })
  assert.equal(noReport.reportOk, false)
  assert.equal(noReport.ok, false)
  assert.ok(noReport.blockers.includes('未收到结构化报告'))

  const noTerminal = checkCompletion({ report: goodReport, runTerminal: null })
  assert.equal(noTerminal.runOk, false)
  assert.ok(noTerminal.blockers.includes('宿主运行尚未结束'))

  const failedRun = checkCompletion({ report: goodReport, runTerminal: 'failed' })
  assert.equal(failedRun.runOk, false)
  assert.ok(failedRun.blockers.some((row) => row.includes('failed')))

  const blocked = checkCompletion({ report: { ...goodReport, blockedReason: '缺权限' }, runTerminal: 'succeeded' })
  assert.equal(blocked.reportOk, false)

  const danglingRef = checkCompletion({ report: goodReport, runTerminal: 'succeeded', artifactRefs: ['art_1'], artifactLookup: () => undefined })
  assert.equal(danglingRef.refsValid, false)
  assert.ok(danglingRef.blockers.some((row) => row.includes('成果引用无效')))

  const missingArtifact = checkCompletion({ report: goodReport, runTerminal: 'succeeded', artifactRefs: ['art_1'], artifactLookup: () => ({ id: 'art_1', verification: { status: 'missing' } }) })
  assert.equal(missingArtifact.refsValid, false)

  // 纯分析任务允许无附件：空引用不算失败
  assert.equal(checkCompletion({ report: goodReport, runTerminal: 'succeeded', artifactRefs: [] }).ok, true)
})

test('完成判定三分支：三者齐全 → completed', () => {
  const decision = evaluateCompletion(
    runningTask(),
    { report: goodReport, runTerminal: 'succeeded', artifactRefs: ['art_1'], artifactLookup: () => ({ id: 'art_1' }) },
    { now: clock },
  )
  assert.equal(decision.applied, true)
  assert.equal(decision.task.status, 'completed')
  assert.ok(decision.task.reportReceivedAt)
  assert.equal(decision.task.needsAttentionReason, null)
})

test('完成判定三分支：只有报告 → 等待，不置 completed', () => {
  // 报告先到：保存候选结果，等宿主终态
  const reported = decide(runningTask(), { kind: 'report', report: goodReport }, { now: clock })
  assert.equal(reported.applied, true)
  assert.equal(reported.task.status, 'running', '报告先到不得直接置完成')
  assert.ok(reported.task.reportReceivedAt !== null)

  // 只有报告、终态尚未到达 —— 保持 running
  const pending = evaluateCompletion(runningTask(), { report: goodReport, runTerminal: null })
  assert.equal(pending.applied, false)
  assert.equal(pending.task.status, 'running')
  assert.ok(pending.reason.includes('宿主运行尚未结束'))

  // 报告到达后终态成功 → 顺理成章完成
  const finished = decide(reported.task, { kind: 'run_terminal', runTerminal: 'succeeded' }, { now: clock })
  assert.equal(finished.applied, true)
  assert.equal(finished.task.status, 'completed')
})

test('完成判定三分支：只有终态 → needs_attention', () => {
  // 宿主运行先结束但无报告
  const onlyTerminal = evaluateCompletion(runningTask(), { report: null, runTerminal: 'succeeded' }, { now: clock })
  assert.equal(onlyTerminal.applied, true)
  assert.equal(onlyTerminal.task.status, 'needs_attention')
  assert.match(onlyTerminal.task.needsAttentionReason, /没有有效的结构化报告/)

  // 运行失败同样进入 needs_attention，而不是 completed
  const failed = decide(runningTask(), { kind: 'run_terminal', runTerminal: 'failed' }, { now: clock })
  assert.equal(failed.task.status, 'needs_attention')
  assert.match(failed.task.needsAttentionReason, /failed/)

  // 终态成功但报告不完整：也不能置完成，最多进入 needs_attention 等补报
  const partial = evaluateCompletion(runningTask(), { report: { attemptId: 'att_1' }, runTerminal: 'succeeded' })
  assert.notEqual(partial.task.status, 'completed')
  assert.equal(partial.task.status, 'needs_attention')
})

test('运行终态为 cancelled 时任务直接取消', () => {
  const decision = decide(runningTask(), { kind: 'run_terminal', runTerminal: 'cancelled' }, { now: clock })
  assert.equal(decision.task.status, 'cancelled')
  assert.ok(decision.task.endedAt)
})

test('乱序事件：旧 seq 不回退，迟到 running 不覆盖终态', () => {
  assert.equal(isStaleSeq(null, 5), false)
  assert.equal(isStaleSeq(5, 5), true, '同 seq 视为重复')
  assert.equal(isStaleSeq(5, 4), true)
  assert.equal(isStaleSeq(5, 6), false)
  assert.equal(isStaleSeq(5, Number.NaN), true)

  const withSeq = { ...runningTask(), lastSeq: 10 }
  const stale = decide(withSeq, { kind: 'input_required', reason: '旧事件', seq: 9 }, { now: clock })
  assert.equal(stale.applied, false)
  assert.equal(stale.stale, true)
  assert.equal(stale.task.status, 'running')

  const done = evaluateCompletion(
    { ...withSeq, lastSeq: 11 },
    { report: goodReport, runTerminal: 'succeeded', seq: 12 },
    { now: clock },
  )
  assert.equal(done.task.status, 'completed')
  assert.equal(done.task.lastSeq, 12)

  const late = decide(done.task, { kind: 'input_required', reason: '迟到的求助', seq: 13 }, { now: clock })
  assert.equal(late.applied, false)
  assert.equal(late.task.status, 'completed', '终态不能被迟到事件覆盖')
  // 终态之后即使 seq 更大也只记 no-op：调用方据此知道「没有状态变化」
  assert.match(late.reason, /不接受|已终态/)

  assert.equal(isRegressingEvent('completed', 'running'), true)
  assert.equal(isRegressingEvent('completed', 'completed'), false)
  assert.equal(isRegressingEvent('running', 'running'), false)
})

test('waiting_input 往返与非法事件', () => {
  const asked = requestInput(runningTask(), '缺口径', { now: clock })
  assert.equal(asked.task.status, 'waiting_input')
  assert.equal(asked.task.waitingReason, '缺口径')
  const back = supplyInput(asked.task, { now: clock })
  assert.equal(back.task.status, 'running')
  assert.equal(back.task.waitingReason, null)
  assert.equal(supplyInput(back.task).applied, false, '不在待补充时忽略')
  assert.equal(requestInput(draftTask(), 'x').applied, false)
  assert.throws(() => decide(runningTask(), { kind: 'nope' }), /未知事件类型/)
  assert.throws(() => decide(runningTask(), null), /事件必须是对象/)
  assert.throws(() => decide({}, { kind: 'report' }), /任务记录不合法/)
  assert.throws(
    () => decide(runningTask(), { kind: 'report', report: { summary: '' } }),
    (error) => error.code === 'INVALID_REPORT',
  )
  assert.throws(
    () => decide({ ...runningTask(), status: 'failed' }, { kind: 'retry' }),
    (error) => error.code === 'RETRY_REQUIRES_NEW_TASK',
  )
  assert.equal(decide(runningTask(), { kind: 'retry' }).applied, false)
})

test('failTask 必须带原因，终态后忽略', () => {
  const failed = failTask(runningTask(), '模型超时', { now: clock })
  assert.equal(failed.task.status, 'failed')
  assert.equal(failed.task.failureReason, '模型超时')
  assert.ok(failed.task.endedAt)
  assert.throws(() => failTask(runningTask(), '  '), /reason/)
  assert.equal(failTask(failed.task, 'again').applied, false)
})

test('cancelTask 记录取消原因且只写一次结束时间', () => {
  const cancelled = cancelTask(runningTask(), '用户点了取消', { now: clock })
  assert.equal(cancelled.task.status, 'cancelled')
  assert.equal(cancelled.task.cancelReason, '用户点了取消')
  const again = cancelTask(cancelled.task, '重复取消')
  assert.equal(again.applied, false)
  assert.equal(again.task.endedAt, cancelled.task.endedAt)
  assert.equal(cancelTask(draftTask()).task.cancelReason, '用户取消')
})

test('completeTask 是 completion 事件的便捷包装', () => {
  const decision = completeTask(
    runningTask(),
    { report: goodReport, runTerminal: 'succeeded', artifactRefs: ['art_1'], artifactLookup: () => ({ id: 'art_1' }), seq: 3 },
  )
  assert.equal(decision.task.status, 'completed')
  assert.equal(decision.task.lastSeq, 3)
})

test('applyDecision 只在 applied 时落库', () => {
  const store = new WorkbenchStore({ file: null, clock, random: () => 3 })
  const projectId = store.createProject({ hostWorkspaceId: 'ws-a' })
  const created = createTask(
    { projectId, title: 't', objective: 'o', ownerRoleId: 'hubu' },
    { newTaskId: () => 'task_1', now: clock },
  )
  store.insertTask(created)
  const queued = startTask(store.getTask('task_1'), { now: clock })
  const stale = applyDecision(store, 'task_1', { applied: false, stale: true, task: created })
  assert.equal(stale.applied, false)
  assert.equal(store.getTask('task_1').revision, 1, '陈旧事件不得产生版本抖动')

  const started = applyDecision(store, 'task_1', { applied: true, stale: false, task: queued })
  assert.equal(started.task.status, 'queued')
  assert.equal(store.getTask('task_1').status, 'queued')
  // null 会被默认参数换成 undefined，所以显式传 undefined 才能走到 store 校验
  assert.throws(() => applyDecision(undefined, 'task_1', {}), /需要 store/)
  // 未启用的事件不得落库：返回原判定，store 保持 revision 不变
  assert.equal(applyDecision(store, 'task_1', { applied: false, task: queued }).task.status, 'queued')
  assert.throws(() => applyDecision(store, 'task_1', null), /判定结果不合法/)
})

test('isOpenTask 区分终态与活动态', () => {
  assert.equal(isOpenTask(draftTask()), true)
  assert.equal(isOpenTask(cancelTask(draftTask()).task), false)
  assert.equal(isOpenTask(null), false)
  assert.equal(isOpenTask({ status: 'bogus' }), false)
})
