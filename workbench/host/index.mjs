// Host 侧装配：把账本、业务服务、会话层和 HTTP 路由接在一起。
//
// 这一层是唯一知道“账本文件在哪、损坏了怎么办”的地方：
// - 账本损坏（不是 JSON / schemaVersion 不符）时不崩溃：把坏文件改名留存，
//   从空账本启动，并把 warning 交给调用方（index.js / 诊断页）显示。
//   悄悄删掉或不说话都会让人以为“历史记录丢了”。
// - 宿主没有 webServer 时照常返回 service，只是路由不注册，registered=false；
//   若宿主稍后提供了 webServer，用 ctx.inject 补注册一次（不重复建 store）。
// - 宿主没有 sessionController 时，工作台仍能读写账本（投影可用），
//   但派发只落账不投递，UI 显示“尚未接通”，绝不假装成功。
//
// 与 workbench-host.mjs 的关系：那边是「账本 + 会话层 + 对账」的纯逻辑外壳，
// 这边负责文件、损坏隔离、HTTP 与生命周期，并把路由钩子接到外壳上。

import { existsSync, renameSync } from 'node:fs'
import { WorkbenchStore, SCHEMA_VERSION } from '../core/store.mjs'
import { corruptPathFor, ensureSidecarDir, resolveSidecarDir, resolveStorePath } from './paths.mjs'
import { registerWorkbenchRoutes } from './routes.mjs'
import { createWorkbenchHost as createWorkbenchShell } from './workbench-host.mjs'

export { createWorkbenchService } from './service.mjs'
export { createMemoryStore, MemoryError, MEMORY_FILE_MAX_CHARS, MEMORY_EXCERPT_CHARS } from '../core/memory.mjs'
export {
  createWorkbenchHost as createWorkbenchShell,
  CONTRACT_ACTIONS,
  CONTRACT_ACTION_PREFIX,
  describeContract,
  parseContractLines,
  WORKBENCH_HOST_VERSION,
} from './workbench-host.mjs'
export {
  buildRouteTable,
  listWorkbenchRoutes,
  registerWorkbenchRoutes,
  MAX_BODY_BYTES,
  ROUTE_PREFIX,
} from './routes.mjs'
export {
  SIDECAR_DIR_NAME,
  corruptPathFor,
  ensureSidecarDir,
  quarantineFile,
  readJsonSafe,
  resolveSidecarDir,
  resolveSidecarFile,
  resolveStorePath,
  writeFileAtomic,
  writeJsonAtomic,
} from './paths.mjs'

/**
 * 创建 Host 侧工作台。
 *
 * @param {object|null} ctx 宿主上下文（可为 null：服务仍可用，只是没有路由/会话）。
 * @param {object} [options]
 * @param {string} [options.file] 账本路径；默认 %DSH_HOME%/sansheng-liubu/workbench.json。
 * @param {object} [options.env] 计算默认路径用的环境变量。
 * @param {() => number} [options.clock] 注入时钟。
 * @param {() => string} [options.random] 注入随机源（测试里固定 ID 用）。
 * @param {boolean} [options.load=true] 是否从磁盘加载既有账本。
 * @param {string} [options.presetId] 部门会话使用的 agentPreset，默认「上朝」。
 * @param {boolean} [options.startReconciler=true] 是否启动周期对账。
 * @param {number} [options.longPollMs] 事件长轮询上限（毫秒）。
 * @param {number} [options.pollIntervalMs] 长轮询内部检查间隔（毫秒）。
 * @returns {object} 见文件末尾 return 语句的字段说明。
 */
