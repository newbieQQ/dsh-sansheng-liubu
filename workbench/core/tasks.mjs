// 任务生命周期：纯函数 + 显式副作用端口。
// 判定永远不读聊天文本，只认结构化报告、宿主真实终态和可解析的成果引用——
// 这是“agent 说已完成”与“任务完成”分开的落点。
// 副作用（写 store、入队、回传）由调用方注入，core 本身不碰网络和调度。

import { assertTransition, isState, isTerminal } from './states.mjs'
import { isRoleId } from './roles.mjs'

export class TaskError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'TaskError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const TASK_BASE_TRANSITIONS = Object.freeze([
  ['draft', 'queued'],
  ['queued', 'running'],
  ['running', 'waiting_input'],
  ['running', 'needs_attention'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['waiting_input', 'queued'],
  ['waiting_input', 'running'],
  ['needs_attention', 'completed'],
  ['needs_attention', 'running'],
  ['needs_attention', 'failed'],
  // 取消可在任何非终态发起
  ['draft', 'cancelled'],
  ['queued', 'cancelled'],
  ['running', 'cancelled'],
  ['waiting_input', 'cancelled'],
  ['needs_attention', 'cancelled'],
  // 入队后模型不可用：允许直接失败并保留错误
  ['queued', 'failed'],
])

export const TASK_TRANSITIONS = Object.freeze(TASK_BASE_TRANSITIONS.map(([from, to]) => Object.freeze([from, to])))

const TERMINAL_TASK_STATES = Object.freeze(['completed', 'failed', 'cancelled'])

/** seq 比较：仅当新事件 seq 严格大于已见 seq 才视为“更新”。 */
export function isStaleSeq(lastSeq, nextSeq) {
  if (lastSeq === null || lastSeq === undefined) return false
  if (!Number.isFinite(nextSeq)) return true
  return nextSeq <= lastSeq
}

/** 乱序/重复事件：达到终态后任何“回到活动态”的事件都必须忽略，而不是报错中断处理。 */
export function isRegressingEvent(currentStatus, nextStatus) {
  if (TERMINAL_TASK_STATES.includes(currentStatus)) return currentStatus !== nextStatus
  return false
}

function transition(state, next, extra = {}) {
  assertTransition('task', state, next)
  return next
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskError('INVALID_INPUT', `${field} 必须是非空字符串`)
  }
  return value
}

function requireTask(task) {
  if (task === null || typeof task !== 'object' || typeof task.id !== 'string') {
    throw new TaskError('INVALID_TASK', '任务记录不合法')
  }
  return task
}

/**
 * createTask：只建草稿。draft 不等于入队，校验通过且授权有效后才 startTask 入队。
 * ownerRoleId 与 sourceRoleId 都必须是已知席，来源席默认丞相。
 */
