// 工作台 HTTP 路由：把 service 暴露给宿主 Web 服务。
//
// 设计取舍：
// - 全部 exact 路由，不做前缀匹配：/sansheng/workbench/xxx 未登记的一律 404，
//   不会因为前缀相同就把未知路径交给某个 handler 兜底。
// - 非 GET 只接受 POST（其余方法 405），未实现的路径 404，参数错误 400，体过大 413。
// - 统一包装 { ok:true, value } / { ok:false, error:{ code, message, details? } }，
//   Content-Type 带 charset、Cache-Control: no-store、Content-Length 手写。
// - 事件通道用长轮询而不是 SSE：宿主侧只是一个普通 HTTP handler，
//   浏览器刷新/断线重连后靠 since 补齐天然幂等，不需要管连接生命周期；
//   最长挂 25 秒，远低于常见代理/浏览器的空闲超时，也不占住宿主的事件循环。
// - 任何 ctx.webServer 的缺失都在 registerWorkbenchRoutes 里探测并降级：
//   返回一个 no-op 的 dispose，route 列表照常给出，便于诊断而不至于让插件加载失败。

import { ServiceError } from './service.mjs'

export const ROUTE_PREFIX = '/sansheng/workbench'

/** 请求体字节上限：契约里最大的是交接材料（摘录 + 引用），256 KB 足够且能挡住误传大文件。 */
export const MAX_BODY_BYTES = 256 * 1024

/** 长轮询最长挂起时间（毫秒）。浏览器重连后靠 since 补齐，所以不需要真正的无限等待。 */
export const DEFAULT_LONG_POLL_MS = 25_000

/** 轮询间隔：太密会白烧 CPU，太疏会让“有新事件立刻返回”的承诺打折。 */
const POLL_INTERVAL_MS = 1_000

/** 业务错误码 → HTTP 状态码。未列出的统一 400。 */
const STATUS_OF_CODE = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_ROLE: 400,
  INVALID_STATE: 400,
  DISPATCH_INVALID: 400,
  ATTEMPT_MISMATCH: 400,
  REPORT_INVALID: 400,
  NOT_FOUND: 404,
  CROSS_PROJECT: 409,
  CONFIG_CONFLICT: 409,
  SESSION_CONFLICT: 409,
  DUPLICATE_PROJECT: 409,
  INTERNAL: 500,
})

function statusOf(error) {
  if (error instanceof ServiceError) return STATUS_OF_CODE[error.code] ?? 400
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return STATUS_OF_CODE[error.code] ?? 400
  }
  return 500
}

/** 响应写出：统一头 + 手写 Content-Length，HEAD 不写体。 */
function sendJson(res, status, payload, extraHeaders = undefined) {
  const body = JSON.stringify(payload)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders ?? {}),
  }
  res.writeHead(status, headers)
  res.end(body)
  return body
}

function sendOk(res, value, extraHeaders) {
  return sendJson(res, 200, { ok: true, value }, extraHeaders)
}

function sendError(res, error) {
  const status = statusOf(error)
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
  const message = status === 500 && !(error instanceof ServiceError)
    ? '内部错误'
    : (typeof error?.message === 'string' ? error.message : '请求失败')
  const payload = { ok: false, error: { code, message } }
  if (error?.details !== undefined) payload.error.details = error.details
  return sendJson(res, status, payload)
}

/**
 * 读请求体：按字节累计，超限立即拒绝（不再继续读，避免被巨大体拖住）。
 * 空体视为 {}，让无参 POST 也能走同一个入口。
 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) {
      const error = new ServiceError('INVALID_INPUT', `请求体超过 ${limit} 字节上限`, { limit })
      error.httpStatus = 413
      throw error
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed
  } catch {
    const error = new ServiceError('INVALID_INPUT', '请求体必须是 JSON 对象')
    error.httpStatus = 400
    throw error
  }
}

async function readBody(req, limit) {
  try {
    return await readJsonBody(req, limit)
  } catch (error) {
    // 体超限与 JSON 非法是 HTTP 层语义，借 httpStatus 覆盖默认映射。
    if (typeof error.httpStatus === 'number') {
      const wrapped = new ServiceError(error.code, error.message, error.details)
      wrapped.httpStatus = error.httpStatus
      throw wrapped
    }
    throw error
  }
}

/** 从 URL 里取查询参数（不依赖宿主框架，纯 node URL）。 */
function queryOf(url) {
  const index = typeof url === 'string' ? url.indexOf('?') : -1
  if (index < 0) return new URLSearchParams('')
  const rest = url.slice(index + 1)
  const hash = rest.indexOf('#')
  return new URLSearchParams(hash < 0 ? rest : rest.slice(0, hash))
}

