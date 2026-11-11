// 工作台 Host 外壳：把 store + service + 适配层 + 两个后台服务组装成一个可挂载组件。
//
// 挂载方式（index.js 里）：
//   const host = createWorkbenchHost(ctx, { store, presetId })
//   ctx.effect(() => () => host.dispose(), 'sansheng-liubo: workbench')
//
// 能力探测优先：宿主没有 sessionController 时，工作台仍然能读写账本（投影可用），
// 但任何“派发/接通”都返回 NO_SESSION_CONTROLLER，UI 显示“尚未接通”，绝不假装成功。

import { join } from 'node:path'
import { WorkbenchStore, defaultStorePath } from '../core/store.mjs'
import { createMemoryStore } from '../core/memory.mjs'
import { resolveSidecarDir } from './paths.mjs'
import { createWorkbenchService } from './service.mjs'
import { createSessionAdapter } from './session-adapter.mjs'
import { createDispatchService } from './dispatch-service.mjs'
import { createReconciler } from './reconciler.mjs'
import { CONTRACT_ACTIONS, CONTRACT_ACTION_PREFIX, parseContractLines, describeContract } from './contract.mjs'

export const WORKBENCH_HOST_VERSION = 1

/**
 * @param {object} ctx Host 插件上下文（cordis Context）
 * @param {object} [options]
 * @param {object} [options.store] 已有 store（测试注入）；缺省按环境建一个。
 * @param {object} [options.service] 已有 service；缺省按 store 新建。给了 service 就必须同时给 store，
 *   否则两边的账不是同一本。
 * @param {string} [options.presetId] 部门会话使用的 agentPreset，首版沿用「上朝」。
 * @param {boolean} [options.startReconciler] 是否启动周期对账，默认 true。
 */