export function createTask(options, deps = {}) {
  const { projectId, title, objective, acceptance = [], ownerRoleId, sourceRoleId = 'lead', originMessageRef = null, scope = null, constraints = [], returnTarget = null } = options ?? {}
  requireString(projectId, 'projectId')
  requireString(title, 'title')
  requireString(objective, 'objective')
  if (!isRoleId(ownerRoleId)) throw new TaskError('INVALID_ROLE', `未知主责部门: ${String(ownerRoleId)}`)
  if (!isRoleId(sourceRoleId)) throw new TaskError('INVALID_ROLE', `未知来源部门: ${String(sourceRoleId)}`)
  const id = typeof deps.newTaskId === 'function' ? deps.newTaskId() : undefined
  const stamp = typeof deps.now === 'function' ? deps.now() : new Date().toISOString()
  return {
    ...(id === undefined ? {} : { id }),
    projectId,
    title,
    objective,
    acceptance: Array.isArray(acceptance) ? [...acceptance] : [String(acceptance)],
    constraints: Array.isArray(constraints) ? [...constraints] : [],
    scope: scope ?? null,
    ownerRoleId,
    sourceRoleId,
    originMessageRef,
    returnTarget,
    status: 'draft',
    activeAttemptId: null,
    attempts: [],
    startedAt: null,
    endedAt: null,
    reportReceivedAt: null,
    needsAttentionReason: null,
    failureReason: null,
    waitingReason: null,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/** 入队：唯一需要的前置是 draft，或者 waiting_input 拿到补充。 */
export function startTask(task, deps = {}) {
  requireTask(task)
  if (task.status !== 'draft' && task.status !== 'waiting_input') {
    throw new TaskError('INVALID_STATE', `只有草稿或待补充的任务可以入队，当前 ${task.status}`)
  }
  const stamp = stampOf(deps)
  return {
    ...task,
    status: transition(task.status, 'queued'),
    waitingReason: null,
    revision: task.revision + 1,
    updatedAt: stamp,
  }
}

/**
 * beginAttempt：队列中的任务进入执行，并绑定一次尝试。
 * 每次重试都是新 attempt，旧尝试（及旧结果引用）保留，不覆盖成“第一次就成功”。
 */
export function beginAttempt(task, attempt, deps = {}) {
  requireTask(task)
  if (task.status !== 'queued' && task.status !== 'waiting_input' && task.status !== 'needs_attention' && task.status !== 'running') {
    throw new TaskError('INVALID_STATE', `任务 ${task.status} 不能开始新的尝试`)
  }
  // 是否“仍有活动尝试”不能只看 activeAttemptId 是否为空：
  // 取消/失败/对账后，Attempt 已转 cancelled/failed/succeeded 终态，但任务的 activeAttemptId 仍指向它（保留审计），
  // 若只看非空就会把取消后的重试挡在 ACTIVE_ATTEMPT 上。deps.attemptLookup 由调用方注入（core 不读 store），
  // 只有明确查到“非终态”尝试时才算有活动尝试；查不到（undefined/null）时保持旧行为，按非空处理。
  // 另：attempt 的 unknown 是待对账状态，不算终态，仍会挡住重试。
  const hasActiveAttempt = task.activeAttemptId !== null && task.activeAttemptId !== undefined
    && !isSettledAttempt(task.activeAttemptId, deps)
  // running 下换尝试等于重试：必须先把旧尝试对账（失败/取消），否则两次运行会同时往一个任务里写结果。
  if (task.status === 'running' && hasActiveAttempt) {
    throw new TaskError('ACTIVE_ATTEMPT', '当前尝试仍在运行，先对账再重试')
  }
  if (attempt === null || typeof attempt !== 'object' || typeof attempt.id !== 'string') {
    throw new TaskError('INVALID_ATTEMPT', '尝试记录不合法')
  }
  if (attempt.projectId !== task.projectId) {
    throw new TaskError('CROSS_PROJECT', '尝试与任务不属于同一项目')
  }
  if (attempt.taskId !== task.id) {
    throw new TaskError('CROSS_TASK', '尝试挂在别的任务上')
  }
  if (task.status === 'needs_attention' && hasActiveAttempt) {
    throw new TaskError('ACTIVE_ATTEMPT', '仍有未对账的尝试，先完成或标记失败')
  }
  const stamp = stampOf(deps)
  return {
    ...task,
    status: transition(task.status, 'running'),
    activeAttemptId: attempt.id,
    attempts: [...task.attempts, attempt.id],
    startedAt: task.startedAt ?? stamp,
    needsAttentionReason: null,
    waitingReason: null,
    revision: task.revision + 1,
    updatedAt: stamp,
  }
}

/** 结构化报告是否“可信”：summary 非空、成果引用形状正确、检查是真实结果而非空话。 */
export function validateReport(report) {
  const errors = []
  if (report === null || typeof report !== 'object') return ['报告必须是对象']
  if (!report.attemptId || typeof report.attemptId !== 'string') errors.push('缺少 attemptId')
  if (!report.taskId || typeof report.taskId !== 'string') errors.push('缺少 taskId')
  if (typeof report.summary !== 'string' || report.summary.trim() === '') errors.push('结果摘要为空')
  if (report.artifactRefs !== undefined) {
    if (!Array.isArray(report.artifactRefs)) errors.push('artifactRefs 必须是数组')
    else {
      for (const ref of report.artifactRefs) {
        if (typeof ref !== 'string' || !ref.startsWith('art_')) errors.push(`成果引用形状非法: ${String(ref)}`)
      }
    }
  }
  if (report.checks !== undefined && !Array.isArray(report.checks)) errors.push('checks 必须是数组')
  return errors
}

/**
 * 三条完成条件各占一票，缺一条都不能标 completed：
 * 1. 可信结构化报告（有摘要、有检查、没有未解决阻塞）
 * 2. 宿主运行终态成功（由调用方从宿主取得，不能猜“空闲=成功”）
 * 3. 成果引用有效（引用指向本项目现存成果，或被显式标为不可用）
 */
export function checkCompletion(input) {
  const { report = null, runTerminal = null, artifactRefs = [], artifactLookup = null } = input ?? {}
  const blockers = []
  let reportOk = false
  if (report !== null) {
    const errors = validateReport(report)
    if (errors.length > 0) blockers.push(...errors)
    else if (typeof report.blockedReason === 'string' && report.blockedReason.trim() !== '') {
      blockers.push('报告标记了阻塞原因')
    } else reportOk = true
  } else {
    blockers.push('未收到结构化报告')
  }
  const runOk = runTerminal === 'succeeded'
  if (runTerminal === null) blockers.push('宿主运行尚未结束')
  else if (!runOk) blockers.push(`宿主运行终态为 ${String(runTerminal)}`)
  const refs = Array.isArray(artifactRefs) ? artifactRefs : []
  const invalidRefs = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith('art_')) invalidRefs.push(String(ref))
    else if (typeof artifactLookup === 'function') {
      const artifact = artifactLookup(ref)
      if (artifact === undefined || artifact === null) invalidRefs.push(ref)
      else if (artifact.verification?.status === 'missing') invalidRefs.push(ref)
    }
  }
  if (invalidRefs.length > 0) blockers.push(`成果引用无效: ${invalidRefs.join(', ')}`)
  // 纯分析任务允许没有文件，所以“引用为空”本身不算失败，但登记结果时不能伪造附件。
  return { reportOk, runOk, refsValid: invalidRefs.length === 0, blockers, ok: reportOk && runOk && invalidRefs.length === 0 }
}