function pathOf(url) {
  if (typeof url !== 'string') return ''
  const cut = url.search(/[?#]/)
  return cut < 0 ? url : url.slice(0, cut)
}

/**
 * 长轮询：最多挂 maxWaitMs，期间每 pollIntervalMs 检查一次是否有新事件；
 * 一旦有就立刻返回（不等到窗口结束），没有就等到窗口结束返回空列表 + 当前 seq。
 * 客户端断开（req 触发 close）时立即结束，不留悬挂计时器。
 */
async function waitForEvents(service, projectId, since, options) {
  const maxWaitMs = options.longPollMs ?? DEFAULT_LONG_POLL_MS
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const immediate = service.listEvents(projectId, since, options.eventLimit === undefined ? {} : { limit: options.eventLimit })
  if (immediate.events.length > 0 || immediate.reset) return immediate
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const remain = deadline - Date.now()
    await sleep(Math.max(1, Math.min(pollIntervalMs, remain)))
    const fresh = service.listEvents(projectId, since, options.eventLimit === undefined ? {} : { limit: options.eventLimit })
    if (fresh.events.length > 0 || fresh.reset) return fresh
  }
  return service.listEvents(projectId, since, options.eventLimit === undefined ? {} : { limit: options.eventLimit })
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 计时器不应阻止进程退出（测试里尤其明显）。
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** 统一 handler 包装：方法校验、异常兜底、响应头注入。 */
function wrap(handler, { methods = ['POST'], allowBody = true, bodyLimit = MAX_BODY_BYTES } = {}) {
  return async (req, res) => {
    try {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (!methods.includes(method)) {
        res.setHeader('Allow', methods.join(', '))
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `仅支持 ${methods.join(', ')}` } })
        return
      }
      const body = allowBody && method === 'POST' ? await readBody(req, bodyLimit) : {}
      const url = req.url ?? ''
      const value = await handler({ req, res, body, method, query: queryOf(url), path: pathOf(url) })
      // handler 自己已经写过响应（例如长轮询中途断开）时不再写第二遍。
      if (res.writableEnded === true) return
      const headers = value !== null && typeof value === 'object' && value.__headers !== undefined ? value.__headers : undefined
      const payload = headers === undefined ? value : value.payload
      sendOk(res, payload, headers)
    } catch (error) {
      if (res.writableEnded === true) return
      const status = typeof error?.httpStatus === 'number' ? error.httpStatus : statusOf(error)
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
      const payload = { ok: false, error: { code, message: error?.message ?? '请求失败' } }
      if (error?.details !== undefined) payload.error.details = error.details
      sendJson(res, status, payload)
    }
  }
}

/**
 * 路由表：path → handler 定义。集中声明，便于诊断页一次性列出全部端点。
 * 每个 handler 都从 body/query 取参数并原样交给 service，不在路由层做业务判断。
 */
