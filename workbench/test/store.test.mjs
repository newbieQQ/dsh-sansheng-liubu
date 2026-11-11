import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION, StoreError, WorkbenchStore, defaultStorePath, entityOf } from '../core/store.mjs'
import { createIdFactory } from '../core/ids.mjs'

/** 固定随机源和时钟：随机源按调用递增，保证 ID 可复现且互不相同。 */
function makeStore(file = null) {
  let cursor = 0
  return new WorkbenchStore({
    file,
    clock: () => Date.parse('2026-11-09T12:00:00.000Z'),
    random: () => cursor++,
  })
}

function mkStore() {
  const store = makeStore()
  const a = store.createProject({ hostWorkspaceId: 'ws-a', displayNameCache: '项目A' })
  const b = store.createProject({ hostWorkspaceId: 'ws-b', displayNameCache: '项目B' })
  return { store, a, b }
}

test('createProject seeds ten empty seats without sessions', () => {
  const { store, a } = mkStore()
  assert.match(a, /^proj_/)
  assert.equal(store.listProjects().length, 2)
  const bindings = store.listBindings(a)
  assert.equal(bindings.length, 10)
  assert.ok(bindings.every((row) => row.currentSessionId === null && row.status === 'uninitialized'))
  assert.ok(store.listConfigs(a).every((row) => row.providerId === null && row.configRevision === 0))
  assert.equal(store.revision, 2, '每次提交递增 revision')
  assert.equal(store.eventSeq, 2, '事件日志追加 seq')
  assert.deepEqual(store.listEvents(a).map((row) => row.type), ['project.created'])
  assert.throws(() => store.createProject({ hostWorkspaceId: 'ws-a' }), /已登记/)
  assert.throws(() => store.createProject({ hostWorkspaceId: '  ' }), /非空字符串/)
  assert.throws(() => store.bindSession(a, 'hufu', 's1'), /未知角色/)
})

test('one active binding per (projectId, roleId)', () => {
  const { store, a } = mkStore()
  const bound = store.bindSession(a, 'gongbu', 'sess-1')
  assert.equal(bound.bindingGeneration, 1)
  assert.equal(bound.currentSessionId, 'sess-1')
  assert.equal(store.getBinding(a, 'gongbu').currentSessionId, 'sess-1')
  // 同一 (project, role) 的两个绑定行不可能同时存在：键就是 (projectId, roleId)。
  const rows = store.listBindings(a).filter((row) => row.roleId === 'gongbu')
  assert.equal(rows.length, 1)
  // 同一部门换绑走 releaseBinding，旧会话进历史而不是悄悄被覆盖。
  const rebound = store.bindSession(a, 'gongbu', 'sess-2', { allowReplace: true })
  assert.equal(rebound.currentSessionId, 'sess-2')
  assert.equal(rebound.bindingGeneration, 2)
  assert.deepEqual(rebound.historySessionRefs.map((row) => row.sessionId), ['sess-1'])
})

test('binding requires the old session to be released before it is reused', () => {
  const { store, a } = mkStore()
  store.bindSession(a, 'gongbu', 'sess-1')
  assert.throws(() => store.bindSession(a, 'gongbu', 'sess-1'), /无需重复绑定/)
  assert.equal(store.getBinding(a, 'gongbu').bindingGeneration, 1)
})

test('a session id cannot be bound to two different (projectId, roleId)', () => {
  const { store, a, b } = mkStore()
  store.bindSession(a, 'gongbu', 'sess-1')
  assert.throws(() => store.bindSession(a, 'libu', 'sess-1'), /SESSION_CONFLICT|已绑定/)
  assert.throws(() => store.bindSession(b, 'gongbu', 'sess-1'), /已绑定/)
  // 释放后旧会话进入 historySessionRefs，不删除历史，且可绑定到别处。
  const released = store.releaseBinding(a, 'gongbu')
  assert.equal(released.currentSessionId, null)
  assert.equal(released.historySessionRefs.length, 1)
  assert.equal(released.historySessionRefs[0].sessionId, 'sess-1')
  const moved = store.bindSession(b, 'gongbu', 'sess-1')
  assert.equal(moved.currentSessionId, 'sess-1')
  assert.equal(moved.bindingGeneration, 1)
})