/**
 * 完成判定三分支：
 * - 报告 + 终态成功 + 成果有效 → completed
 * - 只有报告（运行未结束） → 保持 running 等终态（waiting 只是“候选结果已存”）
 * - 只有终态（无报告） → needs_attention，提供补报入口，不显示已完成
 */
export function evaluateCompletion(task, input, deps = {}) {
  return decide(task, { kind: 'completion', ...input }, deps)
}

/**
 * 统一事件入口：先按 seq 去重、再按状态机判定。旧 seq 或终态后的事件返回
 * { applied:false, stale:true, task }，让调用方知道“什么都没变”而不是误以为写入失败。
 */
export function decide(task, event, deps = {}) {
  requireTask(task)
  if (event === null || typeof event !== 'object') throw new TaskError('INVALID_EVENT', '事件必须是对象')
  const nextSeq = event.seq
  if (nextSeq !== undefined && isStaleSeq(task.lastSeq ?? null, nextSeq)) {
    return { applied: false, stale: true, task }
  }
  const stamp = stampOf(deps)
  const base = nextSeq === undefined ? task : { ...task, lastSeq: nextSeq }
  const commit = (next) => ({
    applied: true,
    stale: false,
    task: applyStamp({ ...next, id: task.id, projectId: task.projectId }, next, stamp, base),
  })

  switch (event.kind) {
    case 'completion': {
      if (isTerminal('task', task.status)) return { applied: false, stale: true, task, reason: '任务已终态' }
      const verdict = checkCompletion(event)
      if (!verdict.reportOk && verdict.runOk) {
        return commit({
          ...base,
          status: transition(task.status, 'needs_attention'),
          needsAttentionReason: '宿主运行已结束但没有有效的结构化报告',
          reportReceivedAt: base.reportReceivedAt ?? null,
        })
      }
      // 用户主动停止的会话，运行终态是 cancelled 而不是"成功但没报告"：
      // 这一票足以把任务收成 cancelled，不需要也不可能再等到结构化报告。
      if (event.runTerminal === 'cancelled' && !verdict.reportOk) {
        return commit({ ...base, status: transition(task.status, 'cancelled'), endedAt: stamp })
      }
      if (!verdict.ok) {
        // 报告不完整：只记录候选报告，等下一次带完整信息的事件。
        return { applied: false, stale: false, task: base, reason: verdict.blockers.join('; '), verdict }
      }
      return commit({
        ...base,
        status: transition(task.status, 'completed'),
        reportReceivedAt: stamp,
        needsAttentionReason: null,
        failureReason: null,
      })
    }
    case 'report': {
      if (isTerminal('task', task.status)) return { applied: false, stale: true, task }
      const errors = validateReport(event.report)
      if (errors.length > 0) throw new TaskError('INVALID_REPORT', errors.join('; '), { errors })
      // 报告先到：保存候选结果，等待宿主终态。
      return commit({ ...base, reportReceivedAt: stamp, needsAttentionReason: null })
    }
    case 'run_terminal': {
      if (isTerminal('task', task.status)) return { applied: false, stale: true, task }
      const state = event.runTerminal
      if (state === 'succeeded') {
        // 只有报告已经到达，才可能在这里直接完成；否则留给 completion 判定。
        if (base.reportReceivedAt !== null && base.status === 'running') {
          return commit({ ...base, status: transition(task.status, 'completed') })
        }
        return { applied: false, stale: false, task: base, reason: '等待结构化报告' }
      }
      if (state === 'cancelled') {
        return commit({ ...base, status: transition(task.status, 'cancelled'), endedAt: stamp })
      }
      return commit({
        ...base,
        status: transition(task.status, 'needs_attention'),
        needsAttentionReason: `宿主运行终态为 ${String(state)}`,
      })
    }
    case 'input_required': {
      if (task.status !== 'running' && task.status !== 'queued') {
        return { applied: false, stale: false, task, reason: `任务 ${task.status} 不接受待补充状态` }
      }
      return commit({ ...base, status: transition(task.status, 'waiting_input'), waitingReason: String(event.reason ?? '') })
    }
    case 'input_supplied': {
      if (task.status !== 'waiting_input') return { applied: false, stale: false, task, reason: '任务不在待补充状态' }
      return commit({ ...base, status: transition(task.status, 'running'), waitingReason: null })
    }
    case 'retry': {
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        return { applied: false, stale: false, task, reason: '只有失败或已取消的任务可以重试（新任务）' }
      }
      throw new TaskError('RETRY_REQUIRES_NEW_TASK', '失败/取消后的重试必须创建新任务与新尝试，不能复活旧记录')
    }
    default:
      throw new TaskError('UNKNOWN_EVENT', `未知事件类型: ${String(event.kind)}`)
  }
}