export function buildRouteTable(service, options = {}) {
  const select = options.projectIdFrom === undefined ? (body) => body.projectId : options.projectIdFrom
  return Object.freeze({
    [`${ROUTE_PREFIX}/bootstrap`]: {
      method: 'GET',
      handler: async ({ query }) => service.bootstrap(query.get('projectId') ?? undefined),
    },
    [`${ROUTE_PREFIX}/project`]: {
      method: 'POST',
      handler: async ({ body }) => service.registerProject({
        hostWorkspaceId: body.hostWorkspaceId,
        displayNameCache: body.displayNameCache,
        canonicalRoot: body.canonicalRoot,
      }),
    },
    [`${ROUTE_PREFIX}/bind`]: {
      method: 'POST',
      handler: async ({ body }) => service.bindDepartmentSession({
        projectId: select(body),
        roleId: body.roleId,
        sessionId: body.sessionId,
        allowReplace: body.allowReplace,
        creationRequestId: body.creationRequestId,
      }),
    },
    [`${ROUTE_PREFIX}/config`]: {
      method: 'POST',
      handler: async ({ body }) => service.saveDepartmentConfig({
        projectId: select(body),
        roleId: body.roleId,
        provider: body.provider,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
        expectedRevision: body.expectedRevision,
      }),
    },
    [`${ROUTE_PREFIX}/task`]: {
      method: 'POST',
      handler: async ({ body }) => service.createTask({
        projectId: select(body),
        title: body.title,
        objective: body.objective,
        acceptance: body.acceptance,
        constraints: body.constraints,
        scope: body.scope,
        ownerRoleId: body.ownerRoleId,
        sourceRoleId: body.sourceRoleId,
        originMessageRef: body.originMessageRef,
        returnTarget: body.returnTarget,
        status: body.status,
      }),
    },
    [`${ROUTE_PREFIX}/task/cancel`]: {
      method: 'POST',
      handler: async ({ body }) => service.cancelTask({
        projectId: select(body),
        taskId: body.taskId,
        reason: body.reason,
      }),
    },
    [`${ROUTE_PREFIX}/connect`]: {
      method: 'POST',
      handler: async ({ body }) => {
        if (typeof options.connect !== 'function') {
          throw new ServiceError('INVALID_STATE', '宿主未提供会话能力，暂时无法接通部门')
        }
        return options.connect({
          projectId: select(body),
          roleId: body.roleId,
          sessionId: body.sessionId,
          agentPreset: body.agentPreset,
        })
      },
    },
    [`${ROUTE_PREFIX}/dispatch`]: {
      method: 'POST',
      handler: async ({ body }) => {
        const ledger = {
          projectId: select(body),
          taskId: body.taskId,
          idempotencyKey: body.idempotencyKey,
          sourceRoleId: body.sourceRoleId,
          targetRoleId: body.targetRoleId,
          targetSessionId: body.targetSessionId,
          bindingGeneration: body.bindingGeneration,
          packet: body.packet,
        }
        // 有 Host 会话能力时走 DispatchService：它会真的把任务单送进部门会话，
        // 并把 prepared → sending → accepted/rejected/unknown 走完。
        // 没有会话层时只落账（prepared），UI 据此显示“尚未接通”，绝不假装已发送。
        if (typeof options.dispatch === 'function') {
          return options.dispatch({
            ...ledger,
            sourceSessionId: body.sourceSessionId,
            mode: body.mode,
            roleName: body.roleName,
          })
        }
        return service.dispatchTask(ledger)
      },
    },
    [`${ROUTE_PREFIX}/ingest`]: {
      method: 'POST',
      handler: async ({ body }) => {
        if (typeof options.ingest !== 'function') {
          throw new ServiceError('INVALID_STATE', '宿主未提供契约解析能力')
        }
        return options.ingest({
          projectId: select(body),
          roleId: body.roleId,
          text: body.text,
        })
      },
    },
    [`${ROUTE_PREFIX}/result`]: {
      method: 'POST',
      handler: async ({ body }) => service.reportTaskResult({
        projectId: select(body),
        taskId: body.taskId,
        attemptId: body.attemptId,
        report: body.report,
        runTerminal: body.runTerminal,
        artifactRefs: body.artifactRefs,
        checks: body.checks,
        remainingItems: body.remainingItems,
        blockedReason: body.blockedReason,
        sourceMessageRef: body.sourceMessageRef,
        reportVersion: body.reportVersion,
      }),
    },
    [`${ROUTE_PREFIX}/artifact/revision`]: {
      method: 'POST',
      handler: async ({ body }) => service.requestArtifactRevision({
        projectId: select(body),
        artifactId: body.artifactId,
        instruction: body.instruction,
        ownerRoleId: body.ownerRoleId,
        sourceRoleId: body.sourceRoleId,
        title: body.title,
        acceptance: body.acceptance,
        constraints: body.constraints,
        status: body.status,
        originMessageRef: body.originMessageRef,
        returnTarget: body.returnTarget,
      }),
    },
    [`${ROUTE_PREFIX}/artifact`]: {
      method: 'POST',
      handler: async ({ body }) => service.registerArtifact({
        projectId: select(body),
        taskId: body.taskId,
        ownerRoleId: body.ownerRoleId,
        fileRef: body.fileRef,
        displayName: body.displayName,
        mediaType: body.mediaType,
        versionOrHash: body.versionOrHash,
        verification: body.verification,
        sourceResultId: body.sourceResultId,
        revisesArtifactId: body.revisesArtifactId,
      }),
    },
    [`${ROUTE_PREFIX}/memory/get`]: {
      method: 'POST',
      handler: async ({ body }) => service.getMemory({
        scope: body.scope,
        projectId: select(body),
        roleId: body.roleId,
      }),
    },
    [`${ROUTE_PREFIX}/memory/put`]: {
      method: 'POST',
      handler: async ({ body }) => service.putMemory({
        scope: body.scope,
        projectId: select(body),
        roleId: body.roleId,
        text: body.text,
      }),
    },
    [`${ROUTE_PREFIX}/memory/append`]: {
      method: 'POST',
      handler: async ({ body }) => service.appendMemory({
        scope: body.scope,
        projectId: select(body),
        roleId: body.roleId,
        text: body.text,
      }),
    },
    [`${ROUTE_PREFIX}/events`]: {
      method: 'GET',
      handler: async ({ query, req, res }) => {
        const projectId = query.get('projectId') ?? undefined
        const since = Number(query.get('since') ?? 0)
        if (query.get('since') !== null && !Number.isFinite(since)) {
          throw new ServiceError('INVALID_INPUT', 'since 必须是数字', { field: 'since' })
        }
        const immediateOnly = query.get('wait') === '0'
        if (immediateOnly || (options.longPollMs ?? DEFAULT_LONG_POLL_MS) <= 0) {
          return service.listEvents(projectId, since, { limit: options.eventLimit })
        }
        return waitForEvents(service, projectId, since, {
          ...options,
          // 客户端断开时不再等满窗口：把当前结果写回去（或让外层发现已结束）。
          onAbort: () => {
            if (res.writableEnded !== true && res.destroyed !== true) {
              sendOk(res, service.listEvents(projectId, since, { limit: options.eventLimit }), { Connection: 'close' })
            }
          },
        })
      },
    },
  })
}

