// 领域存储：内存表 + JSON 文件快照（先写 .tmp 再 rename）。
// 只存业务账、引用和交接快照；聊天正文仍由 DSH 保存，这里不复制一份会过期的副本。
// 所有写入都走 mutate()：一次写入 = 一次事务，中途抛错就整体回滚，内存里不会留下半截状态。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { createIdFactory, isIdOf, newId } from './ids.mjs'
import { ROLES, isRoleId } from './roles.mjs'
import { assertTransition, isTerminal, isState } from './states.mjs'

export const SCHEMA_VERSION = 1

const COLLECTIONS = Object.freeze([
  'projects',
  'bindings',
  'configs',
  'tasks',
  'dispatches',
  'attempts',
  'contextPackets',
  'results',
  'artifacts',
  'events',
])

const ENTITY_OF = Object.freeze({
  projects: 'project',
  bindings: 'binding',
  configs: 'config',
  tasks: 'task',
  dispatches: 'dispatch',
  attempts: 'attempt',
  contextPackets: 'contextPacket',
  results: 'result',
  artifacts: 'artifact',
  events: 'event',
})

/** 跨项目校验用的引用表：source 实体上的某字段 → 目标实体。 */
const REFERENCES = Object.freeze({
  tasks: Object.freeze({
    activeAttemptId: 'attempts',
    sourceBindingId: 'bindings',
    ownerBindingId: 'bindings',
  }),
  dispatches: Object.freeze({
    taskId: 'tasks',
    attemptId: 'attempts',
    contextPacketId: 'contextPackets',
    bindingId: 'bindings',
  }),
  attempts: Object.freeze({
    taskId: 'tasks',
    dispatchId: 'dispatches',
    bindingId: 'bindings',
  }),
  contextPackets: Object.freeze({ taskId: 'tasks' }),
  results: Object.freeze({
    taskId: 'tasks',
    attemptId: 'attempts',
    sourceBindingId: 'bindings',
  }),
  artifacts: Object.freeze({
    taskId: 'tasks',
    sourceResultId: 'results',
    // 修订关系：新成果指向被它替换的旧成果（必须同项目，跨项目一律拒绝）。
    revisesArtifactId: 'artifacts',
    ownerBindingId: 'bindings',
  }),
  events: Object.freeze({}),
})

export class StoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// DSH_HOME 是 Windows 绝对路径（盘符或 UNC）时按 Windows 语义拼：在 POSIX 上
// 直接 resolve 会把 C:\… 当相对路径拼到当前目录后面，账本就落错地方了。
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

export function defaultStorePath(env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  if (typeof home === 'string' && (WINDOWS_ABSOLUTE.test(home) || home.startsWith('\\\\'))) {
    return win32.join(home, 'sansheng-liubu', 'workbench.json')
  }
  return join(resolve(home), 'sansheng-liubu', 'workbench.json')
}

const nowIso = (clock) => new Date(clock()).toISOString()

function bindingKey(projectId, roleId) {
  return `${projectId}\u0000${roleId}`
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    eventSeq: 0,
    projects: new Map(),
    bindings: new Map(),
    configs: new Map(),
    tasks: new Map(),
    dispatches: new Map(),
    attempts: new Map(),
    contextPackets: new Map(),
    results: new Map(),
    artifacts: new Map(),
    events: [],
  }
}

/** 深拷贝走 JSON：状态里只有可序列化数据，写文件同样是这个形状，避免两条路径不同步。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreError('INVALID_INPUT', `${field} 必须是非空字符串`)
  }
  return value
}

/** 集合 → 主键字段，注册时统一生成 ID 并校验前缀。 */
const KEY_FIELD = Object.freeze({
  projects: 'id',
  bindings: 'id',
  configs: 'id',
  tasks: 'id',
  dispatches: 'id',
  attempts: 'id',
  contextPackets: 'id',
  results: 'id',
  artifacts: 'id',
  events: 'eventId',
})