/** 结束时间只写一次：重复到达的终态事件不应改动“最后一次改动时间”。 */
function applyStamp(task, next, stamp, base) {
  const now = { ...base, ...next, updatedAt: stamp }
  // completed/failed/cancelled 结束时间只写一次，重复写入会伪造“最后一次改动时间”。
  if (TERMINAL_TASK_STATES.includes(now.status) && now.endedAt === null) now.endedAt = stamp
  if (!Number.isFinite(now.revision) || now.revision < 1) now.revision = 1
  else if (now.status !== task.status) now.revision = task.revision + 1
  return now
}

function stampOf(deps) {
  return typeof deps.now === 'function' ? deps.now() : new Date().toISOString()
}

/**
 * activeAttemptId 指向的尝试是否已对账（终态）。
 * 调用方通过 deps.attemptLookup(attemptId) 提供当前 Attempt 记录；core 不直接读 store。
 * unknown 是“待核对宿主”的中间态，不是终态，因此仍然算活动尝试。
 */
function isSettledAttempt(attemptId, deps) {
  const lookup = deps?.attemptLookup
  if (typeof lookup !== 'function') return false
  const record = lookup(attemptId)
  if (record === null || record === undefined || typeof record !== 'object') return false
  return isTerminal('attempt', record.state)
}

// ---------- 便捷包装：每个都只调用 decide，签名简单便于调用方阅读 ----------

export function requestInput(task, reason, deps = {}) {
  return decide(task, { kind: 'input_required', reason, seq: deps.seq }, deps)
}

export function supplyInput(task, deps = {}) {
  return decide(task, { kind: 'input_supplied', seq: deps.seq }, deps)
}

export function completeTask(task, input, deps = {}) {
  return decide(task, { kind: 'completion', ...input, seq: input?.seq }, deps)
}

/** 失败必须带原因：没有原因的失败在详情页无法给出恢复入口。 */
export function failTask(task, reason, deps = {}) {
  requireTask(task)
  requireString(reason, 'reason')
  if (isTerminal('task', task.status)) {
    return { applied: false, stale: true, task, reason: '任务已终态' }
  }
  const stamp = stampOf(deps)
  return {
    applied: true,
    stale: false,
    task: {
      ...task,
      status: transition(task.status, 'failed'),
      failureReason: reason,
      updatedAt: stamp,
      endedAt: task.endedAt ?? stamp,
      revision: task.revision + 1,
    },
  }
}

/** 取消是请求，不是结果：这里只落“已取消”的业务结论，宿主的 cancel_requested 另记在 attempt。 */
export function cancelTask(task, reason = '用户取消', deps = {}) {
  requireTask(task)
  if (isTerminal('task', task.status)) {
    return { applied: false, stale: true, task, reason: '任务已终态' }
  }
  const stamp = stampOf(deps)
  return {
    applied: true,
    stale: false,
    task: {
      ...task,
      status: transition(task.status, 'cancelled'),
      failureReason: task.failureReason ?? null,
      cancelReason: reason,
      updatedAt: stamp,
      endedAt: task.endedAt ?? stamp,
      revision: task.revision + 1,
    },
  }
}

/** 把 decide 的结果套到 store 上：只有 applied 才写，避免陈旧事件产生 revision 抖动。 */
export function applyDecision(store, taskId, decision) {
  if (store === undefined || store === null) throw new TaskError('INVALID_STORE', '需要 store')
  if (decision === null || typeof decision !== 'object') throw new TaskError('INVALID_DECISION', '判定结果不合法')
  if (decision.applied !== true) return decision
  const saved = store.updateTask(decision.task)
  return { ...decision, task: saved }
}

/** 任务是否仍在进行（UI 需要区分终态与活动态，但不允许显示百分比）。 */
export function isOpenTask(task) {
  return task !== null && typeof task === 'object' && isState('task', task.status) && !isTerminal('task', task.status)
}
