// 工作台业务服务：纯业务，不碰 HTTP、不碰宿主会话 API。
//
// 三类职责：
// 1. 入口校验（项目隔离）：凡是以实体 ID 为参数的调用，先确认项目存在，
//    再确认目标记录属于该项目。伪造 ID 与跨项目引用各自返回确定的错误码，
//    且不泄露“别的项目里有没有这条记录”。
// 2. 契约操作：registerProject / listSeats / bindDepartmentSession / saveDepartmentConfig /
//    createTask / dispatchTask / reportTaskResult / requestTaskInput / syncDecision。
// 3. 投影：bootstrap 一次拿全（项目列表 + 十席 + 任务 + 成果），UI 只读投影。
//
// 幂等与状态机全部下沉到 core：store.recordDispatch / store.recordResult 自带去重，
// tasks.decide 负责完成判定。这里只做三件事：组织一次事务、把 core 异常翻成带 code 的业务错误、
// 保证任何返回值都是副本（调用方改返回值改不到账本）。

import { isIdOf } from '../core/ids.mjs'
import { ROLES, isRoleId, layoutGroups } from '../core/roles.mjs'
import { isTerminal } from '../core/states.mjs'
import {
  applyDecision,
  beginAttempt,
  cancelTask as cancelTaskDecision,
  createTask as createTaskRecord,
  decide,
  isOpenTask,
  startTask,
} from '../core/tasks.mjs'
import { StoreError } from '../core/store.mjs'

export const WORKBENCH_SERVICE_VERSION = 1

/** 错误码：路由层据此映射 HTTP 状态码，调用方据此分支，永远不解析 message。 */
export const SERVICE_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_ROLE: 'INVALID_ROLE',
  NOT_FOUND: 'NOT_FOUND',
  CROSS_PROJECT: 'CROSS_PROJECT',
  CONFIG_CONFLICT: 'CONFIG_CONFLICT',
  SESSION_CONFLICT: 'SESSION_CONFLICT',
  DUPLICATE_PROJECT: 'DUPLICATE_PROJECT',
  INVALID_STATE: 'INVALID_STATE',
  DISPATCH_INVALID: 'DISPATCH_INVALID',
  ATTEMPT_MISMATCH: 'ATTEMPT_MISMATCH',
  REPORT_INVALID: 'REPORT_INVALID',
  INTERNAL: 'INTERNAL',
})

export class ServiceError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// ---------- 纯工具 ----------

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `${field} 必须是非空字符串`, { field })
  }
  return value
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `${field} 必须是字符串或 null`, { field })
  }
  return value
}

function requireRole(value, field) {
  if (!isRoleId(value)) {
    throw new ServiceError(SERVICE_CODES.INVALID_ROLE, `${field} 不是已知部门: ${String(value)}`, { field })
  }
  return value
}

function requireBool(value, field) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') {
    throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `${field} 必须是布尔值`, { field })
  }
  return value
}

function optionalArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `${field} 必须是数组`, { field })
  return value.map((item) => (typeof item === 'string' ? item : JSON.parse(JSON.stringify(item))))
}

/** 深拷贝：对外只给副本，避免调用方拿到账本里的同一个对象。 */
function copy(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value))
}

/** store 的 Getter 名 → 实体名（ID 前缀）与集合名（归属校验用）。 */
const GETTERS = Object.freeze({
  project: { get: 'getProject', entity: 'project', prefix: 'project' },
  task: { get: 'getTask', entity: 'task', prefix: 'task' },
  attempt: { get: 'getAttempt', entity: 'attempt', prefix: 'attempt' },
  dispatch: { get: 'getDispatch', entity: 'dispatch', prefix: 'dispatch' },
  result: { get: 'getResult', entity: 'result', prefix: 'result' },
  artifact: { get: 'getArtifact', entity: 'artifact', prefix: 'artifact' },
})

/**
 * 宿主运行终态：只认 成功 / 失败 / 取消 / 仍在跑。
 * 未知字符串一律拒绝——把 "done" 当成功正是方案 §7.3 明令禁止的猜测。
 */
const RUN_TERMINALS = Object.freeze(['succeeded', 'failed', 'cancelled', 'running'])
function normalizeRunTerminal(value, field = 'runTerminal') {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !RUN_TERMINALS.includes(value)) {
    throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `${field} 取值非法: ${String(value)}`, { allowed: RUN_TERMINALS })
  }
  return value
}