test('rebinding bumps bindingGeneration so old dispatches stay pinned', () => {
  const { store, a } = mkStore()
  store.bindSession(a, 'gongbu', 'sess-1')
  store.releaseBinding(a, 'gongbu')
  const next = store.bindSession(a, 'gongbu', 'sess-2')
  assert.equal(next.bindingGeneration, 2)
  assert.deepEqual(store.getBinding(a, 'gongbu').historySessionRefs.map((row) => row.sessionId), ['sess-1'])
  assert.throws(() => store.setBindingStatus(a, 'gongbu', 'completed'), /目标状态非法/)
  assert.equal(store.setBindingStatus(a, 'gongbu', 'unavailable').status, 'unavailable')
})

test('configuration CAS rejects stale writers and returns the current value', () => {
  const { store, a, b } = mkStore()
  const first = store.saveConfig(a, 'gongbu', { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }, 0)
  assert.equal(first.configRevision, 1)
  assert.equal(first.providerId, 'deepseek')
  assert.throws(
    () => store.saveConfig(a, 'gongbu', { provider: 'openai', model: 'gpt', reasoningEffort: null }, 0),
    (error) => {
      assert.equal(error.code, 'CAS_CONFLICT')
      assert.equal(error.details.currentRevision, 1)
      assert.deepEqual(error.details.current, { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
      return true
    },
  )
  // 冲突不写账：revision 与配置保持原样
  assert.equal(store.getConfig(a, 'gongbu').providerId, 'deepseek')
  // 另一项目另一部门互不影响
  assert.equal(store.getConfig(b, 'gongbu').configRevision, 0)
  const second = store.saveConfig(a, 'gongbu', { provider: 'openai', model: 'gpt' }, 1)
  assert.equal(second.configRevision, 2)
  assert.equal(second.reasoningEffort, null, '缺省 effort 落 null，不透传 undefined')
  assert.throws(() => store.saveConfig(a, 'gongbu', { provider: 'x', model: 'y' }, '1'), /expectedRevision/)
  assert.throws(() => store.saveConfig(a, 'gongbu', { provider: 'x' }, 2), /model/)
})

test('dispatch idempotency key returns the existing record', () => {
  const { store, a } = mkStore()
  const first = store.recordDispatch({ projectId: a, idempotencyKey: 'k-1', taskId: null })
  assert.equal(first.duplicate, false)
  assert.match(first.dispatch.id, /^dsp_/)
  const again = store.recordDispatch({ projectId: a, idempotencyKey: 'k-1' })
  assert.equal(again.duplicate, true)
  assert.equal(again.dispatch.id, first.dispatch.id)
  assert.equal([...store.state.dispatches.values()].length, 1, '重复点击只留一条派发')
  // 幂等键按项目隔离：另一项目同键是另一件事。
  const { b } = { b: store.listProjects()[1].id }
  assert.equal(store.recordDispatch({ projectId: b, idempotencyKey: 'k-1' }).duplicate, false)
  // 状态推进走状态机
  const accepted = store.updateDispatch(first.dispatch.id, { status: 'sending' })
  assert.equal(accepted.status, 'sending')
  assert.throws(() => store.updateDispatch(first.dispatch.id, { status: 'proposed' }), /目标状态非法/)
  assert.throws(() => store.updateDispatch(first.dispatch.id, { status: 'prepared' }), /不允许/)
})

test('recordResult deduplicates duplicate completion events', () => {
  const { store, a } = mkStore()
  const task = store.insertTask({ projectId: a, ownerRoleId: 'gongbu', sourceRoleId: 'lead', status: 'draft' })
  const attempt = store.insertAttempt({ projectId: a, taskId: task.id, state: 'running' })
  const base = { projectId: a, taskId: task.id, attemptId: attempt.id, summary: '完成', reportVersion: 1 }
  const first = store.recordResult(base)
  assert.equal(first.duplicate, false)
  assert.match(first.result.id, /^res_/)
  const dupVersion = store.recordResult(base)
  assert.equal(dupVersion.duplicate, true)
  assert.equal(dupVersion.result.id, first.result.id)
  // 同一源消息的重复事件同样只登记一次
  const dupMessage = store.recordResult({ ...base, reportVersion: 2, sourceMessageRef: 'msg-1' })
  assert.equal(dupMessage.duplicate, false)
  const dupMessageAgain = store.recordResult({ ...base, reportVersion: 3, sourceMessageRef: 'msg-1' })
  assert.equal(dupMessageAgain.duplicate, true)
  assert.equal(store.listResults(task.id).length, 2)
})

test('cross-project references are rejected on write', () => {
  const { store, a, b } = mkStore()
  const taskA = store.insertTask({ projectId: a, ownerRoleId: 'gongbu', sourceRoleId: 'lead', status: 'draft' })
  assert.throws(
    () => store.insertAttempt({ projectId: b, taskId: taskA.id, state: 'queued' }),
    (error) => error.code === 'CROSS_PROJECT',
  )
  const attemptA = store.insertAttempt({ projectId: a, taskId: taskA.id, state: 'running' })
  assert.throws(
    () => store.recordResult({ projectId: b, taskId: null, attemptId: attemptA.id, summary: 'x' }),
    (error) => error.code === 'CROSS_PROJECT',
  )
  assert.equal(store.listResults().length, 0, '被拒绝的写入不落账')
})

test('cross-project recordResult and artifacts are refused', () => {
  const { store, a, b } = mkStore()
  const taskA = store.insertTask({ projectId: a, ownerRoleId: 'gongbu', sourceRoleId: 'lead', status: 'draft' })
  const attemptA = store.insertAttempt({ projectId: a, taskId: taskA.id, state: 'running' })
  assert.throws(
    () => store.recordResult({ projectId: b, attemptId: attemptA.id, summary: 'x' }),
    (error) => error.code === 'CROSS_PROJECT',
  )
  const resultA = store.recordResult({ projectId: a, taskId: taskA.id, attemptId: attemptA.id, summary: 'ok' })
  assert.throws(
    () => store.recordArtifact({ projectId: b, taskId: taskA.id, ownerRoleId: 'gongbu', sourceResultId: resultA.result.id }),
    (error) => error.code === 'CROSS_PROJECT',
  )
  const artifact = store.recordArtifact({ projectId: a, taskId: taskA.id, ownerRoleId: 'gongbu', sourceResultId: resultA.result.id })
  assert.match(artifact.id, /^art_/)
  assert.throws(() => store.insertContextPacket({ projectId: b, taskId: taskA.id }), /CROSS_PROJECT|跨项目/)
  assert.throws(() => store.assertProjectOwns(b, 'tasks', taskA.id), /不属于项目/)
  assert.throws(() => store.assertProjectOwns(a, 'tasks', 'task_missing'), /不存在/)
  assert.equal(store.assertProjectOwns(a, 'tasks', taskA.id).id, taskA.id)
  assert.throws(() => store.insertTask({ projectId: 'proj_nope', ownerRoleId: 'gongbu', sourceRoleId: 'lead', status: 'draft' }), /项目不存在/)
  // 先校验角色，未知部门在建立任务时就拒绝
  const fresh = new WorkbenchStore({ file: null, clock: () => 1700000000000, random: () => 7 })
  const fa = fresh.createProject({ hostWorkspaceId: 'ws-a' })
  assert.throws(() => fresh.insertTask({ projectId: fa, ownerRoleId: 'hufu', sourceRoleId: 'lead', status: 'draft' }), /未知主责部门/)
  assert.throws(() => store.recordArtifact({ projectId: a, taskId: taskA.id, ownerRoleId: 'hufu' }), /未知主责部门/)
})

test('task writes cannot skip the state machine or rewrite project', () => {
  const { store, a, b } = mkStore()
  const task = store.insertTask({ projectId: a, ownerRoleId: 'gongbu', sourceRoleId: 'lead', status: 'draft' })
  assert.equal(task.revision, 1)
  const queued = store.updateTask({ ...task, status: 'queued' })
  assert.equal(queued.revision, 2)
  assert.throws(() => store.updateTask({ ...task, status: 'completed' }), /不允许/)
  assert.throws(() => store.updateTask({ ...task, projectId: b, status: 'queued' }), /不能被改写/)
  assert.throws(() => store.insertTask({ ...task }), /任务已存在/)
})

test('markEventDelivered acks the outbox without deleting events', () => {
  const { store, a, b } = mkStore()
  const first = store.appendEvent({ type: 'ping', projectId: a })
  const second = store.appendEvent({ type: 'ping', projectId: a })
  const other = store.appendEvent({ type: 'ping', projectId: b })
  assert.equal(store.listPendingEvents(a).length, 3, '项目 a：建项目 1 条 + 两条 ping')

  const revision = store.revision
  assert.deepEqual(store.markEventDelivered(a, [first.eventId]), { delivered: 1 })
  assert.equal(store.revision, revision + 1, '标记走同一条提交路径，递增 revision')
  // 幂等：重复 ack 不报错、不重复计数，也不白增 revision
  const revision2 = store.revision
  assert.deepEqual(store.markEventDelivered(a, [first.eventId]), { delivered: 0 })
  assert.equal(store.revision, revision2, '空操作不递增 revision')
  // 未知 id 静默忽略
  assert.deepEqual(store.markEventDelivered(a, ['evt_missing', 'not-an-id']), { delivered: 0 })
  // 跨项目 id 忽略：既不是错误，也不会写到别的项目
  assert.deepEqual(store.markEventDelivered(a, [other.eventId]), { delivered: 0 })
  assert.equal(store.listPendingEvents(b).length, 2, '项目 b 的事件不受影响')
  // 标记后不再出现在 pending，但事件仍可通过 listEvents 审计看到
  assert.deepEqual(
    store.listPendingEvents(a).map((row) => row.eventId),
    [store.listEvents(a)[0].eventId, second.eventId],
    '只剩项目创建事件与第二条 ping',
  )
  const acks = store.listEvents(a).find((row) => row.eventId === first.eventId)
  assert.ok(acks.deliveredAt !== null, '已投递事件保留记录并写时间戳')
  assert.equal(store.listEvents(a).length, 3)
  // 项目不存在与其它方法一致抛 StoreError
  assert.throws(
    () => store.markEventDelivered('proj_nope', [first.eventId]),
    (error) => error instanceof StoreError && error.code === 'NOT_FOUND',
  )
})

test('listPendingEvents honours limit and keeps seq order', () => {
  const { store, a } = mkStore()
  // mkStore 先建了两个项目，项目 a 的 project.created 是第 1 条事件
  const created = store.listEvents(a)[0]
  const first = store.appendEvent({ type: 'ping', projectId: a })
  const second = store.appendEvent({ type: 'ping', projectId: a })
  const third = store.appendEvent({ type: 'ping', projectId: a })
  assert.deepEqual(store.listPendingEvents(a).map((row) => row.seq), [created.seq, first.seq, second.seq, third.seq])
  assert.deepEqual(store.listPendingEvents(a, { limit: 2 }).map((row) => row.seq), [created.seq, first.seq])
  // 非正整数 limit 视为不传，行为与旧接口一致
  assert.equal(store.listPendingEvents(a, { limit: 0 }).length, 4)
  assert.equal(store.listPendingEvents(a, { limit: -1 }).length, 4)
  assert.equal(store.listPendingEvents(a, {}).length, 4)
  // limit 与 ack 组合：已投递的不占额度
  assert.deepEqual(store.markEventDelivered(a, [created.eventId, first.eventId]), { delivered: 2 })
  assert.equal(store.listPendingEvents(a).length, 2)
  assert.deepEqual(store.listPendingEvents(a, { limit: 1 }).map((row) => row.seq), [second.seq])
  assert.deepEqual(store.listPendingEvents(a, { limit: 2 }).map((row) => row.seq), [second.seq, third.seq])
})

test('event log keeps monotonic seq and rejects duplicate eventId', () => {
  const { store, a } = mkStore()
  const first = store.appendEvent({ type: 'ping', projectId: a })
  const second = store.appendEvent({ type: 'ping', projectId: a })
  assert.ok(second.seq > first.seq)
  assert.equal(store.listPendingEvents().length, 4, '两个项目创建 + 两条 ping 都待处理')
  assert.deepEqual(store.listPendingEvents().slice(-2).map((row) => row.type), ['ping', 'ping'])
  assert.equal(store.listEvents(a).length, 3)
  assert.throws(() => store.appendEvent({ type: 'ping', projectId: a, eventId: first.eventId }), /事件已登记/)
  assert.throws(() => store.appendEvent({ projectId: a }), /event.type/)
})

test('failed writes roll back memory and leave no ghost rows', () => {
  const { store, a } = mkStore()
  const revision = store.revision
  const events = store.eventSeq
  assert.throws(() => store.recordDispatch({ projectId: a, idempotencyKey: 'k', status: 'proposed' }), /未知派发状态/)
  assert.equal([...store.state.dispatches.values()].length, 0)
  assert.equal(store.revision, revision, '失败不递增 revision')
  assert.equal(store.eventSeq, events, '失败不留下半截事件')
})

test('file persistence round-trips and writes atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sansheng-store-'))
  try {
    const file = join(dir, 'nested', 'workbench.json')
    const store = makeStore(file)
    const a = store.createProject({ hostWorkspaceId: 'ws-a', displayNameCache: '项目A' })
    store.bindSession(a, 'gongbu', 'sess-1')
    store.saveConfig(a, 'gongbu', { provider: 'p', model: 'm', reasoningEffort: 'low' }, 0)
    store.recordDispatch({ projectId: a, idempotencyKey: 'k-1' })
    store.appendEvent({ type: 'test.event', projectId: a })
    assert.equal(existsSync(file), true)
    // 原子写：目录里只剩目标文件，没有残留 .tmp
    assert.deepEqual(readdirSync(dirname(file)), ['workbench.json'])
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.schemaVersion, 1)
    assert.equal(raw.revision, store.revision)

    const reloaded = makeStore(file)
    assert.equal(reloaded.load(), true)
    assert.equal(reloaded.revision, store.revision)
    assert.equal(reloaded.getBinding(a, 'gongbu').currentSessionId, 'sess-1')
    assert.equal(reloaded.getConfig(a, 'gongbu').configRevision, 1)
    assert.equal(reloaded.listEvents(a).length, store.listEvents(a).length)
    assert.deepEqual(reloaded.snapshot().projects, store.snapshot().projects)
    // 重新载入后仍能继续写，且唯一性约束照样生效
    assert.throws(() => reloaded.bindSession(a, 'libu', 'sess-1'), /已绑定/)
    assert.equal(reloaded.recordDispatch({ projectId: a, idempotencyKey: 'k-1' }).duplicate, true)

    // 缺省路径：%DSH_HOME%\sansheng-liubu\workbench.json，未设置时落 ~/.dsh
  const sep = String.fromCharCode(92)
  const winPath = defaultStorePath({ DSH_HOME: 'C:' + sep + 'dsh-home' }).split(sep).join('/')
  assert.equal(winPath, 'C:/dsh-home/sansheng-liubu/workbench.json')
    assert.equal(makeStore(null).save(), false, '纯内存模式不落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load rejects unknown schema versions instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sansheng-schema-'))
  try {
    const file = join(dir, 'workbench.json')
    const store = makeStore(file)
    store.createProject({ hostWorkspaceId: 'ws-a' })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.schemaVersion = 99
    writeFileSync(file, JSON.stringify(raw))
    const other = makeStore(file)
    assert.throws(() => other.load(), /schemaVersion=99/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ids factory is shared with event ids for deterministic tests', () => {
  const ids = createIdFactory({ random: () => 2, length: 6 })
  assert.match(ids.task(), /^task_2{6}$/)
  // 常量随机源会让 ID 冲突，因此 store 自带事件去重后缀
  const constant = new WorkbenchStore({ file: null, clock: () => 0, random: () => 7 })
  const projectId = constant.createProject({ hostWorkspaceId: 'ws-a' })
  const first = constant.appendEvent({ type: 'x', projectId })
  const second = constant.appendEvent({ type: 'x', projectId })
  assert.match(first.eventId, /^evt_7{12}/)
  assert.notEqual(first.eventId, second.eventId)
  assert.deepEqual(constant.listEvents(projectId).map((row) => row.seq), [1, 2, 3])
})

test('schema version and entity mapping are exported constants', () => {
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(entityOf('tasks'), 'task')
  assert.equal(entityOf('contextPackets'), 'contextPacket')
  assert.equal(entityOf('nope'), null)
  const error = new StoreError('BOOM', '炸了')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'StoreError')
  assert.equal(error.code, 'BOOM')
  assert.equal(error.details, undefined)
  assert.deepEqual(new StoreError('X', 'y', { a: 1 }).details, { a: 1 })
  // 缺省路径：%DSH_HOME%\sansheng-liubu\workbench.json，未设置时落 ~/.dsh
  const sep = String.fromCharCode(92)
  const winPath = defaultStorePath({ DSH_HOME: 'C:' + sep + 'dsh-home' }).split(sep).join('/')
  assert.equal(winPath, 'C:/dsh-home/sansheng-liubu/workbench.json')
  const homePath = defaultStorePath({}).split(sep).join('/')
  assert.match(homePath, /\.dsh\/sansheng-liubu\/workbench\.json$/)
})