export class WorkbenchStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file] 持久化路径；null/'' 表示纯内存（测试与只读投影用）。
   * @param {() => number} [options.clock] 注入时钟，测试可固定时间戳。
   * @param {() => string} [options.random] 注入随机源，测试可固定 ID。
   * @param {object} [options.env] 计算默认路径用的环境变量。
   */
  constructor(options = {}) {
    const { file = defaultStorePath(options.env), clock = Date.now, random, env } = options
    this.file = file === null || file === '' ? null : resolve(String(file))
    this.clock = clock
    this.random = random
    this.ids = createIdFactory(random === undefined ? {} : { random })

    this.state = emptyState()
    // 事务深度为 0 才是真正的提交点；嵌套写入并进外层事务，内层抛错由外层整体回滚。
    this._txDepth = 0
    this._stamp = null
    this._dirty = false
    this.env = env
  }

  // ---------- 事务与生命周期 ----------

  /**
   * 一次事务提交所有内存变更并顺带落盘；payloads 里收集的 ID 说明“写成功”才对外可见。
   * 不自动落盘失败时的部分内存修改被丢弃，重试不会撞上幽灵记录。
   */
  mutate(payloads = () => null) {
    const snapshot = this._txDepth === 0 ? this._captureState() : null
    this._txDepth += 1
    const result = {}
    let committed = false
    let value
    try {
      value = payloads(result)
      committed = true
    } finally {
      this._txDepth -= 1
      // 外层事务收尾：成功则递增版本并落盘；失败则回滚到事务开始时的快照。
      if (this._txDepth === 0) {
        if (committed) {
          this.state.revision += 1
          this._stamp = nowIso(this.clock)
          this._dirty = true
          try {
            this.save()
          } catch (error) {
            if (snapshot !== null) this.state = snapshot
            throw error
          }
        } else if (snapshot !== null) {
          this.state = snapshot
        }
      }
    }
    return { ...result, value }
  }

  /** 只读运行，不递增 revision，也不落盘。 */
  view(fn) {
    return fn()
  }

  save() {
    if (this.file === null) return false
    this._writeAtomically(this.serialize())
    this._dirty = false
    return true
  }

  load() {
    if (this.file === null) return false
    if (!existsSync(this.file)) return false
    const raw = readFileSync(this.file, 'utf8')
    this._applySnapshot(raw)
    return true
  }

  serialize() {
    const state = this.state
    return JSON.stringify({
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      eventSeq: state.eventSeq,
      projects: [...state.projects.values()],
      bindings: [...state.bindings.values()],
      configs: [...state.configs.values()],
      tasks: [...state.tasks.values()],
      dispatches: [...state.dispatches.values()],
      attempts: [...state.attempts.values()],
      contextPackets: [...state.contextPackets.values()],
      results: [...state.results.values()],
      artifacts: [...state.artifacts.values()],
      events: state.events,
    })
  }

  /** 投影给 UI 用：只读副本，避免调用方直接改 Map。 */
  snapshot() {
    return clone({
      schemaVersion: this.state.schemaVersion,
      revision: this.state.revision,
      eventSeq: this.state.eventSeq,
      savedAt: this._stamp ?? null,
      projects: [...this.state.projects.values()],
      bindings: [...this.state.bindings.values()],
      configs: [...this.state.configs.values()],
      tasks: [...this.state.tasks.values()],
      dispatches: [...this.state.dispatches.values()],
      attempts: [...this.state.attempts.values()],
      contextPackets: [...this.state.contextPackets.values()],
      results: [...this.state.results.values()],
      artifacts: [...this.state.artifacts.values()],
      events: this.state.events,
    })
  }

  get revision() {
    return this.state.revision
  }

  get eventSeq() {
    return this.state.eventSeq
  }

  _captureState() {
    return this._fromSnapshot(JSON.parse(this.serialize()))
  }

  _writeAtomically(text) {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, text, 'utf8')
      // Windows 上 rename 覆盖已存在文件可能失败（杀软/索引占用），失败时删旧再改名，
      // 最坏情况是两个窗口都读到“空账”，但不会读到半截 JSON。
      try {
        renameSync(tmp, this.file)
      } catch (error) {
        rmSync(this.file, { force: true })
        renameSync(tmp, this.file)
      }
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  _applySnapshot(text) {
    const parsed = JSON.parse(text)
    this.state = this._fromSnapshot(parsed)
  }

  _fromSnapshot(parsed) {
    if (parsed === null || typeof parsed !== 'object') throw new StoreError('CORRUPT', '账本不是对象')
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new StoreError('SCHEMA_MISMATCH', `账本 schemaVersion=${String(parsed.schemaVersion)}，期望 ${SCHEMA_VERSION}`)
    }
    const state = emptyState()
    state.revision = Number(parsed.revision) || 0
    state.eventSeq = Number(parsed.eventSeq) || 0
    for (const collection of COLLECTIONS) {
      const list = Array.isArray(parsed[collection]) ? parsed[collection] : []
      if (collection === 'events') {
        state.events = list
        continue
      }
      const keyOf = collection === 'bindings' || collection === 'configs'
        ? (row) => bindingKey(row.projectId, row.roleId)
        : (row) => row[KEY_FIELD[collection]]
      for (const row of list) state[collection].set(keyOf(row), row)
    }
    return state
  }

  // ---------- 通用查询 ----------

  getProject(id) {
    return this.state.projects.get(id)
  }

  listProjects() {
    return [...this.state.projects.values()]
  }

  getBinding(projectId, roleId) {
    return this.state.bindings.get(bindingKey(projectId, roleId))
  }

  listBindings(projectId) {
    return [...this.state.bindings.values()].filter((row) => projectId === undefined || row.projectId === projectId)
  }

  getConfig(projectId, roleId) {
    return this.state.configs.get(bindingKey(projectId, roleId))
  }

  listConfigs(projectId) {
    return [...this.state.configs.values()].filter((row) => projectId === undefined || row.projectId === projectId)
  }

  getTask(id) {
    return this.state.tasks.get(id)
  }

  listTasks(projectId) {
    return [...this.state.tasks.values()].filter((row) => projectId === undefined || row.projectId === projectId)
  }

  getDispatch(id) {
    return this.state.dispatches.get(id)
  }

  getAttempt(id) {
    return this.state.attempts.get(id)
  }

  listAttempts(taskId) {
    return [...this.state.attempts.values()].filter((row) => taskId === undefined || row.taskId === taskId)
  }

  getContextPacket(id) {
    return this.state.contextPackets.get(id)
  }

  getResult(id) {
    return this.state.results.get(id)
  }

  listResults(taskId) {
    return [...this.state.results.values()].filter((row) => taskId === undefined || row.taskId === taskId)
  }

  getArtifact(id) {
    return this.state.artifacts.get(id)
  }

  listArtifacts(projectId) {
    return [...this.state.artifacts.values()].filter((row) => projectId === undefined || row.projectId === projectId)
  }

  listEvents(projectId) {
    return this.state.events.filter((row) => projectId === undefined || row.projectId === projectId)
  }

  findDispatchByIdempotencyKey(projectId, key) {
    return [...this.state.dispatches.values()].find(
      (row) => row.projectId === projectId && row.idempotencyKey === key,
    )
  }

  // ---------- 写入：项目 ----------

  createProject(input) {
    const hostWorkspaceId = requireString(input?.hostWorkspaceId, 'hostWorkspaceId')
    const existing = [...this.state.projects.values()].find((row) => row.hostWorkspaceId === hostWorkspaceId)
    if (existing !== undefined) {
      throw new StoreError('DUPLICATE_PROJECT', `宿主工作区已登记为项目 ${existing.id}`, { projectId: existing.id })
    }
    const id = this.ids.project()
    const stamp = nowIso(this.clock)
    return this.mutate((out) => {
      const project = {
        id,
        hostWorkspaceId,
        displayNameCache: input.displayNameCache ?? '',
        canonicalRoot: input.canonicalRoot ?? null,
        status: input.status ?? 'active',
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }
      this.state.projects.set(id, project)
      // 首次进入只建十席配置初值与空绑定，不自动创建会话、不发模型请求。
      for (const seat of ROLES) {
        const binding = this._emptyBinding(id, seat.id, stamp)
        const config = this._emptyConfig(id, seat.id, stamp)
        this.state.bindings.set(bindingKey(id, seat.id), binding)
        this.state.configs.set(bindingKey(id, seat.id), config)
      }
      this._appendEvent({ type: 'project.created', projectId: id, payload: { hostWorkspaceId } }, stamp)
      out.projectId = id
      return id
    }).value
  }

  updateProject(id, patch) {
    return this.mutate((out) => {
      const project = this._project(id)
      const stamp = nowIso(this.clock)
      const next = { ...project, updatedAt: stamp, revision: project.revision + 1 }
      if (patch?.displayNameCache !== undefined) next.displayNameCache = String(patch.displayNameCache)
      if (patch?.canonicalRoot !== undefined) next.canonicalRoot = patch.canonicalRoot
      if (patch?.status !== undefined) next.status = patch.status
      this.state.projects.set(id, next)
      out.written = 1
      return next
    }).value
  }

  _project(id) {
    requireString(id, 'projectId')
    const project = this.state.projects.get(id)
    if (project === undefined) throw new StoreError('NOT_FOUND', `项目不存在: ${id}`)
    return project
  }

  // ---------- 写入：绑定 ----------

  _emptyBinding(projectId, roleId, stamp) {
    return {
      id: this.ids.binding(),
      projectId,
      roleId,
      currentSessionId: null,
      bindingGeneration: 0,
      historySessionRefs: [],
      creationRequestId: null,
      status: 'uninitialized',
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    }
  }

  _emptyConfig(projectId, roleId, stamp) {
    return {
      id: this.ids.config(),
      projectId,
      roleId,
      providerId: null,
      modelId: null,
      reasoningEffort: null,
      rolePromptVersion: 1,
      skillRefs: [],
      permissionRef: null,
      configRevision: 0,
      updatedAt: stamp,
    }
  }

  ensureBinding(projectId, roleId) {
    this._project(projectId)
    this._role(roleId)
    const existing = this.getBinding(projectId, roleId)
    if (existing !== undefined) return existing
    const stamp = nowIso(this.clock)
    return this.mutate((out) => {
      const binding = this._emptyBinding(projectId, roleId, stamp)
      this.state.bindings.set(bindingKey(projectId, roleId), binding)
      out.bindingId = binding.id
      return binding
    }).value
  }

  /**
   * 绑定会话：写入前先校验唯一性——同一 currentSessionId 不得同时属于两个 (projectId, roleId)，
   * 除非旧绑定已被 releaseBinding 释放（currentSessionId 置空并进入 historySessionRefs）。
   * bindingGeneration 每次换绑 +1：派发时固定它，旧消息不会被自动送进新会话。
   * 本部门已绑定另一会话时默认拒绝：静默覆盖等于把旧会话的历史从账上抹掉。
   * 只有调用方显式 allowReplace 才换绑，并仍把旧会话保留进 historySessionRefs。
   */
  bindSession(projectId, roleId, sessionId, options = {}) {
    this._project(projectId)
    this._role(roleId)
    requireString(sessionId, 'sessionId')
    return this.mutate((out) => {
      const binding = this.getBinding(projectId, roleId)
      if (binding === undefined) throw new StoreError('NOT_FOUND', '部门绑定不存在，请先 initializeProject')
      const holder = this._sessionHolder(projectId, roleId, sessionId)
      if (holder !== undefined) {
        throw new StoreError('SESSION_CONFLICT', '会话已绑定到另一个项目或部门', {
          sessionId,
          heldBy: { projectId: holder.projectId, roleId: holder.roleId },
        })
      }
      if (binding.currentSessionId !== null) {
        if (binding.currentSessionId === sessionId) {
          throw new StoreError('SESSION_CONFLICT', '该会话已是本部门的当前会话，无需重复绑定', { sessionId })
        }
        if (options.allowReplace !== true) {
          throw new StoreError('SESSION_CONFLICT', '本部门已绑定其他会话，请先 releaseBinding 或显式 allowReplace', {
            currentSessionId: binding.currentSessionId,
          })
        }
      }
      const stamp = nowIso(this.clock)
      const history = binding.currentSessionId === null || options.allowReplace !== true
        ? binding.historySessionRefs
        : [
            ...binding.historySessionRefs,
            { sessionId: binding.currentSessionId, releasedAt: stamp, bindingGeneration: binding.bindingGeneration },
          ]
      const next = {
        ...binding,
        currentSessionId: sessionId,
        historySessionRefs: history,
        bindingGeneration: binding.bindingGeneration + 1,
        creationRequestId: options.creationRequestId ?? null,
        status: options.status ?? 'idle',
        revision: binding.revision + 1,
        updatedAt: stamp,
      }
      assertTransition('department', binding.status, next.status)
      this.state.bindings.set(bindingKey(projectId, roleId), next)
      this._appendEvent({
        type: 'binding.session_bound',
        projectId,
        roleId,
        payload: { sessionId, bindingGeneration: next.bindingGeneration, bindingId: next.id },
      }, stamp)
      out.bindingId = next.id
      return next
    }).value
  }

  /**
   * 释放当前会话：旧会话进入 historySessionRefs（不删除历史），供以后接续。
   * 释放后同一 sessionId 才能绑定到别处。
   */
  releaseBinding(projectId, roleId) {
    return this.mutate((out) => {
      const binding = this.getBinding(projectId, roleId)
      if (binding === undefined) throw new StoreError('NOT_FOUND', '部门绑定不存在')
      const sessionId = binding.currentSessionId
      const stamp = nowIso(this.clock)
      const history = sessionId === null
        ? binding.historySessionRefs
        : [...binding.historySessionRefs, { sessionId, releasedAt: stamp, bindingGeneration: binding.bindingGeneration }]
      const next = {
        ...binding,
        currentSessionId: null,
        historySessionRefs: history,
        status: 'uninitialized',
        revision: binding.revision + 1,
        updatedAt: stamp,
      }
      this.state.bindings.set(bindingKey(projectId, roleId), next)
      if (sessionId !== null) {
        this._appendEvent({ type: 'binding.session_released', projectId, roleId, payload: { sessionId } }, stamp)
      }
      out.bindingId = next.id
      return next
    }).value
  }

  setBindingStatus(projectId, roleId, status) {
    return this.mutate((out) => {
      const binding = this.getBinding(projectId, roleId)
      if (binding === undefined) throw new StoreError('NOT_FOUND', '部门绑定不存在')
      assertTransition('department', binding.status, status)
      const stamp = nowIso(this.clock)
      const next = { ...binding, status, revision: binding.revision + 1, updatedAt: stamp }
      this.state.bindings.set(bindingKey(projectId, roleId), next)
      out.bindingId = next.id
      return next
    }).value
  }

  /** 会话归属查询：返回 nullptr 以外的唯一持有者（含跨项目），用于唯一性校验。 */
  _sessionHolder(projectId, roleId, sessionId) {
    for (const row of this.state.bindings.values()) {
      if (row.currentSessionId !== sessionId) continue
      if (row.projectId === projectId && row.roleId === roleId) continue
      return row
    }
    return undefined
  }

  // ---------- 写入：配置（CAS） ----------

  /**
   * 保存某项目某部门的模型设置。expectedRevision 必须等于当前 configRevision，
   * 否则抛 CAS_CONFLICT 并带回当前值，让 UI 提示后重应用，而不是静默覆盖另一标签页的修改。
   */
  saveConfig(projectId, roleId, desired, expectedRevision) {
    this._project(projectId)
    this._role(roleId)
    if (!Number.isInteger(expectedRevision)) {
      throw new StoreError('INVALID_INPUT', 'expectedRevision 必须是整数')
    }
    const provider = requireString(desired?.provider ?? desired?.providerId, 'provider')
    const model = requireString(desired?.model ?? desired?.modelId, 'model')
    const effort = desired?.reasoningEffort ?? null
    if (effort !== null && typeof effort !== 'string') {
      throw new StoreError('INVALID_INPUT', 'reasoningEffort 必须是字符串或 null')
    }
    return this.mutate((out) => {
      const config = this.getConfig(projectId, roleId)
      if (config === undefined) throw new StoreError('NOT_FOUND', '部门配置不存在')
      if (config.configRevision !== expectedRevision) {
        throw new StoreError('CAS_CONFLICT', '配置已被其他窗口修改', {
          expectedRevision,
          currentRevision: config.configRevision,
          current: {
            provider: config.providerId,
            model: config.modelId,
            reasoningEffort: config.reasoningEffort ?? null,
          },
        })
      }
      const stamp = nowIso(this.clock)
      const next = {
        ...config,
        providerId: provider,
        modelId: model,
        reasoningEffort: effort,
        configRevision: config.configRevision + 1,
        updatedAt: stamp,
      }
      this.state.configs.set(bindingKey(projectId, roleId), next)
      this._appendEvent({
        type: 'config.saved',
        projectId,
        roleId,
        payload: { provider, model, reasoningEffort: effort, configRevision: next.configRevision },
      }, stamp)
      out.configId = next.id
      return next
    }).value
  }

  // ---------- 写入：任务 ----------

  /**
   * raw 模式的写入口：tasks.mjs 负责生命周期判断，store 只保证“存在、状态合法、归属正确”。
   * 直接调用的调用方必须自己先用 assertTransition，并且不能跳过 task.ts。
   */
  insertTask(task) {
    return this.mutate((out) => {
      // 先定 ID：显式传入的 ID 撞键按重复报错（调用方给了确定的键，不能偷偷换）；
      // 自动生成的 ID 撞键就再抽一次——ID 用尽属于随机源问题，重抽几次仍撞才算失败。
      const auto = task?.id === undefined
      let candidate = task?.id ?? this.ids.task()
      for (let retry = 0; auto && this.state.tasks.has(candidate) && retry < 8; retry += 1) {
        candidate = this.ids.task()
      }
      if (this.state.tasks.has(candidate)) throw new StoreError('DUPLICATE_ID', `任务已存在: ${candidate}`)
      const next = { ...task, id: candidate, revision: task?.revision ?? 1 }
      this._assertTaskFields(next)
      this.state.tasks.set(candidate, next)
      out.taskId = candidate
      return next
    }).value
  }

  updateTask(task) {
    return this.mutate((out) => {
      const current = this.state.tasks.get(task?.id)
      if (current === undefined) throw new StoreError('NOT_FOUND', `任务不存在: ${String(task?.id)}`)
      if (current.projectId !== task.projectId) {
        throw new StoreError('CROSS_PROJECT', '任务的 projectId 不能被改写')
      }
      const next = { ...task, revision: current.revision + 1 }
      assertTransition('task', current.status, next.status)
      this.state.tasks.set(next.id, next)
      out.taskId = next.id
      return next
    }).value
  }

  _assertTaskFields(task) {
    requireString(task.id, 'task.id')
    isIdOf('task', task.id) || (() => { throw new StoreError('INVALID_ID', `任务 ID 形状非法: ${task.id}`) })()
    this._project(task.projectId)
    if (!isRoleId(task.ownerRoleId)) throw new StoreError('INVALID_ROLE', `未知主责部门: ${String(task.ownerRoleId)}`)
    if (!isRoleId(task.sourceRoleId)) throw new StoreError('INVALID_ROLE', `未知来源部门: ${String(task.sourceRoleId)}`)
    if (!isState('task', task.status)) throw new StoreError('INVALID_STATE', `未知任务状态: ${String(task.status)}`)
    return task
  }

  _role(roleId) {
    if (!isRoleId(roleId)) throw new StoreError('INVALID_ROLE', `未知角色: ${String(roleId)}`)
    return roleId
  }

  // ---------- 写入：派发（幂等） ----------

  /**
   * 幂等键 (projectId, idempotencyKey) 唯一：重复点击派工返回既有记录并标 duplicate，
   * 绝不生成第二条 dispatch——投递可能已经发生，重写一条等于假装配送两次。
   */
  recordDispatch(input) {
    const projectId = requireString(input?.projectId, 'projectId')
    const key = requireString(input?.idempotencyKey, 'idempotencyKey')
    this._project(projectId)
    const existing = this.findDispatchByIdempotencyKey(projectId, key)
    if (existing !== undefined) return { dispatch: clone(existing), duplicate: true }
    return this.mutate((out) => {
      const stamp = nowIso(this.clock)
      const dispatch = {
        id: this.ids.dispatch(),
        projectId,
        taskId: input.taskId ?? null,
        attemptId: input.attemptId ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        targetSessionId: input.targetSessionId ?? null,
        bindingId: input.bindingId ?? null,
        bindingGeneration: input.bindingGeneration ?? 0,
        contextPacketId: input.contextPacketId ?? null,
        idempotencyKey: key,
        status: input.status ?? 'prepared',
        hostMessageId: null,
        createdAt: stamp,
        updatedAt: stamp,
      }
      if (!isState('dispatch', dispatch.status)) {
        throw new StoreError('INVALID_STATE', `未知派发状态: ${String(dispatch.status)}`)
      }
      // 先落库再校验：派发与自己的 attemptId 是同一事务内的前向引用，
      // 若先校验会读不到刚创建的 dispatch 自身（历史 bug：所有派发失败）。
      this.state.dispatches.set(dispatch.id, dispatch)
      this._checkReferences({ ...dispatch, source: 'dispatches' })
      this._appendEvent({ type: 'dispatch.recorded', projectId, payload: { dispatchId: dispatch.id, idempotencyKey: key } }, stamp)
      out.dispatchId = dispatch.id
      return { dispatch, duplicate: false }
    }).value
  }

  /** 派发状态推进：接受状态必须由宿主回执驱动，不允许调用方跳过 sending 直接 accepted 之外的猜测。 */
  updateDispatch(id, patch) {
    return this.mutate((out) => {
      const current = this.state.dispatches.get(id)
      if (current === undefined) throw new StoreError('NOT_FOUND', `派发不存在: ${id}`)
      const next = { ...current, ...patch, id: current.id, projectId: current.projectId }
      if (patch?.status !== undefined) assertTransition('dispatch', current.status, patch.status)
      const stamp = nowIso(this.clock)
      next.updatedAt = stamp
      this.state.dispatches.set(id, next)
      out.dispatchId = id
      return next
    }).value
  }

  // ---------- 写入：尝试 / 上下文包 ----------

  insertAttempt(attempt) {
    return this.mutate((out) => {
      const id = attempt?.id ?? this.ids.attempt()
      const next = { ...attempt, id }
      if (!isState('attempt', next.state)) throw new StoreError('INVALID_STATE', `未知尝试状态: ${String(next.state)}`)
      this._checkReferences({ ...next, source: 'attempts' })
      this.state.attempts.set(id, next)
      out.attemptId = id
      return next
    }).value
  }

  updateAttempt(id, patch) {
    return this.mutate((out) => {
      const current = this.state.attempts.get(id)
      if (current === undefined) throw new StoreError('NOT_FOUND', `尝试不存在: ${id}`)
      if (patch?.state !== undefined) assertTransition('attempt', current.state, patch.state)
      const next = { ...current, ...patch, id, projectId: current.projectId, taskId: current.taskId }
      this.state.attempts.set(id, next)
      out.attemptId = id
      return next
    }).value
  }

  insertContextPacket(packet) {
    return this.mutate((out) => {
      const id = packet?.id ?? this.ids.contextPacket()
      const next = { ...packet, id }
      this._checkReferences({ ...next, source: 'contextPackets' })
      this.state.contextPackets.set(id, next)
      out.contextPacketId = id
      return next
    }).value
  }

  // ---------- 写入：结果（幂等） / 成果 ----------

  /**
   * 结果去重：同一 (attemptId, reportVersion) 或同一条源消息只登记一次。
   * 完成事件重复到达是常态（刷新、重连、双窗口），重写一次结果会把检查与未完成项覆盖成“最新一次”的假象。
   */
  recordResult(input) {
    const projectId = requireString(input?.projectId, 'projectId')
    const attemptId = requireString(input?.attemptId, 'attemptId')
    const reportVersion = input.reportVersion ?? 1
    const sourceMessageRef = input.sourceMessageRef ?? null
    const existing = this._findDuplicateResult(projectId, attemptId, reportVersion, sourceMessageRef)
    if (existing !== undefined) return { result: clone(existing), duplicate: true }
    return this.mutate((out) => {
      const stamp = nowIso(this.clock)
      const result = {
        id: this.ids.result(),
        projectId,
        taskId: input.taskId ?? null,
        attemptId,
        reportVersion,
        summary: String(input.summary ?? ''),
        artifactRefs: Array.isArray(input.artifactRefs) ? [...input.artifactRefs] : [],
        checks: Array.isArray(input.checks) ? clone(input.checks) : [],
        remainingItems: Array.isArray(input.remainingItems) ? [...input.remainingItems] : [],
        blockedReason: input.blockedReason ?? null,
        sourceMessageRef: sourceMessageRef ?? null,
        createdAt: stamp,
      }
      this._checkReferences({ ...result, source: 'results' })
      this.state.results.set(result.id, result)
      this._appendEvent({ type: 'result.recorded', projectId, payload: { resultId: result.id, attemptId } }, stamp)
      out.resultId = result.id
      return { result, duplicate: false }
    }).value
  }

  _findDuplicateResult(projectId, attemptId, reportVersion, sourceMessageRef) {
    for (const row of this.state.results.values()) {
      if (row.projectId !== projectId || row.attemptId !== attemptId) continue
      if (row.reportVersion === reportVersion) return row
      if (sourceMessageRef !== null && row.sourceMessageRef === sourceMessageRef) return row
    }
    return undefined
  }

  recordArtifact(input) {
    return this.mutate((out) => {
      const stamp = nowIso(this.clock)
      const artifact = {
        id: input?.id ?? this.ids.artifact(),
        projectId: input?.projectId,
        taskId: input?.taskId ?? null,
        ownerRoleId: input?.ownerRoleId,
        fileRef: input?.fileRef ?? null,
        displayName: input?.displayName ?? '',
        mediaType: input?.mediaType ?? 'application/octet-stream',
        versionOrHash: input?.versionOrHash ?? null,
        verification: input?.verification ?? { status: 'unverified' },
        sourceResultId: input?.sourceResultId ?? null,
        // 修订链：revisesArtifactId 指向被替换的旧版本，revision 从 1 起递增。
        // 只在登记时写入，之后不原地改——历史版本必须能追。
        revisesArtifactId: input?.revisesArtifactId ?? null,
        revision: Number.isInteger(input?.revision) && input.revision > 0 ? input.revision : 1,
        revisionOfTaskId: input?.revisionOfTaskId ?? null,
        createdAt: stamp,
      }
      if (!isRoleId(artifact.ownerRoleId)) throw new StoreError('INVALID_ROLE', `未知主责部门: ${String(artifact.ownerRoleId)}`)
      this._checkReferences({ ...artifact, source: 'artifacts' })
      this.state.artifacts.set(artifact.id, artifact)
      out.artifactId = artifact.id
      return artifact
    }).value
  }

  // ---------- 事件日志 / outbox ----------

  /**
   * 追加事件：seq 单调递增，eventId 作为去重键（重复完成事件只登记一次）。
   * 事件与业务写入同一次 mutate，崩溃时要么一起在，要么一起不在。
   */
  appendEvent(event) {
    return this.mutate((out) => {
      const row = this._appendEvent(event, nowIso(this.clock))
      out.eventId = row.eventId
      return row
    }).value
  }

  _appendEvent(event, stamp) {
    // 事件 ID 额外带首个事件自增号：即使调用方注入常量随机源（测试），eventId 仍唯一。
    const eventId = event?.eventId ?? this._nextEventId()
    if (this.state.events.some((row) => row.eventId === eventId)) {
      throw new StoreError('DUPLICATE_EVENT', `事件已登记: ${eventId}`)
    }
    this.state.eventSeq += 1
    const row = {
      eventId,
      seq: this.state.eventSeq,
      type: requireString(event?.type, 'event.type'),
      projectId: event?.projectId ?? null,
      roleId: event?.roleId ?? null,
      taskId: event?.taskId ?? null,
      attemptId: event?.attemptId ?? null,
      payload: clone(event?.payload ?? {}),
      createdAt: stamp,
      processedAt: event?.processedAt ?? null,
      // outbox 投递标记：null 表示尚未确认送达，ack 后写时间戳，事件本身保留审计。
      deliveredAt: event?.deliveredAt ?? null,
    }
    this.state.events.push(row)
    return row
  }

  _nextEventId() {
    const base = newId('event', this.random === undefined ? {} : { random: this.random })
    const taken = this.state.events.some((row) => row.eventId === base)
    return taken ? `${base}.${this.state.eventSeq + 1}` : base
  }

  // ---------- 归属校验 ----------

  _checkReferences(entity) {
    const collection = entity.source
    const table = REFERENCES[collection]
    if (table === undefined) return
    if (entity.projectId === undefined || entity.projectId === null) return
    if (!isIdOf('project', entity.projectId) || !this.state.projects.has(entity.projectId)) {
      throw new StoreError('CROSS_PROJECT', `引用的项目不存在或 ID 非法: ${String(entity.projectId)}`)
    }
    for (const [field, target] of Object.entries(table)) {
      const value = entity[field]
      if (value === undefined || value === null) continue
      const row = this.state[target].get(value)
      if (row === undefined) {
        throw new StoreError('NOT_FOUND', `${field} 指向的${target}不存在: ${value}`)
      }
      if (row.projectId !== entity.projectId) {
        throw new StoreError('CROSS_PROJECT', `跨项目引用被拒绝: ${field}=${value} 属于 ${row.projectId}`)
      }
    }
  }

  /**
   * 显式归属检查，供服务层在写入前校验外部传入的 task/attempt/artifact ID。
   * 不猜身份：调用方带上的 projectId 必须与目标记录一致，否则拒绝。
   */
  assertProjectOwns(projectId, collection, id) {
    const table = this.state[collection]
    if (!(table instanceof Map)) throw new StoreError('INVALID_INPUT', `未知集合: ${collection}`)
    const row = table.get(id)
    if (row === undefined) throw new StoreError('NOT_FOUND', `${collection} 中不存在 ${id}`)
    if (row.projectId !== projectId) {
      throw new StoreError('CROSS_PROJECT', `${collection}/${id} 不属于项目 ${projectId}`)
    }
    return row
  }

  /** 非终态尝试：宿主重启后要对账的对象。 */
  listOpenAttempts() {
    return [...this.state.attempts.values()].filter((row) => !isTerminal('attempt', row.state))
  }

  /**
   * 未完成的 outbox：processedAt 与 deliveredAt 都为空的事件，按 seq 升序。
   * options.limit 为正整数时只取最早的前 limit 条（投递端分批拉取用）；不传或非法则返回全部，保持旧行为。
   * 只读：不递增 revision，也不落盘。
   */
  listPendingEvents(projectId, options = {}) {
    const rows = this.state.events
      .filter((row) => row.processedAt === null && (row.deliveredAt ?? null) === null)
      .filter((row) => projectId === undefined || row.projectId === projectId)
      .slice()
      .sort((left, right) => left.seq - right.seq)
    const limit = options?.limit
    if (!Number.isInteger(limit) || limit <= 0) return rows
    return rows.slice(0, limit)
  }

  /**
   * outbox 的 ack：把属于 projectId、且 eventId 在 eventIds 中的事件标记为已投递（deliveredAt）。
   * 不物理删除——投递记录要能审计；重复 ack、未知 id、别的项目的事件都静默忽略（不跨项目写）。
   * 返回 {delivered}：本次实际新标记的条数；一条都没标时不进 mutate，也就不会白增 revision。
   */
  markEventDelivered(projectId, eventIds) {
    requireString(projectId, 'projectId')
    // 项目不存在与其它方法一致抛 NOT_FOUND；纯查询校验，失败时不留任何写入。
    if (!this.state.projects.has(projectId)) {
      throw new StoreError('NOT_FOUND', `项目不存在: ${projectId}`)
    }
    if (!Array.isArray(eventIds)) throw new StoreError('INVALID_INPUT', 'eventIds 必须是数组')
    const wanted = new Set(eventIds.filter((id) => typeof id === 'string' && id !== ''))
    const targets = wanted.size === 0
      ? []
      : this.state.events.filter((row) => wanted.has(row.eventId) && row.projectId === projectId && (row.deliveredAt ?? null) === null)
    if (targets.length === 0) return { delivered: 0 }
    const stamp = nowIso(this.clock)
    return this.mutate(() => {
      for (const row of targets) row.deliveredAt = stamp
      return { delivered: targets.length }
    }).value
  }
}

/** 集合名 → 实体名，供 UI 或日志把表名翻译成实体。 */
export function entityOf(collection) {
  return ENTITY_OF[collection] ?? null
}
