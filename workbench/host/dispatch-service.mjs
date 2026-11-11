// DispatchService：把“账本里的一纸派发”变成“部门会话里真实收到的一条消息”。
//
// 方案 §7.5 的时序在这里落成四段，每一步失败都有明确去向：
//   prepared → 选定会话与配置快照 → sending → prompt(requestId=attemptId)
//     ├─ 成功 → accepted
//     ├─ 宿主明确拒绝 → rejected（任务保留在排队态，可重试，不算业务失败）
//     └─ 超时/断线 → unknown（先查证再决定，绝不自动当失败重发）
//
// 幂等的两层：dispatch 行按 (projectId, idempotencyKey) 去重；prompt 按 attemptId 当 requestId。
// 因此“用户连点两次”与“发送超时后重试”都不会让部门收到两条任务单。

import { buildDispatchText } from './session-adapter.mjs'
import { describeContract } from './contract.mjs'

export const DISPATCH_OUTCOMES = Object.freeze(['accepted', 'rejected', 'unknown'])

export class DispatchError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'DispatchError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * @param {object} options
 * @param {object} options.store WorkbenchStore
 * @param {object} options.service 工作台服务
 * @param {object} options.sessions createSessionAdapter 的产物
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.clientTimeZone] 派发提示里的时区，默认 Asia/Shanghai
 */
