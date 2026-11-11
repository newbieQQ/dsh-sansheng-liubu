// Reconciler：把“部门会话里真实发生了什么”折算成 attempt 的终态。
//
// 方案 §7.4 的硬约束：宿主运行结束 ≠ 业务完成。所以这里只做“运行终态”的判定，
// 业务完成由 tasks.decide 用（结构化报告 + 运行终态 + 成果引用）三票共同决定。
//
// 数据来源只有两类可信信号：
// 1. 宿主 follow 事件里的 turn/结束信号（附加 latest.assistant-stream 之外的持久帧）；
// 2. 主动查询 controller.list() 里该会话的 running 位。
// 绝不从聊天文本推断“做完了”。

import { classifyHostError } from './session-adapter.mjs'

export const RECONCILER_DEFAULT_INTERVAL_MS = 30000
export const RECONCILER_MIN_INTERVAL_MS = 5000

/**
 * @param {object} options
 * @param {object} options.store WorkbenchStore
 * @param {object} options.service 工作台服务（reportRunTerminal / markDispatch / syncDecision…）
 * @param {object} options.sessions createSessionAdapter 的产物
 * @param {() => number} [options.clock]
 * @param {(message: string) => void} [options.log]
 */
export function createReconciler(options = {}) {
  const { store, service, sessions, clock = Date.now, log = () => {} } = options
  if (store === undefined || typeof store.listOpenAttempts !== 'function') {
    throw new Error('createReconciler 需要 WorkbenchStore')
  }
  if (service === undefined || typeof service.reportRunTerminal !== 'function') {
    throw new Error('createReconciler 需要工作台服务')
  }
  let timer = null
  let running = false

  /**
   * 单次对账。返回结构化结果供日志与测试断言，不吞异常也不抛出：
   * 一个会话查不到不该阻断其它会话的对账。
   */
  async function reconcileOnce() {
    if (running) return { skipped: true, reason: 'busy', checked: 0, changed: [] }
    running = true
    const outcome = { skipped: false, checked: 0, changed: [], errors: [] }
    try {
      const open = store.listOpenAttempts()
      for (const attempt of open) {
        outcome.checked += 1
        try {
          const change = await reconcileAttempt(attempt)
          if (change !== null) outcome.changed.push(change)
        } catch (error) {
          outcome.errors.push({ attemptId: attempt.id, message: messageOf(error) })
          log(`[sansheng-liubo] 对账 ${attempt.id} 失败：${messageOf(error)}`)
        }
      }
    } finally {
      running = false
    }
    return outcome
  }

  /**
   * 单个 attempt 的对账：
   * - 宿主问不到（null）→ 什么也不改，等下一轮（宁可晚，不可猜）；
   * - 还在跑 → 只把 queued 推进到 running，不改结论；
   * - 已停 → 依 state 决定：cancel_requested 转 cancelled，其余转 succeeded（再交 completion 三票判定）。
   */
  async function reconcileAttempt(attempt) {
    const projectId = attempt.projectId
    let task = store.getTask(attempt.taskId)
    if (task === undefined) return null
    const runningFlag = await sessions.isRunning(attempt.sessionId)
    if (runningFlag === null) return null
    const now = new Date(clock()).toISOString()

    if (runningFlag) {
      if (attempt.state === 'queued') {
        store.updateAttempt(attempt.id, { state: 'running', hostRunId: attempt.hostRunId ?? null, heartbeatAt: now })
        // 任务要跟着进 running：只有任务处于 running 时，运行终态才能折算成
        // completed / needs_attention / cancelled，否则终态会被状态机丢弃。
        if (task.status === 'queued') {
          try {
            // service.startAttempt 会同时把任务推进到 running，并把最新任务读回来。
            const started = service.startAttempt({
              projectId,
              taskId: task.id,
              attemptId: attempt.id,
              hostRunId: attempt.hostRunId ?? null,
            })
            task = started.task ?? task
          } catch (error) {
            log(`[sansheng-liubo] 任务 ${task.id} 推进 running 被拒：${messageOf(error)}`)
          }
        }
        return { attemptId: attempt.id, from: 'queued', to: 'running' }
      }
      return null
    }

    // 宿主说会话不跑了：这是“运行终态 = 正常结束”，不是业务完成。
    // 用户点过停止（cancel_requested）的尝试记为 cancelled，不当成成功运行。
    // 用户点过停止：可能是适配器已经写过 cancel_requested，也可能只是刚发出停止请求
    // （cancel() 是同步 accepted，不等于已停）。两种都按取消收口，否则"取消与成功竞争"里
    // 被取消的这一次会被记成成功运行，任务显示已完成。
    const cancelRequested = attempt.state === 'cancel_requested' || sessions.wasCancelRequested(attempt.sessionId)
    if (attempt.state === 'running' || attempt.state === 'queued' || cancelRequested) {
      const nextState = cancelRequested ? 'cancelled' : 'succeeded'
      // running 不能直接到 cancelled：用户请求过停止的，先记 cancel_requested 再收口，
      // 状态机与审计都保留"请求过停止"这一步。
      if (nextState === 'cancelled' && attempt.state !== 'cancel_requested') {
        store.updateAttempt(attempt.id, { state: 'cancel_requested', cancelRequestedAt: now })
      }
      store.updateAttempt(attempt.id, { state: nextState, endedAt: now })
      applyTerminal({ attempt, task, terminal: nextState === 'cancelled' ? 'cancelled' : 'succeeded' })
      return { attemptId: attempt.id, from: attempt.state, to: nextState }
    }
    return null
  }

  function applyTerminal({ attempt, task, terminal }) {
    try {
      // 任务侧：run_terminal 只是“一票”。没报告时只会变 needs_attention，不会变 completed。
      service.reportRunTerminal({
        projectId: attempt.projectId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        runTerminal: terminal,
      })
    } catch (error) {
      // 状态机拒绝重复/乱序终态是正常情况：记一行，不抛出。
      log(`[sansheng-liubo] 任务 ${task.id} 记录运行终态被拒：${messageOf(error)}`)
    }
  }

  /** 一个会话里出现了新的 assistant 完成回合：作为“可能已结束”的信号触发一次定向对账。 */
  async function onSessionFrame({ sessionId }) {
    const open = store.listOpenAttempts().filter((row) => row.sessionId === sessionId)
    if (open.length === 0) return { checked: 0 }
    for (const attempt of open) {
      try {
        await reconcileAttempt(attempt)
      } catch (error) {
        log(`[sansheng-liubo] 帧触发对账失败：${messageOf(error)}`)
      }
    }
    return { checked: open.length }
  }

  function start({ intervalMs = RECONCILER_DEFAULT_INTERVAL_MS } = {}) {
    if (timer !== null) return
    const period = Math.max(RECONCILER_MIN_INTERVAL_MS, Number(intervalMs) || RECONCILER_DEFAULT_INTERVAL_MS)
    timer = setInterval(() => {
      reconcileOnce().catch((error) => log(`[sansheng-liubo] 周期对账异常：${messageOf(error)}`))
    }, period)
    // 宿主退出时不要让定时器把进程吊住。
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return Object.freeze({
    reconcileOnce,
    reconcileAttempt,
    onSessionFrame,
    start,
    stop,
    get scheduled() {
      return timer !== null
    },
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export { classifyHostError }
