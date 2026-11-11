// 会话适配层：把 Host 的 SessionController 收敛成“派发只需要几个动作”。
//
// 依据 docs/v0.1-宿主能力记录.md（P0 实测的类型层事实）：
// - create({workspaceId}) 幂等：同一 workspace 已绑定时返回同一个会话，不会造出第二个；
// - create 里没有 creationRequestId，也没有 cwd+workspaceId 同时给的用法（会 bad-request）；
// - prompt 的 requestId 才是真幂等键（跨重启有效），所以 attemptId 直接当 requestId 用；
// - cancel() 只是“请求取消”，accepted:true ≠ 已取消，终态必须靠 follow/对账得到。
//
// 这一层只做三件事：拿到会话、送一条消息、听它的事件。其余判定留在核心层。

export class SessionAdapterError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'SessionAdapterError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** 把宿主抛出的杂异常收敛成“可重试 / 必失败”两类，reconciler 依赖这个区分。 */
export function classifyHostError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'session/conflict' || /session\/conflict/.test(message)) return 'conflict'
  if (code === 'session/model-unavailable' || /model-unavailable/.test(message)) return 'model_unavailable'
  if (code === 'session/agent-busy' || /agent-busy/.test(message)) return 'busy'
  if (code === 'session/writer-held' || /writer-held/.test(message)) return 'transient'
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(message)) return 'transient'
  return 'unknown'
}

/**
 * @param {object} options
 * @param {object} options.sessionController Host 的 ctx.sessionController（或同形状替身）。
 * @param {(event: object) => void} [options.onEvent] 订阅回调：任意会话事件（对账与 UI 都用它）。
 * @param {(message: string) => void} [options.log] 诊断日志出口；默认吞掉。
 */