export function createDispatchService(options = {}) {
  const { store, service, sessions, log = () => {}, clientTimeZone = 'Asia/Shanghai',
    applyModelToSessions = false } = options
  if (store === undefined || typeof store.findDispatchByIdempotencyKey !== 'function') {
    throw new DispatchError('NO_STORE', 'DispatchService 需要 WorkbenchStore')
  }
  if (service === undefined || typeof service.dispatchTask !== 'function') {
    throw new DispatchError('NO_SERVICE', 'DispatchService 需要工作台服务')
  }
  if (sessions === undefined || typeof sessions.sendPrompt !== 'function') {
    throw new DispatchError('NO_SESSIONS', 'DispatchService 需要会话适配层')
  }

  const contractGuide = describeContract()

  /**
   * 派发一个已入队任务。返回 { dispatch, attempt, outcome, duplicate }。
   *
   * 注意顺序：先写账（dispatch+attempt，同一次事务）再发消息。发送前崩溃只会留下
   * prepared 行，对账器会把它当“未发出”处理；先发后写则会出现“部门已收到但账上没有”。
   */
  async function dispatch(input = {}) {
    const projectId = requireText(input.projectId, 'projectId')
    const taskId = requireText(input.taskId, 'taskId')
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey')

    // 1) 账务：去重 + 校验 + 落 prepared
    const prepared = service.dispatchTask({
      projectId,
      taskId,
      idempotencyKey,
      sourceRoleId: input.sourceRoleId,
      targetRoleId: input.targetRoleId,
      targetSessionId: input.targetSessionId,
      bindingGeneration: input.bindingGeneration,
      packet: input.packet,
      attemptId: input.attemptId,
    })
    const { dispatch, attempt, duplicate } = splitPrepared(prepared)

    if (duplicate) {
      // 重复点击：什么都不再做，返回既有结论（含 unknown 的历史要由对账处理）。
      return { dispatch, attempt, outcome: outcomeOf(dispatch), duplicate: true }
    }
    if ((dispatch.status ?? dispatch.state) === 'accepted') return { dispatch, attempt, outcome: 'accepted', duplicate: false }

    // 2) 发送：先把 dispatch 推到 sending，再动宿主，避免“宿主已收但账上还是 prepared”。
    store.updateDispatch(dispatch.id, { status: 'sending', state: 'sending', sendingAt: new Date().toISOString() })

    const task = store.getTask(taskId)
    const packet = attempt?.contextPacketId === undefined || attempt?.contextPacketId === null
      ? null
      : store.getContextPacket(attempt.contextPacketId)
    const roleName = input.roleName ?? null

    try {
      // 3) 固定本轮配置：模型只在发送前覆写一次，运行中改配置不影响这一轮。
      //    默认不碰宿主会话的模型选择：部门模型由政策插件在 agent/request 上按角色覆写，
      //    再调 selectModel 既重复，又会让宿主后台把全局默认模型存成本部门的（A06）。
      //    只有显式 applyModelToSessions:true 时才落这一步。
      const snapshot = attempt?.effectiveConfigSnapshot ?? null
      if (applyModelToSessions && snapshot !== null && snapshot.provider && snapshot.model) {
        await sessions.applyModel({
          sessionId: attempt.sessionId,
          provider: snapshot.provider,
          model: snapshot.model,
          reasoningEffort: snapshot.reasoningEffort ?? undefined,
        })
      }
      const text = buildDispatchText({ task, packet, contractGuide, roleName })
      const result = await sessions.sendPrompt({
        sessionId: attempt.sessionId,
        requestId: attempt.id,
        text,
        mode: input.mode ?? 'queue',
        clientTimeZone,
      })
      if (result.accepted !== true) {
        markRejected({ dispatch, attempt, reason: '宿主未确认接收' })
        return { dispatch: store.getDispatch(dispatch.id), attempt, outcome: 'rejected', duplicate: false }
      }
      // 宿主确认接收 = 这一轮真的开始跑：任务与尝试同时进 running。
      // 只改尝试不改任务，运行终态就无处落地（completion 会因任务仍在 queued 而被丢弃）。
      service.startAttempt({
        projectId: dispatch.projectId,
        taskId: dispatch.taskId,
        attemptId: attempt.id,
        hostRunId: null,
      })
      markAccepted({ dispatch, attempt })
      return { dispatch: store.getDispatch(dispatch.id), attempt: store.getAttempt(attempt.id), outcome: 'accepted', duplicate: false }
    } catch (error) {
      const code = error?.code ?? 'unknown'
      if (code === 'conflict' || code === 'rejected') {
        markRejected({ dispatch, attempt, reason: error?.message ?? String(error) })
        return { dispatch: store.getDispatch(dispatch.id), attempt, outcome: 'rejected', duplicate: false }
      }
      // 超时、断线、context 丢失：一律 unknown —— 先查证，不重发。
      markUnknown({ dispatch, attempt, reason: code })
      log(`[sansheng-liubo] 派发 ${dispatch.id} 结果未知（${code}）：${error?.message ?? error}`)
      return { dispatch: store.getDispatch(dispatch.id), attempt, outcome: 'unknown', duplicate: false }
    }
  }

  /**
   * 对 unknown 的派发做查证：问宿主该会话是否有过这次 attempt 的请求。
   * 查不到就保持 unknown（再次对账），查到有 → accepted；宿主明确从未收到 → rejected。
   */
  async function verifyUnknown(dispatchId) {
    const dispatch = store.getDispatch(dispatchId)
    if (dispatch === undefined) throw new DispatchError('NOT_FOUND', `派发不存在：${dispatchId}`)
    if ((dispatch.status ?? dispatch.state) !== 'unknown') return { dispatch, outcome: outcomeOf(dispatch), changed: false }
    const attempt = dispatch.attemptId === null ? null : store.getAttempt(dispatch.attemptId)
    if (attempt === null) return { dispatch, outcome: 'unknown', changed: false }
    const known = await sessions.inspectSession(attempt.sessionId)
    if (known === null) return { dispatch, outcome: 'unknown', changed: false }
    // 会话存在：宿主已经接受过这条消息（prompt 幂等键会挡住重复投递），按 accepted 收口。
    store.updateDispatch(dispatch.id, { status: 'accepted', state: 'accepted', verifiedAt: new Date().toISOString() })
    if (attempt.state === 'unknown') {
      store.updateAttempt(attempt.id, { state: 'running', hostRunId: attempt.hostRunId ?? null })
    }
    return { dispatch: store.getDispatch(dispatch.id), outcome: 'accepted', changed: true }
  }

  function splitPrepared(result) {
    // service.dispatchTask 返回 { dispatch, attempt, task, roleId, duplicate }（形状见 P1 Phase2）。
    if (result === null || typeof result !== 'object' || result.dispatch === undefined) {
      throw new DispatchError('BAD_PREPARED', '服务返回的派发结果形状不正确')
    }
    return { dispatch: result.dispatch, attempt: result.attempt ?? null, duplicate: result.duplicate === true }
  }

  function markAccepted({ dispatch, attempt }) {
    const stamp = new Date().toISOString()
    store.mutate(() => {
      store.updateDispatch(dispatch.id, { status: 'accepted', state: 'accepted', acceptedAt: stamp })
      if (attempt !== null && attempt.state === 'queued') {
        store.updateAttempt(attempt.id, { state: 'running', startedAt: stamp })
      }
    })
  }

  function markRejected({ dispatch, attempt, reason }) {
    const stamp = new Date().toISOString()
    store.mutate(() => {
      store.updateDispatch(dispatch.id, { status: 'rejected', state: 'rejected', rejectedAt: stamp, error: String(reason ?? '') })
      if (attempt !== null && (attempt.state === 'queued' || attempt.state === 'unknown')) {
        store.updateAttempt(attempt.id, { state: 'failed', endedAt: stamp, error: String(reason ?? '') })
      }
    })
  }

  function markUnknown({ dispatch, attempt, reason }) {
    const stamp = new Date().toISOString()
    store.mutate(() => {
      store.updateDispatch(dispatch.id, { status: 'unknown', state: 'unknown', unknownAt: stamp, error: String(reason ?? '') })
      if (attempt !== null && attempt.state === 'queued') {
        store.updateAttempt(attempt.id, { state: 'unknown' })
      }
    })
  }

  return Object.freeze({ dispatch, verifyUnknown })
}

function outcomeOf(dispatch) {
  if ((dispatch.status ?? dispatch.state) === 'accepted') return 'accepted'
  if ((dispatch.status ?? dispatch.state) === 'rejected') return 'rejected'
  if ((dispatch.status ?? dispatch.state) === 'unknown') return 'unknown'
  return 'prepared'
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DispatchError('INVALID_INPUT', `${field} 必须是非空字符串`, { field })
  }
  return value
}