export function createWorkbenchHost(ctx, options = {}) {
  const log = (message) => {
    try {
      ctx?.logger?.info?.(message)
    } catch {
      /* 日志失败不能影响业务 */
    }
  }

  const store = options.store ?? createStore(options)
  // 记忆层：默认落在侧车目录的 memory/ 下（惰性读写，装配本身不碰磁盘）；
  // 测试可注入 options.memory，用 null 明确关掉。
  const memory = options.memory === null
    ? null
    : (options.memory ?? createMemoryStore({ dir: join(resolveSidecarDir(options.env ?? process.env), 'memory'), clock: options.clock }))
  const service = options.service ?? createWorkbenchService({ store, clock: options.clock, fileExists: options.fileExists, memory })

  // 会话层是可选能力：宿主没有 sessionController（或版本不提供）时整体降级。
  // 注意 apply 时宿主可能还没把 sessionController 装好，所以这里只是「尝试挂载」，
  // 真正的挂载动作集中在 mountSessions，宿主晚到时由 attachSessions 再补一次。
  let sessions = null
  let dispatchService = null
  let reconciler = null
  let hasSessions = false
  let started = false

  function mountSessions(controller) {
    const usable = controller !== null && typeof controller?.prompt === 'function'
    if (!usable) return false
    if (sessions !== null) return true
    try {
      sessions = createSessionAdapter({ sessionController: controller, log })
    } catch (error) {
      log(`[sansheng-liubo] 会话层不可用：${error?.message ?? error}`)
      sessions = null
      return false
    }
    dispatchService = createDispatchService({ store, service, sessions, log, applyModelToSessions: options.applyModelToSessions === true })
    reconciler = createReconciler({ store, service, sessions, log })
    hasSessions = true
    if (started && options.startReconciler !== false) reconciler.start()
    return true
  }

  /** 宿主稍后才提供 sessionController 时补挂（不重启也能用）。返回是否挂上。 */
  function attachSessions(controller) {
    const mounted = mountSessions(controller ?? null)
    if (!mounted) log('[sansheng-liubo] 会话控制器仍不可用，派发继续保持“只落账”')
    return mounted
  }

  mountSessions(ctx?.sessionController ?? ctx?.remote?.session ?? null)

  const presetId = typeof options.presetId === 'string' && options.presetId !== '' ? options.presetId : 'sansheng-liubu'

  /**
   * 接通某个部门的会话：已有绑定就直接用，没有就按 workspace 建一个并登记。
   * 绑定替换由 store 的 bindSession 判定（allowReplace），账上和宿主保持一致。
   */
  async function connectDepartment(input = {}) {
    const projectId = requireText(input.projectId, 'projectId')
    const roleId = requireText(input.roleId, 'roleId')
    const project = store.getProject(projectId)
    if (project === undefined) throw new Error('项目不存在')
    if (sessions === null) {
      throw new Error('宿主未提供会话能力，暂时无法接通部门（账本仍可读写）')
    }
    const binding = store.getBinding(projectId, roleId)
    const existing = binding?.currentSessionId ?? null
    if (existing !== null) {
      const known = await sessions.inspectSession(existing)
      if (known !== null) return { sessionId: existing, created: false, seat: seatOf(projectId, roleId) }
    }
    const target = await sessions.ensureSession({
      workspaceId: project?.hostWorkspaceId,
      sessionId: input.sessionId ?? null,
      agentPreset: input.agentPreset ?? presetId,
    })
    // 账上登记：同一会话被别的部门占用时 store 会拒绝，正是我们要的“会话独占”。
    const saved = service.bindDepartmentSession({
      projectId,
      roleId,
      sessionId: target.sessionId,
      allowReplace: existing !== null,
    })
    return { sessionId: target.sessionId, created: target.created === true, seat: saved.seat }
  }

  function seatOf(projectId, roleId) {
    return service.listSeats(projectId).find((seat) => seat.roleId === roleId) ?? null
  }

  /** 派发（对 UI 的唯一入口）。没有会话层时返回明确错误，不假装已发送。 */
  async function dispatchTask(input = {}) {
    if (dispatchService === null) {
      return { ok: false, code: 'NO_SESSION_CONTROLLER', message: '宿主未提供会话能力，派发已停在工作台账内' }
    }
    return dispatchService.dispatch(input)
  }

  /** 处理部门输出里的契约行：只认结构化字段，解析失败的行原样返回给 UI 提示。 */
  function ingestAgentOutput({ projectId, roleId, text } = {}) {
    const parsed = parseContractLines(text)
    const applied = []
    const failed = []
    for (const call of parsed.calls) {
      try {
        applied.push(applyContractCall({ projectId, roleId, call }))
      } catch (error) {
        failed.push({ action: call.action, code: error?.code ?? 'unknown', message: error?.message ?? String(error) })
      }
    }
    return { applied, failed, invalid: parsed.invalid }
  }

  function applyContractCall({ projectId, roleId, call }) {
    const payload = { ...call.payload, projectId }
    switch (call.action) {
      case 'dispatchTask':
        if (payload.sourceRoleId === undefined) payload.sourceRoleId = roleId
        return { action: call.action, result: service.dispatchTask(payload) }
      case 'reportTaskResult':
        return { action: call.action, result: service.reportTaskResult(payload) }
      case 'requestTaskInput':
        return { action: call.action, result: service.requestTaskInput(payload) }
      case 'syncDecision':
        return { action: call.action, result: service.syncDecision(payload) }
      default:
        throw new Error(`未知动作：${String(call.action)}`)
    }
  }

  function start() {
    if (started) return
    started = true
    if (options.startReconciler !== false && reconciler !== null) reconciler.start()
  }

  function dispose() {
    if (reconciler !== null) reconciler.stop()
    if (sessions !== null) sessions.dispose()
    started = false
  }

  return Object.freeze({
    version: WORKBENCH_HOST_VERSION,
    store,
    service,
    memory,
    // 会话层可能晚到：用 getter，调用方总能读到最新挂载结果。
    get sessions() {
      return sessions
    },
    get reconciler() {
      return reconciler
    },
    get dispatchService() {
      return dispatchService
    },
    get hasSessions() {
      return hasSessions
    },
    attachSessions,
    presetId,
    connectDepartment,
    dispatchTask,
    ingestAgentOutput,
    bootstrap: (projectId) => service.bootstrap(projectId),
    listEvents: (projectId, since, opts) => service.listEvents(projectId, since, opts),
    start,
    dispose,
  })
}

function createStore(options) {
  const file = options.storeFile ?? defaultStorePath(process.env)
  const store = new WorkbenchStore({ file })
  try {
    store.load()
  } catch {
    // 读到坏账本时不静默清空：由 paths.quarantineFile 在 HTTP 层隔离，这里保持空账可写。
  }
  return store
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 必须是非空字符串`)
  return value
}

export { CONTRACT_ACTIONS, CONTRACT_ACTION_PREFIX, parseContractLines, describeContract }