export function createSessionAdapter(options = {}) {
  const { sessionController, onEvent, log = () => {} } = options
  if (sessionController === undefined || sessionController === null || typeof sessionController.prompt !== 'function') {
    throw new SessionAdapterError('NO_SESSION_CONTROLLER', '会话适配层需要 Host 的 sessionController')
  }
  const controller = sessionController
  /** 正在跑 follow 的会话：sessionId → { controller: AbortController, done: Promise<void> } */
  const followers = new Map()
  // 被用户明确要求停止过的会话（只影响对账收口，不影响派发）。
  const cancelRequested = new Set()
  let disposed = false

  function ensureAlive() {
    if (disposed) throw new SessionAdapterError('DISPOSED', '会话适配层已释放')
  }

  /**
   * 拿到（或复用）一个会话。上层传入的 sessionId 是 store 里登记的绑定；
   * 为空时用 workspaceId 建一个新会话，并把 host 返回的 id 交回给上层登记。
   */
  async function ensureSession({ workspaceId, sessionId, agentPreset } = {}) {
    ensureAlive()
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      // 已有绑定：不重建，只确认宿主能看到它（看不到就交给上层判定绑定失效）。
      const known = await inspectSession(sessionId)
      return { sessionId, created: false, known }
    }
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
      throw new SessionAdapterError('NO_TARGET', '既没有绑定会话也没有 workspaceId，无法接通部门')
    }
    const request = { workspaceId }
    if (typeof agentPreset === 'string' && agentPreset.trim() !== '') request.agentPreset = agentPreset
    try {
      const value = await controller.create(request)
      if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string') {
        throw new SessionAdapterError('BAD_CREATE_RESULT', '宿主 create 未返回 sessionId')
      }
      return { sessionId: value.sessionId, created: true, agentPreset: value.agentPreset ?? null }
    } catch (error) {
      throw new SessionAdapterError(classifyHostError(error), `接通部门会话失败：${messageOf(error)}`, { cause: error })
    }
  }

  async function inspectSession(sessionId) {
    if (typeof controller.inspect !== 'function') return null
    try {
      return await controller.inspect(sessionId)
    } catch {
      return null
    }
  }

  /**
   * 送一条消息。requestId 由调用方（attemptId）给，重试同一条 attempt 不会重复投递；
   * 超时/未知一律抛 transient，由 reconciler 决定是查证还是标 unknown。
   */
  async function sendPrompt({ sessionId, requestId, text, mode = 'queue', signal, clientTimeZone } = {}) {
    ensureAlive()
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new SessionAdapterError('NO_SESSION', '送消息前必须有 sessionId')
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SessionAdapterError('EMPTY_PROMPT', '送消息内容为空')
    }
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw new SessionAdapterError('NO_REQUEST_ID', '送消息必须带 requestId（幂等键）')
    }
    const request = {
      requestId,
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    }
    if (typeof clientTimeZone === 'string' && clientTimeZone !== '') request.clientTimeZone = clientTimeZone
    try {
      const value = await controller.prompt(request, signal)
      return { accepted: value?.accepted === true }
    } catch (error) {
      throw new SessionAdapterError(classifyHostError(error), `投递失败：${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * 取消只是“请求取消”；调用方必须等 follow 上的终态或对账结果，不能直接当已停。
   * 这里额外记下"这个会话被用户要求停过"，对账时用它把停跑结果收口成 cancelled，
   * 避免"取消与成功竞争"里被取消的那一次被记成成功运行。
   */
  function requestCancel(sessionId) {
    ensureAlive()
    try {
      const value = controller.cancel({ sessionId })
      if (value?.accepted === true) cancelRequested.add(sessionId)
      return { accepted: value?.accepted === true }
    } catch (error) {
      throw new SessionAdapterError(classifyHostError(error), `取消失败：${messageOf(error)}`, { cause: error })
    }
  }

  /** 该会话是否被明确要求过停止（跨本次进程有效；宿主重启后由 attempt 状态兜底）。 */
  function wasCancelRequested(sessionId) {
    return cancelRequested.has(sessionId)
  }

  /** 新一轮派发成功投递后可清掉停止标记：同一会话的下一次运行不该继承上一次的取消意图。 */
  function clearCancelRequest(sessionId) {
    return cancelRequested.delete(sessionId)
  }

  /** 每次派发都显式覆写模型：宿主 selectModel 会顺手改全局默认，所以用快照固定本轮。 */
  async function applyModel({ sessionId, provider, model, reasoningEffort } = {}) {
    ensureAlive()
    if (typeof controller.selectModel !== 'function') return { selected: false, reason: 'controller 无 selectModel' }
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return { selected: false, reason: '未配置模型' }
    }
    const request = { sessionId, provider, model }
    if (typeof reasoningEffort === 'string' && reasoningEffort !== '') request.reasoningEffort = reasoningEffort
    try {
      const value = await controller.selectModel(request)
      return { selected: true, selection: value?.selected ?? null }
    } catch (error) {
      // 模型不可用是“本次派发不能开工”，不是“任务失败”，交由上层标 unavailable 并保留任务。
      throw new SessionAdapterError(classifyHostError(error), `模型切换失败：${messageOf(error)}`, { cause: error })
    }
  }

  async function getSessionSummary(sessionId) {
    if (typeof controller.list !== 'function') return null
    try {
      const value = await controller.list({}, new AbortController().signal)
      const items = Array.isArray(value?.items) ? value.items : []
      return items.find((row) => row.sessionId === sessionId) ?? null
    } catch {
      return null
    }
  }

  /** 宿主是否还在跑这个会话：null 表示问不到（不当成“已结束”）。 */
  async function isRunning(sessionId) {
    const summary = await getSessionSummary(sessionId)
    if (summary === null) return null
    return summary.running === true
  }

  /**
   * 订阅会话事件。alreadyAttached 时不重复起流：同一个会话只留一条 follow，
   * 避免双窗口/重启后重建出两条流导致事件重复。
   */
  function follow(sessionId, { onFrame } = {}) {
    ensureAlive()
    if (followers.has(sessionId)) return followers.get(sessionId).handle
    if (typeof controller.follow !== 'function') throw new SessionAdapterError('NO_FOLLOW', 'controller 无 follow')
    const abort = new AbortController()
    const handle = { sessionId, stop: () => abort.abort() }
    const done = (async () => {
      try {
        const address = { sessionId }
        const stream = controller.follow({ address }, abort.signal)
        for await (const frame of stream) {
          if (disposed || abort.signal.aborted) break
          if (frame?.type === 'assistant-stream') continue
          try {
            if (typeof onFrame === 'function') onFrame(frame)
            if (typeof onEvent === 'function') onEvent({ sessionId, frame })
          } catch (error) {
            log(`[sansheng-liubu] 处理会话帧失败：${messageOf(error)}`)
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) log(`[sansheng-liubu] 会话流中断：${messageOf(error)}`)
      } finally {
        followers.delete(sessionId)
      }
    })()
    followers.set(sessionId, { handle, done })
    return handle
  }

  function unfollow(sessionId) {
    const entry = followers.get(sessionId)
    if (entry === undefined) return false
    entry.handle.stop()
    return true
  }

  function dispose() {
    disposed = true
    for (const entry of followers.values()) entry.handle.stop()
    followers.clear()
  }

  return Object.freeze({
    ensureSession,
    inspectSession,
    sendPrompt,
    requestCancel,
    wasCancelRequested,
    clearCancelRequest,
    applyModel,
    getSessionSummary,
    isRunning,
    follow,
    unfollow,
    dispose,
    get following() {
      return [...followers.keys()]
    },
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一条材料引用写成人能读的一行，并保留可追溯的 ID。
 * - 字符串：原样（历史数据里的自由文本引用）
 * - {artifactId, revision}：成果引用，带版本号
 * - {attachmentId, name, mime, size}：附件引用（A09 附件级交接）
 */
export function describeMaterialRef(ref) {
  if (typeof ref === 'string') return ref
  if (ref === null || typeof ref !== 'object') return String(ref)
  if (typeof ref.artifactId === 'string' && ref.artifactId !== '') {
    const version = Number.isInteger(ref.revision) && ref.revision > 0 ? `（第 ${ref.revision} 版）` : ''
    const title = typeof ref.title === 'string' && ref.title !== '' ? ` ${ref.title}` : ''
    return `成果${title} ${ref.artifactId}${version}`
  }
  if (typeof ref.attachmentId === 'string' && ref.attachmentId !== '') {
    const bits = []
    if (typeof ref.name === 'string' && ref.name !== '') bits.push(ref.name)
    if (typeof ref.mime === 'string' && ref.mime !== '') bits.push(ref.mime)
    if (Number.isInteger(ref.size) && ref.size > 0) bits.push(`${ref.size} 字节`)
    const suffix = bits.length === 0 ? '' : `（${bits.join(' · ')}）`
    return `附件 ${ref.attachmentId}${suffix}`
  }
  return JSON.stringify(ref)
}

/**
 * 把一次派发写成部门能直接执行的提示词。只放事实（任务、验收、材料、回传方式），
 * 不写“请确认已完成”这类引导语——完成判定只认结构化报告。
 */
export function buildDispatchText({ task, packet, contractGuide, roleName } = {}) {
  const lines = []
  const name = typeof roleName === 'string' && roleName !== '' ? roleName : '你'
  lines.push(`【任务单 ${task?.id ?? ''}】${task?.title ?? ''}`)
  if (typeof task?.objective === 'string' && task.objective !== '') lines.push(`目标：${task.objective}`)
  const acceptance = Array.isArray(packet?.acceptance) && packet.acceptance.length > 0 ? packet.acceptance : task?.acceptance
  if (Array.isArray(acceptance) && acceptance.length > 0) {
    lines.push('验收标准：')
    for (const item of acceptance) lines.push(`- ${String(item)}`)
  }
  const constraints = Array.isArray(packet?.constraints) ? packet.constraints : task?.constraints
  if (Array.isArray(constraints) && constraints.length > 0) {
    lines.push('约束：')
    for (const item of constraints) lines.push(`- ${String(item)}`)
  }
  const refs = Array.isArray(packet?.materialRefs) ? packet.materialRefs : []
  if (refs.length > 0) {
    lines.push('相关材料：')
    for (const ref of refs) lines.push(`- ${describeMaterialRef(ref)}`)
  }
  lines.push('')
  lines.push(`完成后请用结构化回传（不要只在正文里说“已完成”，那样不算完成）：`)
  lines.push(typeof contractGuide === 'string' && contractGuide !== '' ? contractGuide : '')
  lines.push('')
  lines.push(`（你是本项目的 ${name}；任务与成果归属由程序按项目登记，不要自行改派给其他部门。）`)
  return lines.join('\n')
}