/**
 * 注册路由。宿主没有 webServer（或没有 register）时返回 no-op dispose，
 * 并在返回值上标 registered:false，调用方可据此提示“宿主不支持工作台接口”。
 *
 * @returns {() => void} dispose：卸载全部已注册路由；重复调用无副作用。
 */
export function registerWorkbenchRoutes(ctx, service, options = {}) {
  const disposes = []
  const server = ctx?.webServer
  if (server === undefined || server === null || typeof server.register !== 'function') {
    const noop = () => {}
    noop.registered = false
    noop.reason = '宿主未提供 webServer.register'
    return noop
  }
  const table = buildRouteTable(service, options)
  const bodyLimit = options.maxBodyBytes ?? MAX_BODY_BYTES
  try {
    for (const [path, def] of Object.entries(table)) {
      const methods = def.method === 'GET' ? ['GET'] : ['POST']
      const handler = wrap(def.handler, { methods, allowBody: def.method === 'POST', bodyLimit })
      const dispose = server.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposes.push(dispose)
    }
  } catch (error) {
    // 部分注册失败：先把已注册的回滚，避免留下半套路由（前端会看到一多半 404）。
    for (const dispose of disposes.reverse()) {
      try {
        dispose()
      } catch {
        // 卸载失败不影响主流程：宿主要么已卸载，要么进程即将重启。
      }
    }
    throw error
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const fn of disposes.reverse()) {
      try {
        fn()
      } catch {
        // 同上：dispose 必须幂等且不抛。
      }
    }
  }
  dispose.registered = true
  dispose.paths = Object.keys(table)
  return dispose
}

/** 供诊断页使用：列出全部端点与其方法。 */
export function listWorkbenchRoutes() {
  return Object.entries(buildRouteTable({ bootstrap: () => null }, {})).map(([path, def]) => ({ path, method: def.method }))
}