export function createWorkbenchHost(ctx, options = {}) {
  const env = options.env ?? process.env
  const clock = options.clock ?? Date.now
  const file = options.file === undefined ? resolveStorePath(env) : options.file
  const warnings = []
  const log = typeof options.log === 'function' ? options.log : () => {}

  // 测试与嵌入场景可以自带账本；自带时不碰磁盘路径，也不做损坏隔离（那是文件的责任）。
  const injectedStore = options.store ?? null
  const store = injectedStore ?? new WorkbenchStore({
    file,
    clock,
    env,
    ...(options.random === undefined ? {} : { random: options.random }),
  })

  if (injectedStore === null && options.load !== false && file !== null && file !== '') {
    ensureSidecarDir(env)
    if (existsSync(file)) {
      try {
        store.load()
      } catch (error) {
        // 损坏与版本不符都是“这个文件不能用”：改名留存后从空账本启动。
        // 绝不覆盖原文件——里面可能是用户唯一一份历史。
        const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-')
        let quarantined = corruptPathFor(file, stamp)
        try {
          renameSync(file, quarantined)
        } catch (renameError) {
          // 改名失败（被占用/权限不足）：不能继续往同一个文件写，退回纯内存账本。
          quarantined = null
          warnings.push(
            `账本损坏且无法改名留存（${renameError?.code ?? 'UNKNOWN'}）：${error?.message ?? ''}；本次使用内存账本`,
          )
        }
        if (quarantined !== null) {
          warnings.push(
            `账本损坏（${error?.code ?? 'ERROR'}：${error?.message ?? ''}），已改名留存为 ${quarantined}，以空账本启动`,
          )
        }
      }
    }
  }

  // 外壳持有 store 与 service，并在宿主有能力时装配会话层/派发/对账。
  const shell = createWorkbenchShell(ctx, {
    store,
    presetId: options.presetId,
    startReconciler: options.startReconciler,
    clock,
    // 成果文件是否还在，由宿主文件系统回答（A23 失效显示）；测试可注入替身。
    fileExists: options.fileExists ?? existsSync,
  })
  const service = shell.service

  const hooks = routeHooks(shell, service)
  let routes = registerWorkbenchRoutes(ctx, service, { ...options, ...hooks })
  let registered = routes.registered !== false
  if (!registered) warnings.push(`工作台接口未注册：${routes.reason ?? '宿主未提供 webServer'}`)

  // 宿主稍后才提供 webServer 时补注册一次；cordis 会在依赖出现时回调，
  // 插件卸载时随作用域一起清理，不需要手工跟踪。
  if (!registered && ctx !== null && typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        if (registered) return
        const late = registerWorkbenchRoutes({ webServer: scoped?.webServer }, service, { ...options, ...hooks })
        if (late.registered === false) return
        routes = late
        registered = true
      })
    } catch (error) {
      warnings.push(`工作台接口补注册失败：${error?.message ?? error}`)
    }
  }

  // 会话层也可能晚到：apply 时 sessionController 还没装好，等它出现再挂载一次，
  // 这样用户不必为了「接通部门」而多重启一次 DSH。
  if (shell.hasSessions === false && ctx !== null && typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['sessionController'], (scoped) => {
        if (shell.hasSessions === true) return
        const controller = scoped?.sessionController ?? scoped?.remote?.session ?? null
        if (controller === null) return
        if (!shell.attachSessions(controller)) return
        log('[sansheng-liubo] 会话层已就绪，部门可以接通与派发')
      })
    } catch (error) {
      warnings.push(`会话层补挂失败：${error?.message ?? error}`)
    }
  }

  shell.start()

  const dispose = () => {
    try {
      routes()
    } finally {
      shell.dispose()
    }
  }

  return {
    store,
    service,
    shell,
    routes,
    get sessions() {
      return shell.sessions
    },
    get reconciler() {
      return shell.reconciler
    },
    get dispatchService() {
      return shell.dispatchService
    },
    get hasSessions() {
      return shell.hasSessions
    },
    attachSessions: shell.attachSessions,
    presetId: shell.presetId,
    connectDepartment: shell.connectDepartment,
    dispatchTask: shell.dispatchTask,
    ingestAgentOutput: shell.ingestAgentOutput,
    file: store.file,
    sidecarDir: resolveSidecarDir(env),
    get registered() {
      return registered
    },
    warning: warnings.length === 0 ? null : warnings.join('；'),
    warnings,
    /** 卸载路由与后台服务（幂等）；账本不删除，下次启动继续用。 */
    dispose,
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * 路由钩子：只有宿主真有能力时才接管，否则让路由退回“只落账”的保守路径。
 * 这样“没接通”永远不会被伪装成“已发送”。
 */
function routeHooks(shell, service) {
  return {
    connect: (input) => shell.connectDepartment(input),
    ingest: (input) => shell.ingestAgentOutput(input),
    // 会话层可能晚到，所以钩子恒挂：真挂上了就走派发，没挂上就退回「只落账」，
    // 绝不把「没接通」伪装成「已发送」。
    dispatch: (input) => {
      if (shell.hasSessions === true) return shell.dispatchTask(input)
      return service.dispatchTask({
        projectId: input.projectId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        sourceRoleId: input.sourceRoleId,
        targetRoleId: input.targetRoleId,
        targetSessionId: input.targetSessionId,
        bindingGeneration: input.bindingGeneration,
        packet: input.packet,
      })
    },
  }
}

export default createWorkbenchHost