/** 宿主终态 → attempt 状态。attempt 跟着落，但业务结论只由 tasks.decide 给。 */
const ATTEMPT_STATE_OF_RUN = Object.freeze({ succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' })

export function createWorkbenchService(options = {}) {
  const { store, clock = Date.now, env = process.env, fileExists = null, memory = null } = options
  if (store === undefined || store === null || typeof store.mutate !== 'function') {
    throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'createWorkbenchService 需要 WorkbenchStore')
  }

  const nowIso = () => new Date(clock()).toISOString()

  // ---------- 异常翻译 ----------

  /**
   * core 的异常统一翻成 ServiceError，保留 code 与 details。
   * CROSS_PROJECT 的 message 改写成不含其他项目 ID 的版本，避免把归属泄露出去。
   */
  function translate(error) {
    if (error instanceof ServiceError) return error
    if (error instanceof StoreError) {
      const details = error.details
      switch (error.code) {
        case 'CROSS_PROJECT':
          return new ServiceError(SERVICE_CODES.CROSS_PROJECT, '引用的记录不属于本项目', details)
        case 'NOT_FOUND':
          return new ServiceError(SERVICE_CODES.NOT_FOUND, error.message, details)
        case 'CAS_CONFLICT':
          return new ServiceError(SERVICE_CODES.CONFIG_CONFLICT, error.message, details)
        case 'SESSION_CONFLICT':
          return new ServiceError(SERVICE_CODES.SESSION_CONFLICT, error.message, details)
        case 'DUPLICATE_PROJECT':
          return new ServiceError(SERVICE_CODES.DUPLICATE_PROJECT, error.message, details)
        case 'INVALID_ROLE':
          return new ServiceError(SERVICE_CODES.INVALID_ROLE, error.message, details)
        case 'INVALID_INPUT':
          return new ServiceError(SERVICE_CODES.INVALID_INPUT, error.message, details)
        case 'DUPLICATE_ID':
          // ID 由随机源生成却撞了已有记录：属于宿主侧内部故障，不是调用方的错，
          // 更不能伪装成"当前状态不接受该操作"。
          return new ServiceError(SERVICE_CODES.INTERNAL, `生成的主键重复（${error.message}），请检查随机源`, { ...details, storeCode: error.code })
        default:
          // INVALID_STATE / INVALID_ID / CORRUPT 等：状态机与形状问题，
          // 对调用方而言都是“当前数据不接受这个操作”，归到 INVALID_STATE，code 保留在 details。
          return new ServiceError(SERVICE_CODES.INVALID_STATE, error.message, { ...details, storeCode: error.code })
      }
    }
    // tasks.mjs 的 TaskError：code 语义已经够用，原样带出（INVALID_STATE / ACTIVE_ATTEMPT / CROSS_TASK 等）。
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
      return new ServiceError(error.code, error.message, error.details)
    }
    const wrapped = new ServiceError(SERVICE_CODES.INTERNAL, error instanceof Error ? error.message : String(error))
    wrapped.cause = error
    return wrapped
  }

  /** 包一层：把同步异常翻译成 ServiceError，调用点就不必逐处 try/catch。 */
  function guard(fn) {
    return (...args) => {
      try {
        return fn(...args)
      } catch (error) {
        throw translate(error)
      }
    }
  }

  // ---------- 项目隔离 ----------

  /**
   * 项目必须存在。不存在与伪造同一个返回：凡不可见的项目都是 NOT_FOUND，
   * 调用方无法用它区分“没有这个项目”和“这个项目不属于你”。
   */
  function projectIdOf(input) {
    const projectId = input === null || typeof input !== 'object' ? input : input.projectId
    if (typeof projectId !== 'string' || !isIdOf('project', projectId)) {
      throw new ServiceError(SERVICE_CODES.NOT_FOUND, '项目不存在', { field: 'projectId' })
    }
    const project = store.getProject(projectId)
    if (project === undefined) throw new ServiceError(SERVICE_CODES.NOT_FOUND, '项目不存在', { field: 'projectId' })
    return project
  }

  /**
   * 归属校验的公共实现：先验项目，再验 ID 形状，最后验归属。
   * - ID 形状非法或查不到  → NOT_FOUND（伪造/已删不可区分）
   * - 查到了但 projectId 不符 → CROSS_PROJECT
   * 返回值里不带任何其他项目的字段。
   */
  function ownedRow(project, kind, id, field) {
    const spec = GETTERS[kind]
    if (typeof id !== 'string' || !isIdOf(spec.prefix, id)) {
      throw new ServiceError(SERVICE_CODES.NOT_FOUND, `${field} 不存在`, { field })
    }
    const row = store[spec.get](id)
    if (row === undefined || row === null) throw new ServiceError(SERVICE_CODES.NOT_FOUND, `${field} 不存在`, { field })
    if (row.projectId !== project.id) {
      throw new ServiceError(SERVICE_CODES.CROSS_PROJECT, `${field} 不属于本项目`, { field })
    }
    return row
  }

  const requireTask = (project, id) => ownedRow(project, 'task', id, 'taskId')
  const requireAttempt = (project, id) => ownedRow(project, 'attempt', id, 'attemptId')

  function requireSeat(project, roleId) {
    requireRole(roleId, 'roleId')
    const binding = store.getBinding(project.id, roleId)
    const config = store.getConfig(project.id, roleId)
    if (binding === undefined || config === undefined) {
      throw new ServiceError(SERVICE_CODES.NOT_FOUND, `项目中缺少 ${roleId} 的席位记录，账本可能未初始化`, { roleId })
    }
    // 引用校验要用 bindings.id 这个真实键；角色名不是键。
    // 注意 core 的 store.state.bindings 以 `${projectId}\u0000${roleId}` 为键，
    // 所以派发时直接内联绑定对象，不再把 binding.id 透传给 _checkReferences。
    return { binding, config }
  }

  // ---------- 项目 ----------

  /**
   * 路径归一：Windows 大小写不敏感、反斜杠与正斜杠等价、末尾分隔符不算差异。
   * 约定用不了真实 canonicalize（junction / 短路径要碰文件系统），所以只做到“字符串级等价”，
   * 命中时明确说这是识别到的冲突，而不是宣称已经做了完全隔离。
   */
  function normalizeRoot(path) {
    if (typeof path !== 'string' || path.trim() === '') return null
    return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  /**
   * A20：同一目录（含父子目录、junction 指向同一目标）不能登记成两个互不相干的项目。
   * 只识别、不篡改：命中就报明确的 relation，调用方要么换目录，要么显式 allowSharedRoot。
   */
  function rootConflict(self, canonicalRoot) {
    const mine = normalizeRoot(canonicalRoot)
    if (mine === null) return null
    for (const other of store.listProjects()) {
      if (other.id === self?.id) continue
      const theirs = normalizeRoot(other.canonicalRoot)
      if (theirs === null) continue
      if (mine === theirs) {
        return { relation: 'same', otherProjectId: other.id, otherHostWorkspaceId: other.hostWorkspaceId, otherRoot: other.canonicalRoot }
      }
      if (mine.startsWith(`${theirs}/`) || theirs.startsWith(`${mine}/`)) {
        return { relation: 'nested', otherProjectId: other.id, otherHostWorkspaceId: other.hostWorkspaceId, otherRoot: other.canonicalRoot }
      }
    }
    return null
  }

  /**
   * 登记项目。同一 hostWorkspaceId 只会得到一个 projectId：
   * UI 重复进入同一工作区不该产生两个项目，也不该把已有任务晾在新项目里。
   */
  const registerProject = guard((input = {}) => {
    const hostWorkspaceId = requireText(input.hostWorkspaceId, 'hostWorkspaceId')
    const displayNameCache = input.displayNameCache === undefined ? '' : String(input.displayNameCache ?? '')
    const canonicalRoot = optionalText(input.canonicalRoot, 'canonicalRoot')
    const existing = store.listProjects().find((row) => row.hostWorkspaceId === hostWorkspaceId)
    // 目录冲突先查：两个工作区挂在同一目录（或父子目录）时，任务与会话会互相串，
    // 这不是“用户想要两个项目”，而是登记错误，必须在写账之前拦住。
    const conflict = rootConflict(existing, canonicalRoot)
    if (conflict !== null && input.allowSharedRoot !== true) {
      throw new ServiceError(
        SERVICE_CODES.DUPLICATE_PROJECT,
        conflict.relation === 'same'
          ? '这个目录已经登记为另一个项目了；同一个目录不会自动隔离'
          : '这个目录与已登记的项目是父子关系，两者不会自动隔离',
        { ...conflict, hint: 'allowSharedRoot' },
      )
    }
    if (existing !== undefined) {
      const patch = {}
      if (existing.displayNameCache !== displayNameCache) patch.displayNameCache = displayNameCache
      if (existing.canonicalRoot !== canonicalRoot) patch.canonicalRoot = canonicalRoot
      const project = Object.keys(patch).length > 0 ? store.updateProject(existing.id, patch) : existing
      return { project: copy(project), duplicate: true, sharedRoot: conflict }
    }
    try {
      const projectId = store.createProject({ hostWorkspaceId, displayNameCache, canonicalRoot })
      return { project: copy(store.getProject(projectId)), duplicate: false, sharedRoot: conflict }
    } catch (error) {
      // 两个窗口同时登记：唯一性在 store 内检查，竞态也归成 duplicate。
      if (error instanceof StoreError && error.code === 'DUPLICATE_PROJECT') {
        const again = store.listProjects().find((row) => row.hostWorkspaceId === hostWorkspaceId)
        if (again !== undefined) return { project: copy(again), duplicate: true, sharedRoot: conflict }
      }
      throw error
    }
  })

  /** 项目列表：只给投影需要的计数，不把其他项目的实体带出来。 */
  function listProjects() {
    return store.listProjects().map((project) => {
      const tasks = store.listTasks(project.id)
      return {
        ...copy(project),
        seatCount: ROLES.length,
        taskCount: tasks.length,
        openTaskCount: tasks.filter((task) => isOpenTask(task)).length,
      }
    })
  }

  function getProject(projectId) {
    return copy(projectIdOf({ projectId }))
  }

  // ---------- 十席 ----------

  /**
   * 十席布局 + 每席现状。
   * connected=false 即“尚未接通”：没有会话或绑定失效时，UI 不能显示可派工。
   */
  function seatView(project, seat) {
    const binding = store.getBinding(project.id, seat.id)
    const config = store.getConfig(project.id, seat.id)
    const sessionId = binding?.currentSessionId ?? null
    const status = binding?.status ?? 'uninitialized'
    const connected = sessionId !== null && status !== 'unavailable'
    const activeTask = store
      .listTasks(project.id)
      .filter((task) => task.ownerRoleId === seat.id && isOpenTask(task))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
    return {
      roleId: seat.id,
      name: seat.name,
      short: seat.short,
      tier: seat.tier,
      group: seat.group,
      column: seat.column,
      row: seat.row,
      duty: seat.duty,
      canDispatch: seat.canDispatch === true,
      connected,
      pending: !connected,
      pendingLabel: connected ? null : (status === 'unavailable' ? '绑定失效，需重新接通' : '尚未接通'),
      activeTaskId: activeTask?.id ?? null,
      binding: {
        id: binding?.id ?? null,
        currentSessionId: sessionId,
        // 生成序号是派发时的护栏：换绑后旧序号失效，旧消息不会被送进新会话。
        bindingGeneration: binding?.bindingGeneration ?? 0,
        status,
        historyCount: binding?.historySessionRefs?.length ?? 0,
        revision: binding?.revision ?? 0,
      },
      // 只给 provider/model/effort 名字与修订号，不给任何凭据。
      config: {
        provider: config?.providerId ?? null,
        model: config?.modelId ?? null,
        reasoningEffort: config?.reasoningEffort ?? null,
        configRevision: config?.configRevision ?? 0,
        configured: Boolean(config?.providerId && config?.modelId),
      },
    }
  }

  /** 配置的对外视图：provider/model 与账本的 providerId/modelId 只在这一处转换。 */
  function configView(config) {
    if (config === undefined || config === null) return null
    return {
      roleId: config.roleId ?? null,
      provider: config.providerId ?? null,
      model: config.modelId ?? null,
      reasoningEffort: config.reasoningEffort ?? null,
      configRevision: config.configRevision ?? 0,
      updatedAt: config.updatedAt ?? null,
    }
  }

  function listSeats(projectId) {
    const project = projectIdOf({ projectId })
    return ROLES.map((seat) => seatView(project, seat))
  }

  function layout() {
    return layoutGroups()
  }

  // ---------- 绑定 ----------

  /**
   * 绑定部门会话。唯一性与“已绑定时是否允许替换”都在 store 里判定，
   * 这里只把 SESSION_CONFLICT / CROSS_PROJECT 原样带出（含 code 与 details.heldBy），
   * 让 UI 能说清“这个会话正在被谁持有”，而不是笼统的 500。
   */
  const bindDepartmentSession = guard((input = {}) => {
    const project = projectIdOf(input)
    const roleId = requireRole(input.roleId, 'roleId')
    const sessionId = requireText(input.sessionId, 'sessionId')
    const allowReplace = requireBool(input.allowReplace, 'allowReplace')
    const creationRequestId = optionalText(input.creationRequestId, 'creationRequestId')
    try {
      const binding = store.bindSession(project.id, roleId, sessionId, { allowReplace, creationRequestId })
      return { binding: copy(binding), seat: seatView(project, ROLES.find((seat) => seat.id === roleId)) }
    } catch (error) {
      if (error instanceof StoreError && error.code === 'SESSION_CONFLICT') {
        // 失败分支不带 seat：绑定没变，别让前端误以为状态已更新。
        throw translate(error)
      }
      throw translate(error)
    }
  })

  /** 解除绑定：旧会话进历史，不删除记录。释放后同一 sessionId 才能绑到别处。 */
  const releaseDepartmentSession = guard((input = {}) => {
    const project = projectIdOf(input)
    const roleId = requireRole(input.roleId, 'roleId')
    requireSeat(project, roleId)
    return { binding: copy(store.releaseBinding(project.id, roleId)) }
  })

  /** 部门运行态（uninitialized/idle/queued/running/unavailable），由适配器回执驱动。 */
  const setDepartmentStatus = guard((input = {}) => {
    const project = projectIdOf(input)
    const roleId = requireRole(input.roleId, 'roleId')
    requireSeat(project, roleId)
    const status = requireText(input.status, 'status')
    return { binding: copy(store.setBindingStatus(project.id, roleId, status)) }
  })

  // ---------- 配置（CAS） ----------

  /**
   * 保存部门模型设置。CAS 冲突必须把“当前值”一起返回，
   * 否则 UI 只能提示“保存失败”，用户无从判断是自己过时还是别人改的。
   */
  const saveDepartmentConfig = guard((input = {}) => {
    const project = projectIdOf(input)
    const roleId = requireRole(input.roleId, 'roleId')
    requireSeat(project, roleId)
    if (!Number.isInteger(input.expectedRevision)) {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'expectedRevision 必须是整数', { field: 'expectedRevision' })
    }
    if (input.reasoningEffort !== undefined && input.reasoningEffort !== null
      && typeof input.reasoningEffort !== 'string') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'reasoningEffort 必须是字符串或 null', { field: 'reasoningEffort' })
    }
    try {
      const config = store.saveConfig(project.id, roleId, {
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
      }, input.expectedRevision)
      // 出参用对外口径（provider/model），不把账本里的 providerId/modelId 漏给 UI：
      // 两套命名混用迟早在某处接错。
      return { config: configView(config), configRevision: config.configRevision }
    } catch (error) {
      if (error instanceof StoreError && error.code === 'CAS_CONFLICT') {
        const details = error.details ?? {}
        throw new ServiceError(SERVICE_CODES.CONFIG_CONFLICT, '配置已被其他窗口修改，请读回后再保存', {
          roleId,
          expectedRevision: details.expectedRevision ?? input.expectedRevision,
          currentRevision: details.currentRevision ?? null,
          current: details.current ?? null,
        })
      }
      throw error
    }
  })

  /**
   * 先做不花 ID 的前置校验（角色、状态取值、部门是否接通），
   * 再进主流程取 ID。失败时一个 ID 都不该被消耗：ID 是业务主键，
   * 让失败请求"吃掉"ID 会让重试与断言都对不上。
   */
  function preflightCreateTask(input) {
    if (input === null || typeof input !== 'object') return input
    const sourceRoleId = input.sourceRoleId === undefined ? 'lead' : requireRole(input.sourceRoleId, 'sourceRoleId')
    const ownerRoleId = requireRole(input.ownerRoleId, 'ownerRoleId')
    const wanted = input.status === undefined ? 'queued' : input.status
    if (wanted !== 'queued' && wanted !== 'draft') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `新建任务只能是 queued 或 draft，收到 ${String(wanted)}`, { field: 'status' })
    }
    if (wanted === 'queued' && typeof input.projectId === 'string' && isIdOf('project', input.projectId)) {
      const binding = store.getBinding(input.projectId, ownerRoleId)
      if (binding?.currentSessionId === null || binding?.currentSessionId === undefined) {
        throw new ServiceError(SERVICE_CODES.INVALID_STATE, `${ownerRoleId} 尚未接通会话，不能直接入队；可先存草稿`, {
          roleId: ownerRoleId,
          hint: 'draft',
        })
      }
    }
    return input
  }

  // ---------- 任务 ----------

  /**
   * 建任务。默认直接入队（queued）；status='draft' 时保持草稿。
   * 入队前要求主责部门已接通：派给一个没有会话的部门只会在派发阶段撞 unknown。
   */
  const createTask = guard((input = {}) => {
    input = preflightCreateTask(input)
    const project = projectIdOf(input)
    const ownerRoleId = requireRole(input.ownerRoleId, 'ownerRoleId')
    const sourceRoleId = input.sourceRoleId === undefined ? 'lead' : requireRole(input.sourceRoleId, 'sourceRoleId')
    const wanted = input.status === undefined ? 'queued' : input.status
    if (wanted !== 'queued' && wanted !== 'draft') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `新建任务只能是 queued 或 draft，收到 ${String(wanted)}`, { field: 'status' })
    }
    if (wanted === 'queued') {
      const binding = store.getBinding(project.id, ownerRoleId)
      if (binding?.currentSessionId === null || binding?.currentSessionId === undefined) {
        throw new ServiceError(SERVICE_CODES.INVALID_STATE, `${ownerRoleId} 尚未接通会话，不能直接入队；可先存草稿`, {
          roleId: ownerRoleId,
          hint: 'draft',
        })
      }
    }
    // 先按入队语义校验通过再取 ID：校验失败不该消耗掉一个 ID，
    // 否则同一测试里连续建任务的 ID 会与预期错位。
    const record = createTaskRecord({
      projectId: project.id,
      title: input.title,
      objective: input.objective,
      acceptance: optionalArray(input.acceptance, 'acceptance'),
      constraints: optionalArray(input.constraints, 'constraints'),
      scope: input.scope ?? null,
      ownerRoleId,
      sourceRoleId,
      originMessageRef: optionalText(input.originMessageRef, 'originMessageRef'),
      returnTarget: input.returnTarget ?? null,
    }, { newTaskId: () => store.ids.task(), now: nowIso })
    const queued = wanted === 'queued' ? startTask(record, { now: nowIso }) : record
    return { task: copy(store.insertTask(queued)) }
  })

  function getTask(projectId, taskId) {
    const project = projectIdOf({ projectId })
    return copy(requireTask(project, taskId))
  }

  /** 任务列表：附开放标记与尝试/结果计数，UI 不必为每行再发请求。 */
  function listTasks(projectId, filter = {}) {
    const project = projectIdOf({ projectId })
    if (filter.ownerRoleId !== undefined) requireRole(filter.ownerRoleId, 'ownerRoleId')
    return store
      .listTasks(project.id)
      .filter((task) => filter.status === undefined || task.status === filter.status)
      .filter((task) => filter.ownerRoleId === undefined || task.ownerRoleId === filter.ownerRoleId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((task) => ({
        ...copy(task),
        open: isOpenTask(task),
        attemptCount: store.listAttempts(task.id).length,
        resultCount: store.listResults(task.id).length,
      }))
  }

  /**
   * 取消任务。业务上立即落 cancelled，但运行的尝试只到 cancel_requested：
   * 宿主取消是另一条腿，不能在这里假装已经停了（宿主记录 L6：cancel 不撤回排队消息）。
   */
  const cancelTask = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    const reason = input.reason === undefined ? '用户取消' : requireText(input.reason, 'reason')
    const decision = cancelTaskDecision(task, reason, { now: nowIso })
    const applied = applyDecision(store, task.id, decision)
    let attempt = null
    let cancelRequest = null
    const activeId = task.activeAttemptId
    if (activeId !== null && activeId !== undefined) {
      const current = store.getAttempt(activeId)
      if (current !== undefined && current.projectId === project.id && !isTerminal('attempt', current.state)) {
        if (current.state === 'queued') {
          attempt = store.updateAttempt(current.id, { state: 'cancelled', endedAt: nowIso() })
        } else if (current.state === 'running') {
          attempt = store.updateAttempt(current.id, { state: 'cancel_requested', cancelRequestedAt: nowIso() })
          // 交给适配器去调宿主 cancel；这里只声明“该取消哪个运行”。
          cancelRequest = { projectId: project.id, taskId: task.id, attemptId: current.id, hostRunId: current.hostRunId ?? null }
        } else {
          attempt = current
        }
      }
    }
    return {
      task: copy(applied.task),
      applied: applied.applied === true,
      reason: applied.reason ?? null,
      attempt: copy(attempt),
      cancelRequest,
    }
  })

  // ---------- 派发 ----------

  /**
   * dispatchTask：一次事务写三样东西——dispatch(prepared) + contextPacket + attempt(queued)。
   * 三者同生共死，崩溃时不会留下“有派发没尝试”或“有尝试没交接材料”的半条记录。
   *
   * 幂等：同一 (projectId, idempotencyKey) 只会有一条 dispatch。
   * 命中时把挂在它上面的 attempt/上下文包一起返回，duplicate=true，不新建任何记录——
   * 派发可能已经投递出去，重写一条等于假装配送了两次。
   */
  const dispatchTask = guard((input = {}) => {
    const project = projectIdOf(input)
    let task = requireTask(project, input.taskId)
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey')

    const existing = store.findDispatchByIdempotencyKey(project.id, idempotencyKey)
    if (existing !== undefined) return dispatchView(existing, true)

    if (isTerminal('task', task.status)) {
      throw new ServiceError(SERVICE_CODES.INVALID_STATE, `任务已终态（${task.status}），不能再次派发`, { status: task.status })
    }
    if (task.status === 'running') {
      throw new ServiceError(SERVICE_CODES.INVALID_STATE, '任务正在执行，派发前需先对账当前尝试', { status: task.status })
    }
    const targetRoleId = input.targetRoleId === undefined ? task.ownerRoleId : requireRole(input.targetRoleId, 'targetRoleId')
    if (targetRoleId !== task.ownerRoleId) {
      throw new ServiceError(SERVICE_CODES.DISPATCH_INVALID, '派发目标必须与任务主责部门一致', {
        targetRoleId,
        ownerRoleId: task.ownerRoleId,
      })
    }
    const sourceRoleId = input.sourceRoleId === undefined ? task.sourceRoleId : requireRole(input.sourceRoleId, 'sourceRoleId')
    const target = requireSeat(project, targetRoleId)
    const sessionId = input.targetSessionId === undefined ? target.binding.currentSessionId : optionalText(input.targetSessionId, 'targetSessionId')
    if (sessionId === null || sessionId === undefined) {
      throw new ServiceError(SERVICE_CODES.INVALID_STATE, `${targetRoleId} 尚未接通会话，不能派发`, { roleId: targetRoleId })
    }
    if (target.binding.currentSessionId !== null && target.binding.currentSessionId !== sessionId) {
      // 调用方拿着旧会话号派发：这是换绑后的典型故障，必须显式失败而不是投给新会话。
      throw new ServiceError(SERVICE_CODES.SESSION_CONFLICT, 'targetSessionId 与当前绑定不一致，请重新读取席位后再派发', {
        currentSessionId: target.binding.currentSessionId,
      })
    }
    if (input.bindingGeneration !== undefined && input.bindingGeneration !== target.binding.bindingGeneration) {
      throw new ServiceError(SERVICE_CODES.SESSION_CONFLICT, 'bindingGeneration 已变化，派发目标可能已被换绑', {
        expected: input.bindingGeneration,
        current: target.binding.bindingGeneration,
      })
    }
    const sourceBinding = store.getBinding(project.id, sourceRoleId)
    const sourceSessionId = input.sourceSessionId === undefined
      ? sourceBinding?.currentSessionId ?? null
      : optionalText(input.sourceSessionId, 'sourceSessionId')
    const packet = input.packet === undefined || input.packet === null ? {} : input.packet
    if (typeof packet !== 'object' || Array.isArray(packet)) {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'packet 必须是对象', { field: 'packet' })
    }
    // 记忆注入：派发时把部门记忆、项目记忆与长期记忆的摘录并进交接材料，
    // 部门开工前就能看到「自己以前摸出的经验」「这个项目之前发生过什么」
    // 与「用户长期偏好」。记忆是参考资料：读失败不拦派发，按没有记忆处理。
    let memoryExcerpts = []
    if (memory !== null) {
      try {
        memoryExcerpts = memory.excerptsFor(project.id, task.ownerRoleId)
      } catch {
        memoryExcerpts = []
      }
    }
    // 修订任务默认把「要改的那份成果 + 版本」带进交接材料：
    // 主责部门不需要回头翻记录，也不会改到别的版本上。
    const revisionMaterials = task.scope?.kind === 'artifact-revision' && typeof task.scope.artifactId === 'string'
      ? [{ artifactId: task.scope.artifactId, revision: Number(task.scope.revision ?? 1) }]
      : []

    // 派工本身就意味着“开始干”。草稿还停在 draft 时必须先入队：
    // beginAttempt 只接受 queued/waiting_input/needs_attention/running，draft 会被拒，
    // 而拒绝发生在消息已经发出之后 —— 结果是「部门收到了、账上记 unknown、任务不前进」。
    // 放在所有校验之后、写账之前：校验不过就不该改动任务状态。
    if (task.status === 'draft') {
      task = store.updateTask({ ...task, status: 'queued', queuedAt: nowIso() })
    }

    const committed = store.mutate(() => {
      const stamp = nowIso()
      const attemptId = store.ids.attempt()
      const dispatchId = store.ids.dispatch()
      const contextPacketId = store.ids.contextPacket()
      // 交接材料版本号：同任务内递增，重派不覆盖上一版的验收标准与摘录。
      const version = [...store.state.contextPackets.values()]
        .filter((row) => row.taskId === task.id)
        .reduce((max, row) => Math.max(max, Number(row.version) || 0), 0) + 1

      store.insertContextPacket({
        id: contextPacketId,
        projectId: project.id,
        taskId: task.id,
        version,
        objective: packet.objective ?? task.objective,
        acceptance: packet.acceptance === undefined ? task.acceptance : optionalArray(packet.acceptance, 'packet.acceptance'),
        constraints: packet.constraints === undefined ? task.constraints : optionalArray(packet.constraints, 'packet.constraints'),
        originMessageRef: packet.originMessageRef ?? task.originMessageRef,
        excerpts: [...optionalArray(packet.excerpts, 'packet.excerpts'), ...memoryExcerpts],
        materialRefs: normalizeMaterialRefs(
          packet.materialRefs === undefined ? revisionMaterials : packet.materialRefs,
          project,
        ),
        authorizationRefs: optionalArray(packet.authorizationRefs, 'packet.authorizationRefs'),
        scope: packet.scope ?? task.scope,
        expectedOutputs: optionalArray(packet.expectedOutputs, 'packet.expectedOutputs'),
        returnTarget: packet.returnTarget ?? task.returnTarget ?? { roleId: task.sourceRoleId },
        createdAt: stamp,
      })

      // 注意顺序：dispatches 的引用表会校验 attemptId 与 contextPacketId，
      // 所以必须先有 attempt 与上下文包，再写派发；否则 recordDispatch 会报“引用不存在”。
      store.insertAttempt({
        id: attemptId,
        projectId: project.id,
        taskId: task.id,
        dispatchId: null,
        // 不传 bindingId：core 的 bindings 表以 projectId+roleId 复合键存放，binding.id 不是键。
        // 席位归属已由 requireSeat(project, targetRoleId) 保证。
        sessionId,
        hostRunId: null,
        state: 'queued',
        // 派发时把模型设置快照下来：之后改配置不影响这一次运行。
        effectiveConfigSnapshot: {
          provider: target.config.providerId,
          model: target.config.modelId,
          reasoningEffort: target.config.reasoningEffort ?? null,
          configRevision: target.config.configRevision,
        },
        error: null,
        createdAt: stamp,
        startedAt: null,
        endedAt: null,
      })

      const recorded = store.recordDispatch({
        projectId: project.id,
        taskId: task.id,
        attemptId,
        sourceSessionId,
        targetSessionId: sessionId,
        // 同上：席位归属由 requireSeat 保证，这里只记换绑护栏用的 generation。
        bindingGeneration: target.binding.bindingGeneration,
        contextPacketId,
        idempotencyKey,
        status: 'prepared',
      })
      // attempt 先插、派发后写：这里把 dispatchId 补回尝试，两表互指成立。
      store.updateAttempt(attemptId, { dispatchId: recorded.dispatch.id })
      return recorded.dispatch.id
    })

    return dispatchView(store.getDispatch(committed.value), false)
  })

  /** 把一条 dispatch 连同挂在它上面的尝试、上下文包、任务一起投影。 */
  function dispatchView(dispatch, duplicate) {
    const attempt = dispatch.attemptId === null ? null : store.getAttempt(dispatch.attemptId)
    const packet = dispatch.contextPacketId === null ? null : store.getContextPacket(dispatch.contextPacketId)
    const task = dispatch.taskId === null ? null : store.getTask(dispatch.taskId)
    return {
      dispatch: copy(dispatch),
      attempt: copy(attempt ?? null),
      contextPacket: copy(packet ?? null),
      task: copy(task ?? null),
      duplicate,
    }
  }

  /** 派发状态推进（由适配器拿宿主回执驱动）：走 store 的状态机，不接受跳跃。 */
  const markDispatch = guard((input = {}) => {
    const project = projectIdOf(input)
    const dispatch = ownedRow(project, 'dispatch', input.dispatchId, 'dispatchId')
    const patch = {}
    if (input.status !== undefined) patch.status = input.status
    if (input.hostMessageId !== undefined) patch.hostMessageId = optionalText(input.hostMessageId, 'hostMessageId')
    return { dispatch: copy(store.updateDispatch(dispatch.id, patch)) }
  })

  // ---------- 结果 ----------

  /**
   * 登记尝试推进（适配器在宿主侧拿到 runId/开跑回执后调用）。
   * 用 core 的 beginAttempt：任务进入 running 且 activeAttemptId 指向这次尝试。
   */
  const startAttempt = guard((input = {}) => {
    const project = projectIdOf(input)
    // taskId 可省：Attempt 自己知道属于哪个任务。传入时必须与它对上，
    // 免得 UI 拿错 ID 把别的任务推进 running。
    const attempt = requireAttempt(project, input.attemptId)
    const task = requireTask(project, input.taskId ?? attempt.taskId)
    if (attempt.taskId !== task.id) {
      throw new ServiceError(SERVICE_CODES.ATTEMPT_MISMATCH, '尝试不属于该任务', { attemptId: attempt.id })
    }
    const hostRunId = optionalText(input.hostRunId, 'hostRunId')
    let next = attempt
    if (attempt.state === 'queued') {
      next = store.updateAttempt(attempt.id, { state: 'running', hostRunId, startedAt: nowIso() })
    } else if (hostRunId !== null && attempt.hostRunId !== hostRunId) {
      next = store.updateAttempt(attempt.id, { hostRunId })
    }
    // core 的 beginAttempt 只计算新对象不写库，所以这里显式落库：
    // 成功即“任务进入 running 且 activeAttemptId 指向这次尝试”。
    // 只把 Attempt 推到 running 是不够的：任务的 run_terminal 判定要求它当时处于 running，
    // 否则"运行结束但无报告"会被当成"还在排队"，needs_attention 永远落不下来。
    // core 的 beginAttempt 在任务仍为 queued 时会连同任务一起推进到 running。
    const decision = beginAttempt(task, next, { now: nowIso, attemptLookup: (id) => store.getAttempt(id) })
    const persisted = store.updateTask(decision)
    return { task: copy(persisted), attempt: copy(store.getAttempt(attempt.id)), applied: true, reason: null }
  })

  /**
   * reportTaskResult：登记结构化结果 + 完成判定，一次事务内完成。
   *
   * 去重先于一切写入：同一 (attemptId, reportVersion) 或同一条 sourceMessageRef
   * 只登记一次，命中时返回旧结果且 applied=false，不重跑判定、不动 revision。
   *
   * 判定交给 core/tasks.decide（kind:'completion'），服务层实际落地四种结果：
   * 1. completed      —— 报告可信 + 宿主终态 succeeded + 成果引用有效；
   * 2. needs_attention—— 宿主终态 succeeded 但报告不可信（含标记了阻塞原因）；
   * 3. 保持不变(applied:false) —— 报告可信但宿主还没结束（candidate），等终态再定，
   *    此处把报告登记进账，任务停在 running/queued，不显示已完成；
   * 4. 等待结构化报告 —— 报告先到、终态后到的顺序由 reportRunTerminal 补齐。
   * 任务已终态时迟到报告只登记、不改结论（stale）。
   */
  const reportTaskResult = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    const attempt = requireAttempt(project, input.attemptId)
    if (attempt.taskId !== task.id) {
      throw new ServiceError(SERVICE_CODES.ATTEMPT_MISMATCH, '尝试不属于该任务', { attemptId: attempt.id })
    }
    const report = input.report
    if (report === null || typeof report !== 'object' || Array.isArray(report)) {
      throw new ServiceError(SERVICE_CODES.REPORT_INVALID, 'report 必须是对象', { field: 'report' })
    }
    const summary = requireText(report.summary, 'report.summary')
    const runTerminal = normalizeRunTerminal(input.runTerminal ?? report.runTerminal)
    const artifactRefs = optionalArray(input.artifactRefs ?? report.artifactRefs, 'artifactRefs')
    // 成果引用必须指向本项目现存成果：账上查不到就是伪造或已删，直接拒绝，不记空引用。
    for (const ref of artifactRefs) {
      ownedRow(project, 'artifact', ref, 'artifactRefs')
    }
    const sourceMessageRef = optionalText(input.sourceMessageRef, 'sourceMessageRef')
    const reportVersion = input.reportVersion === undefined ? 1 : input.reportVersion
    if (!Number.isInteger(reportVersion) || reportVersion < 1) {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'reportVersion 必须是正整数', { field: 'reportVersion' })
    }
    const blockedReason = typeof input.blockedReason === 'string' && input.blockedReason.trim() !== ''
      ? input.blockedReason
      : (typeof report.blockedReason === 'string' && report.blockedReason.trim() !== '' ? report.blockedReason : null)

    const duplicateRow = findResult(project.id, attempt.id, reportVersion, sourceMessageRef)
    if (duplicateRow !== undefined) {
      return {
        result: copy(duplicateRow),
        duplicate: true,
        task: copy(store.getTask(task.id)),
        decision: { applied: false, duplicate: true, reason: '结果已登记，重复事件不重新判定' },
      }
    }

    const recorded = store.recordResult({
      projectId: project.id,
      taskId: task.id,
      attemptId: attempt.id,
      reportVersion,
      summary,
      artifactRefs,
      checks: optionalArray(input.checks ?? report.checks, 'checks'),
      remainingItems: optionalArray(input.remainingItems ?? report.remainingItems, 'remainingItems'),
      blockedReason,
      sourceMessageRef,
    })
    if (recorded.duplicate) {
      return {
        result: copy(recorded.result),
        duplicate: true,
        task: copy(store.getTask(task.id)),
        decision: { applied: false, duplicate: true, reason: '结果已登记' },
      }
    }

    // 自动记账：新成果落账后记两行——项目记忆里一行（哪个部门、做了什么），
    // 主责部门自己的部门记忆里也一行（在哪个项目、做了什么），两本记忆
    // 都随干活自然生长。尽力而为：写失败不影响成果本身。
    if (memory !== null) {
      try {
        memory.appendProject(project.id, `${task.ownerRoleId} 汇报成果（任务「${task.title}」）：${summary.slice(0, 500)}`)
      } catch {
        // 记忆是参考资料，不拖垮业务。
      }
      try {
        const projectLabel = typeof project.displayNameCache === 'string' && project.displayNameCache !== ''
          ? project.displayNameCache
          : project.id
        memory.appendDepartment(task.ownerRoleId, `在项目「${projectLabel}」汇报成果（任务「${task.title}」）：${summary.slice(0, 500)}`)
      } catch {
        // 同上。
      }
    }

    if (isTerminal('task', task.status)) {
      return {
        result: copy(recorded.result),
        duplicate: false,
        task: copy(store.getTask(task.id)),
        decision: { applied: false, stale: true, reason: `任务已终态（${task.status}），迟到报告只登记不判定` },
      }
    }

    // 尝试对齐：报告意味着运行已经开始；宿主给了终态就同步落 attempt，但业务结论仍看 decide。
    let liveAttempt = attempt
    if (liveAttempt.state === 'queued') {
      liveAttempt = store.updateAttempt(attempt.id, { state: 'running', startedAt: nowIso() })
    }
    if (runTerminal !== null && ATTEMPT_STATE_OF_RUN[runTerminal] !== undefined
      && !isTerminal('attempt', liveAttempt.state) && liveAttempt.state !== 'cancel_requested') {
      liveAttempt = store.updateAttempt(attempt.id, { state: ATTEMPT_STATE_OF_RUN[runTerminal], endedAt: nowIso() })
    }

    const reportForJudge = {
      taskId: task.id,
      attemptId: attempt.id,
      summary,
      artifactRefs,
      checks: optionalArray(input.checks ?? report.checks, 'checks'),
      ...(blockedReason === null ? {} : { blockedReason }),
    }
    const judged = store.mutate(() => {
      const fresh = store.getTask(task.id)
      // 运行还没结束：走 core 的“报告先到”分支，只登记报告时间（候选），任务保持原状态。
      // 不能走 completion 判定——那会把“还没跑完”误判成 needs_attention，等于替宿主宣布结束。
      if (runTerminal === null || runTerminal === 'running') {
        const pending = decide(fresh, { kind: 'report', report: reportForJudge }, { now: nowIso })
        if (pending.applied === true) store.updateTask(pending.task)
        const summary = summarize(pending)
        return {
          task: store.getTask(task.id),
          summary: { ...summary, reason: summary.reason ?? '报告已登记为候选，等待宿主运行结束' },
        }
      }
      const decision = decide(fresh, {
        kind: 'completion',
        report: reportForJudge,
        runTerminal,
        artifactRefs,
        artifactLookup: (ref) => store.getArtifact(ref),
      }, { now: nowIso })
      if (decision.applied === true) {
        const applied = applyDecision(store, task.id, decision)
        return { task: applied.task, summary: summarize(applied) }
      }
      return { task: fresh, summary: summarize(decision) }
    })

    return {
      result: copy(recorded.result),
      duplicate: false,
      task: copy(judged.value.task),
      attempt: copy(liveAttempt),
      decision: judged.value.summary,
    }
  })

  function findResult(projectId, attemptId, reportVersion, sourceMessageRef) {
    return store.listResults(undefined)
      .filter((row) => row.projectId === projectId && row.attemptId === attemptId)
      .find((row) => row.reportVersion === reportVersion
        || (sourceMessageRef !== null && row.sourceMessageRef === sourceMessageRef))
  }

  /** 判定摘要：UI 与日志只读这几项，不解析整条任务。 */
  function summarize(decision) {
    const verify = decision.verdict ?? null
    return {
      applied: decision.applied === true,
      stale: decision.stale === true,
      status: decision.task?.status ?? null,
      reason: decision.reason ?? null,
      blockers: verify?.blockers ?? (decision.applied === true ? [] : (decision.reason === undefined ? [] : [decision.reason])),
      // 三条完成条件各自的结论，UI 可逐条显示为什么还没完成。
      verdict: verify === null ? null : { reportOk: verify.reportOk, runOk: verify.runOk, refsValid: verify.refsValid, ok: verify.ok },
    }
  }

  /**
   * 宿主终态单独到达（结果先到、终态后到）。只有“报告已到 + running”才会在这里完成；
   * 其余按 core 的 run_terminal 分支落 needs_attention 或保持不变。
   */
  const reportRunTerminal = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    if (isTerminal('task', task.status)) {
      // 任务已有结论（取消/完成/失败）：迟到的宿主回执只能核对尝试，不能改判。
      return { task: copy(task), attempt: null, decision: { applied: false, stale: true, status: task.status, reason: '任务已终态' } }
    }
    const runTerminal = normalizeRunTerminal(input.runTerminal)
    if (runTerminal === null || runTerminal === 'running') {
      return { task: copy(task), attempt: null, decision: { applied: false, status: task.status, reason: '尚未到终态' } }
    }
    let attempt = null
    const attemptId = input.attemptId === undefined ? task.activeAttemptId : input.attemptId
    if (attemptId !== null && attemptId !== undefined) {
      attempt = requireAttempt(project, attemptId)
      if (!isTerminal('attempt', attempt.state) && attempt.state !== 'cancel_requested'
        && ATTEMPT_STATE_OF_RUN[runTerminal] !== undefined) {
        attempt = store.updateAttempt(attempt.id, { state: ATTEMPT_STATE_OF_RUN[runTerminal], endedAt: nowIso() })
      }
    }
    const judged = store.mutate(() => {
      const fresh = store.getTask(task.id)
      if (runTerminal === 'running') {
        // 报告正文已在 reportTaskResult 里登记，这里只需确认“仍在跑”这一事实。
        return { task: fresh, summary: { applied: false, stale: false, status: fresh.status, reason: '尚未到终态' } }
      }
      // 运行已结束、任务却还停在 queued（适配器没来得及推进）：先补一次 running，
      // 否则 completion 会被状态机丢弃，任务卡在排队态，日志与 UI 都会说谎。
      let live = fresh
      if (live.status === 'queued') {
        live = store.updateTask({ ...live, status: 'running', startedAt: nowIso() })
      }
      if (isTerminal('task', live.status)) {
        return { task: live, summary: { applied: false, stale: true, status: live.status, reason: '任务已终态' } }
      }
      const report = input.report ?? latestReport(project, live, attempt?.id ?? null)
      const vote = (event) => decide(live, event, { now: nowIso })
      let decision
      if (report !== null) {
        // 报告已在账本里：按三条完成条件整体判一次（报告+终态成功+成果有效才 completed）。
        decision = vote({
          kind: 'completion',
          report,
          runTerminal,
          artifactRefs: report.artifactRefs ?? [],
          artifactLookup: (ref) => store.getArtifact(ref),
        })
      } else {
        // 没收到报告、宿主却已正常结束：按"成功但无报告"记完成判定 → needs_attention
        // （宿主跑完不等于业务完成，不能判 completed）；failed / cancelled 各有归宿。
        // 用 report: null 明确表达"确实没有报告"，不靠缺省字段碰运气。
        decision = vote({
          kind: 'completion',
          report: null,
          runTerminal,
          artifactRefs: [],
          artifactLookup: (ref) => store.getArtifact(ref),
        })
      }
      if (decision.applied === true) {
        const applied = applyDecision(store, task.id, decision)
        return { task: applied.task, summary: summarize(applied) }
      }
      return { task: live, summary: summarize(decision) }
    })
    return { task: copy(judged.value.task), attempt: copy(attempt), decision: judged.value.summary }
  })

  // ---------- 待补充 / 同步决定 ----------

  /** requestTaskInput：明确缺什么就进入 waiting_input，只等用户补充，不广播其他部门。 */
  const requestTaskInput = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    const reason = requireText(input.reason, 'reason')
    const missingItems = optionalArray(input.missingItems, 'missingItems')
    const judged = store.mutate(() => {
      const fresh = store.getTask(task.id)
      const decision = decide(fresh, {
        kind: 'input_required',
        reason,
        payload: { missingItems, scope: input.scope ?? null },
      }, { now: nowIso })
      if (decision.applied === true) {
        const applied = applyDecision(store, task.id, decision)
        return { task: applied.task, summary: summarize(applied) }
      }
      return { task: fresh, summary: summarize(decision) }
    })
    return {
      task: copy(judged.value.task),
      applied: judged.value.summary.applied,
      reason: judged.value.summary.reason,
      missingItems,
    }
  })

  /** supplyTaskInput：用户补齐后回到原任务，不扩大范围、不新建任务。 */
  const supplyTaskInput = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    const judged = store.mutate(() => {
      const fresh = store.getTask(task.id)
      const decision = decide(fresh, { kind: 'input_supplied' }, { now: nowIso })
      if (decision.applied === true) {
        const applied = applyDecision(store, task.id, decision)
        return { task: applied.task, summary: summarize(applied) }
      }
      return { task: fresh, summary: summarize(decision) }
    })
    return { task: copy(judged.value.task), applied: judged.value.summary.applied, reason: judged.value.summary.reason }
  })

  /** 取出该任务最近一次登记的结构化报告；没有就返回 null（由完成判定判成 needs_attention）。 */
  function latestReport(project, task, attemptId) {
    const rows = store.listResults(task.id).filter((row) => row.taskId === task.id
      && (attemptId === null || row.attemptId === attemptId))
    if (rows.length === 0) return null
    const last = rows.reduce((max, row) => (Number(row.reportVersion) >= Number(max.reportVersion) ? row : max), rows[0])
    // taskId / attemptId 必须一起带上：core 的 validateReport 把它们当作报告可信度的一部分，
    // 少一个就会判成“缺少 attemptId”，完成判定直接掉进 needs_attention。
    return {
      taskId: last.taskId,
      attemptId: last.attemptId,
      summary: last.summary,
      checks: last.checks ?? [],
      blockedReason: last.blockedReason ?? null,
      artifactRefs: last.artifactRefs ?? [],
    }
  }

  /**
   * syncDecision：把用户在某条会话里明确同意/否决的决定，定向同步给指定任务或丞相。
   * 最小实现：只登记一条带来源与选中片段的事件，不解析整段聊天、不广播给十席。
   */
  const syncDecision = guard((input = {}) => {
    const project = projectIdOf(input)
    const content = requireText(input.content, 'content')
    const sourceSessionId = optionalText(input.sourceSessionId, 'sourceSessionId')
    const roleId = input.roleId === undefined ? 'lead' : requireRole(input.roleId, 'roleId')
    const task = input.taskId === undefined || input.taskId === null ? null : requireTask(project, input.taskId)
    const event = store.appendEvent({
      type: 'decision.synced',
      projectId: project.id,
      roleId,
      taskId: task?.id ?? null,
      payload: { content, sourceSessionId, scope: input.scope ?? null, taskId: task?.id ?? null },
    })
    return { event: copy(event), task: copy(task), roleId }
  })

  // ---------- 成果 ----------

  /**
   * A23：成果文件被删/移走后，界面要显示「失效」而不是照旧显示可打开。
   * 这里不读文件内容、不改账本，只在投影时按注入的 fileExists 探一次。
   * 探不了（没接文件系统、fileRef 不是本地路径）就是 unknown，绝不猜成 ok。
   */
  function artifactView(artifact) {
    if (artifact === null || artifact === undefined) return null
    const path = typeof artifact.fileRef === 'string' && artifact.fileRef.trim() !== '' ? artifact.fileRef.trim() : null
    let existence = 'unknown'
    if (path !== null && typeof fileExists === 'function') {
      try {
        existence = fileExists(path) ? 'ok' : 'missing'
      } catch {
        existence = 'unknown'
      }
    }
    return { ...copy(artifact), existence }
  }

  /**
   * 交接材料引用（A09）：两种可追溯形态，别的一律拒绝。
   * - 字符串：历史数据里的自由文本引用，原样保留
   * - {artifactId}：必须是本项目的成果；版本缺省取该成果当前版本，显式给了就按给的记
   * - {attachmentId}：附件的宿主侧 ID，允许带 name/mime/size 供阅读
   * 显式拒绝跨项目成果引用：交接材料不能成为越权读取的通道。
   */
  function normalizeMaterialRefs(value, project) {
    const list = optionalArray(value, 'packet.materialRefs')
    return list.map((ref, index) => {
      if (typeof ref === 'string') {
        if (ref.trim() === '') throw new ServiceError(SERVICE_CODES.INVALID_INPUT, '材料引用不能是空字符串', { field: `materialRefs[${index}]` })
        return ref
      }
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
        throw new ServiceError(SERVICE_CODES.INVALID_INPUT, '材料引用必须是字符串或 {artifactId} / {attachmentId} 对象', {
          field: `materialRefs[${index}]`,
        })
      }
      if (typeof ref.artifactId === 'string' && ref.artifactId !== '') {
        const artifact = store.getArtifact(ref.artifactId)
        if (artifact === undefined) {
          throw new ServiceError(SERVICE_CODES.NOT_FOUND, '材料引用指向的成果不存在', { field: `materialRefs[${index}]` })
        }
        if (artifact.projectId !== project.id) {
          throw new ServiceError(SERVICE_CODES.CROSS_PROJECT, '材料引用指向的成果属于别的项目', {
            field: `materialRefs[${index}]`,
          })
        }
        const revision = Number.isInteger(ref.revision) && ref.revision > 0 ? ref.revision : Number(artifact.revision ?? 1)
        const out = { artifactId: artifact.id, revision }
        // 名字只是给人读的，默认取成果自己的显示名；显式给了就以调用方为准。
        const title = typeof ref.title === 'string' && ref.title !== ''
          ? ref.title
          : (typeof artifact.displayName === 'string' && artifact.displayName !== '' ? artifact.displayName : '')
        if (title !== '') out.title = title
        return out
      }
      if (typeof ref.attachmentId === 'string' && ref.attachmentId !== '') {
        const out = { attachmentId: ref.attachmentId }
        if (typeof ref.name === 'string' && ref.name !== '') out.name = ref.name
        if (typeof ref.mime === 'string' && ref.mime !== '') out.mime = ref.mime
        if (Number.isInteger(ref.size) && ref.size > 0) out.size = ref.size
        return out
      }
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, '材料引用缺少 artifactId 或 attachmentId', {
        field: `materialRefs[${index}]`,
      })
    })
  }

  /** 登记成果引用：只记引用与校验结论，不复制文件内容，也不改文件本体。 */
  const registerArtifact = guard((input = {}) => {
    const project = projectIdOf(input)
    const task = requireTask(project, input.taskId)
    const ownerRoleId = input.ownerRoleId === undefined ? task.ownerRoleId : requireRole(input.ownerRoleId, 'ownerRoleId')
    const sourceResultId = input.sourceResultId === undefined || input.sourceResultId === null
      ? null
      : ownedRow(project, 'result', input.sourceResultId, 'sourceResultId').id
    // 修订链：只有指向本项目既有成果才认，跨项目一律 CROSS_PROJECT。
    const revisesArtifactId = input.revisesArtifactId === undefined || input.revisesArtifactId === null
      ? null
      : ownedRow(project, 'artifact', input.revisesArtifactId, 'revisesArtifactId').id
    const previous = revisesArtifactId === null ? null : store.getArtifact(revisesArtifactId)
    const artifact = store.recordArtifact({
      projectId: project.id,
      taskId: task.id,
      ownerRoleId,
      fileRef: optionalText(input.fileRef, 'fileRef'),
      displayName: input.displayName === undefined ? '' : String(input.displayName),
      mediaType: input.mediaType === undefined ? 'application/octet-stream' : String(input.mediaType),
      versionOrHash: optionalText(input.versionOrHash, 'versionOrHash'),
      verification: input.verification ?? { status: 'unverified' },
      sourceResultId,
      revisesArtifactId,
      revision: previous === null ? 1 : Number(previous.revision ?? 1) + 1,
      revisionOfTaskId: previous === null ? null : (previous.revisionOfTaskId ?? previous.taskId ?? null),
    })
    return { artifact: artifactView(artifact) }
  })

  /**
   * 成果修订（方案路径 B）：在成果区点“找主责部门修改”，只开一条修订任务给原主责部门，
   * 不重跑整套三省。任务把原成果与版本写进 scope，派发时自动进交接材料。
   */
  const requestArtifactRevision = guard((input = {}) => {
    const project = projectIdOf(input)
    const artifact = ownedRow(project, 'artifact', input.artifactId, 'artifactId')
    const instruction = requireText(input.instruction, 'instruction')
    const ownerRoleId = input.ownerRoleId === undefined ? artifact.ownerRoleId : requireRole(input.ownerRoleId, 'ownerRoleId')
    const sourceRoleId = input.sourceRoleId === undefined ? 'lead' : requireRole(input.sourceRoleId, 'sourceRoleId')
    const wanted = input.status === undefined ? 'draft' : input.status
    if (wanted !== 'queued' && wanted !== 'draft') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, `修订任务只能是 queued 或 draft，收到 ${String(wanted)}`, { field: 'status' })
    }
    if (wanted === 'queued') {
      const binding = store.getBinding(project.id, ownerRoleId)
      if (binding?.currentSessionId === null || binding?.currentSessionId === undefined) {
        throw new ServiceError(SERVICE_CODES.INVALID_STATE, `${ownerRoleId} 尚未接通会话，不能直接入队；可先存草稿`, {
          roleId: ownerRoleId,
          hint: 'draft',
        })
      }
    }
    const record = createTaskRecord({
      projectId: project.id,
      title: input.title === undefined ? `修改成果：${artifact.displayName || artifact.id}` : String(input.title),
      objective: instruction,
      acceptance: optionalArray(input.acceptance, 'acceptance'),
      constraints: optionalArray(input.constraints, 'constraints'),
      scope: {
        kind: 'artifact-revision',
        artifactId: artifact.id,
        revision: Number(artifact.revision ?? 1),
        sourceTaskId: artifact.taskId ?? null,
      },
      ownerRoleId,
      sourceRoleId,
      originMessageRef: optionalText(input.originMessageRef, 'originMessageRef'),
      returnTarget: input.returnTarget ?? { roleId: sourceRoleId },
    }, { newTaskId: () => store.ids.task(), now: nowIso })
    const withChain = {
      ...record,
      kind: 'revision',
      reviseOfArtifactId: artifact.id,
      reviseOfTaskId: artifact.taskId ?? null,
      artifactRevision: Number(artifact.revision ?? 1),
    }
    const queued = wanted === 'queued' ? startTask(withChain, { now: nowIso }) : withChain
    return { task: copy(store.insertTask(queued)), artifact: artifactView(artifact) }
  })

  function listArtifacts(projectId) {
    const project = projectIdOf({ projectId })
    return store.listArtifacts(project.id).map(artifactView)
  }

  function getArtifact(projectId, artifactId) {
    const project = projectIdOf({ projectId })
    return artifactView(ownedRow(project, 'artifact', artifactId, 'artifactId'))
  }

  function getAttempt(projectId, attemptId) {
    const project = projectIdOf({ projectId })
    return copy(requireAttempt(project, attemptId))
  }

  // ---------- 事件 ----------

  /**
   * 事件轮询数据源：since 之后的本项目事件，按 seq 升序。
   * - since 超出当前 seq（账本被替换/回滚）→ reset=true，前端应全量重拉而不是空等；
   * - 只返回本项目事件；projectId 为空时返回全局（宿主内部用，UI 不传）。
   */
  function listEvents(projectId, since = 0, optionsArg = {}) {
    let scope = null
    if (projectId !== undefined && projectId !== null && projectId !== '') {
      scope = projectIdOf({ projectId }).id
    }
    const cursor = Number(since)
    const start = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
    const limit = Number.isInteger(optionsArg.limit) && optionsArg.limit > 0 ? optionsArg.limit : 200
    const all = store.listEvents(scope === null ? undefined : scope)
    const fresh = all.filter((row) => row.seq > start).sort((left, right) => left.seq - right.seq)
    return {
      events: fresh.slice(0, limit).map(copy),
      seq: store.eventSeq,
      reset: start > store.eventSeq,
      hasMore: fresh.length > limit,
    }
  }

  // ---------- 投影 ----------

  /**
   * bootstrap：一次拿全。projectId 为空时取列表第一个；
   * 传入的项目不可见按 NOT_FOUND 报错，不泄露其他项目是否存在。
   */
  function bootstrap(projectId) {
    const projects = listProjects()
    let selectedId = null
    if (projectId !== undefined && projectId !== null && projectId !== '') {
      selectedId = projectIdOf({ projectId }).id
    } else if (projects.length > 0) {
      selectedId = projects[0].id
    }
    if (selectedId === null) {
      return {
        projects,
        projectId: null,
        project: null,
        seats: [],
        layout: layout(),
        tasks: [],
        artifacts: [],
        results: [],
        eventSeq: store.eventSeq,
      }
    }
    const project = store.getProject(selectedId)
    const taskIds = new Set(store.listTasks(selectedId).map((task) => task.id))
    return {
      projects,
      projectId: selectedId,
      project: copy(project),
      seats: listSeats(selectedId),
      layout: layout(),
      tasks: listTasks(selectedId),
      artifacts: store.listArtifacts(selectedId).map(artifactView),
      results: store.listResults(undefined).filter((row) => taskIds.has(row.taskId)).map(copy),
      eventSeq: store.eventSeq,
    }
  }

  // ---------- 事件：每次状态变更都写一条 outbox ----------

  /**
   * 哪些操作要发事件：凡是「UI 需要立刻看到」的写操作。
   * 放在出口统一包一层而不是各函数里各写一遍——漏一处就是一个静默不刷新的 bug。
   * syncDecision 自己已经登记了 decision.synced，这里跳过，避免同一动作两条事件。
   */
  const EVENT_OPS = new Set([
    'registerProject',
    'bindDepartmentSession',
    'releaseDepartmentSession',
    'setDepartmentStatus',
    'saveDepartmentConfig',
    'createTask',
    'cancelTask',
    'dispatchTask',
    'markDispatch',
    'startAttempt',
    'reportTaskResult',
    'reportRunTerminal',
    'requestTaskInput',
    'supplyTaskInput',
    'registerArtifact',
    'requestArtifactRevision',
  ])

  /** 从返回值里找这次写入属于哪个项目；找不到就不带项目（全局事件）。 */
  function projectIdOfResult(value, input) {
    const candidates = [
      value?.project?.id,
      value?.task?.projectId,
      value?.binding?.projectId,
      value?.dispatch?.projectId,
      value?.attempt?.projectId,
      value?.config?.projectId,
      value?.artifact?.projectId,
      value?.result?.projectId,
      input?.projectId,
    ]
    return candidates.find((id) => typeof id === 'string' && id !== '') ?? null
  }

  /**
   * 事件只是“给 UI 的增量提示”，写入失败绝不能让业务失败：
   * 账已经落对了，事件补不上顶多让界面晚一拍，靠 /bootstrap 仍能自愈。
   */
  function emitChange(op, value, input) {
    try {
      const projectId = projectIdOfResult(value, input)
      const roleId = value?.task?.ownerRoleId
        ?? value?.binding?.roleId
        ?? value?.attempt?.roleId
        ?? input?.roleId
        ?? null
      store.appendEvent({
        type: `state.${op}`,
        projectId,
        roleId,
        taskId: value?.task?.id ?? input?.taskId ?? null,
        attemptId: value?.attempt?.id ?? input?.attemptId ?? null,
        payload: { op },
      })
    } catch {
      // 见上：事件不是业务前置条件。
    }
  }

  // ---------- 记忆 ----------

  function requireMemoryScope(value) {
    if (value !== 'long-term' && value !== 'project' && value !== 'department') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'scope 必须是 long-term、project 或 department', { field: 'scope' })
    }
    return value
  }

  function requireMemory() {
    if (memory === null) {
      throw new ServiceError(SERVICE_CODES.INVALID_STATE, '宿主未启用记忆存储')
    }
    return memory
  }

  const getMemory = guard((input = {}) => {
    const scope = requireMemoryScope(input.scope)
    const mem = requireMemory()
    if (scope === 'long-term') {
      const found = mem.readLongTerm()
      return { scope, text: found.text, exists: found.exists }
    }
    if (scope === 'department') {
      const roleId = requireRole(input.roleId, 'roleId')
      const found = mem.readDepartment(roleId)
      return { scope, roleId, text: found.text, exists: found.exists }
    }
    const project = projectIdOf(input)
    const found = mem.readProject(project.id)
    return { scope, projectId: project.id, text: found.text, exists: found.exists }
  })

  const putMemory = guard((input = {}) => {
    const scope = requireMemoryScope(input.scope)
    const mem = requireMemory()
    if (typeof input.text !== 'string') {
      throw new ServiceError(SERVICE_CODES.INVALID_INPUT, 'text 必须是字符串', { field: 'text' })
    }
    if (scope === 'long-term') {
      mem.writeLongTerm(input.text)
      return { scope, text: input.text }
    }
    if (scope === 'department') {
      const roleId = requireRole(input.roleId, 'roleId')
      mem.writeDepartment(roleId, input.text)
      return { scope, roleId, text: input.text }
    }
    const project = projectIdOf(input)
    mem.writeProject(project.id, input.text)
    return { scope, projectId: project.id, text: input.text }
  })

  const appendMemory = guard((input = {}) => {
    const scope = requireMemoryScope(input.scope)
    const mem = requireMemory()
    const text = requireText(input.text, 'text')
    if (scope === 'long-term') {
      return { scope, text: mem.appendLongTerm(text).text }
    }
    if (scope === 'department') {
      const roleId = requireRole(input.roleId, 'roleId')
      return { scope, roleId, text: mem.appendDepartment(roleId, text).text }
    }
    const project = projectIdOf(input)
    return { scope, projectId: project.id, text: mem.appendProject(project.id, text).text }
  })

  const api = {
    version: WORKBENCH_SERVICE_VERSION,
    store,
    clock,
    env,
    // 项目
    registerProject,
    listProjects,
    getProject,
    // 十席
    listSeats,
    layout,
    // 绑定与配置
    bindDepartmentSession,
    releaseDepartmentSession,
    setDepartmentStatus,
    saveDepartmentConfig,
    // 任务
    createTask,
    getTask,
    listTasks,
    cancelTask,
    // 派发
    dispatchTask,
    markDispatch,
    startAttempt,
    // 结果
    reportTaskResult,
    reportRunTerminal,
    requestTaskInput,
    supplyTaskInput,
    syncDecision,
    // 记忆
    getMemory,
    putMemory,
    appendMemory,
    // 成果
    registerArtifact,
    requestArtifactRevision,
    listArtifacts,
    getArtifact,
    getAttempt,
    // 投影与事件
    bootstrap,
    listEvents,
    // 供路由与测试复用
    translate,
  }

  const wrapped = {}
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== 'function' || !EVENT_OPS.has(name)) {
      wrapped[name] = fn
      continue
    }
    wrapped[name] = (...args) => {
      const value = fn(...args)
      emitChange(name, value, args[0])
      return value
    }
  }
  return Object.freeze(wrapped)
}
