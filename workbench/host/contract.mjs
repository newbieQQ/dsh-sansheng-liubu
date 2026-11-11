// 部门 ↔ 程序的内部操作契约（方案 §6）。
//
// 四个动作是唯一的“业务事实来源”：
//   dispatchTask / reportTaskResult / requestTaskInput / syncDecision
// 部门在会话里怎么说话都不影响账本；账本只认这四条结构化调用。
//
// 部门在没有自建 HTTP 通道时，用一段可解析的行内指令表达这四个动作：
//   【三省六部】{"action":"reportTaskResult","taskId":"task_…","attemptId":"att_…",…}
// 指令行必须单独成行，前缀固定、正文是单行 JSON。解析器宁可返回 null 也不猜测：
// 解析失败的行当普通文本，绝不用“看起来像”的句子更新任务状态（方案明令禁止）。
//
// 这里只做“文本 ↔ 结构化调用”的纯转换，不碰网络、不碰 store，便于单测。

export const CONTRACT_ACTION_PREFIX = '【三省六部】'

/** 四个合法动作：多一个少一个都属于“意图不明”，直接拒绝而不是猜。 */
export const CONTRACT_ACTIONS = Object.freeze([
  'dispatchTask',
  'reportTaskResult',
  'requestTaskInput',
  'syncDecision',
])

const ACTION_SET = new Set(CONTRACT_ACTIONS)

export class ContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * 从一段部门输出里取出全部契约行。
 *
 * 返回 { calls, invalid }：
 * - calls：解析成功的调用，按出现顺序；
 * - invalid：看起来像契约行但 JSON 坏了/缺 action 的行（附原文，便于在 UI 上提示重发）。
 *
 * 一个动作只接受一行一条。同一行里塞数组视为格式错误：批量派发必须逐条写，
 * 否则“派发到一半失败”无法解释是哪一条。
 */
export function parseContractLines(text) {
  const calls = []
  const invalid = []
  if (typeof text !== 'string' || text === '') return { calls, invalid }
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith(CONTRACT_ACTION_PREFIX)) continue
    const body = line.slice(CONTRACT_ACTION_PREFIX.length).trim()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      invalid.push({ line: raw, reason: `JSON 解析失败：${error.message}` })
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalid.push({ line: raw, reason: '契约正文必须是单个对象' })
      continue
    }
    if (typeof parsed.action !== 'string' || !ACTION_SET.has(parsed.action)) {
      invalid.push({ line: raw, reason: `未知动作：${String(parsed.action)}` })
      continue
    }
    calls.push({ action: parsed.action, payload: parsed })
  }
  return { calls, invalid }
}

/** 给部门用的指令模板：只描述字段，不塞业务判断，避免模板把“已完成”写成结论。 */
const TEMPLATES = Object.freeze({
  dispatchTask: {
    taskId: 'task_…',
    targetRoleId: 'gongbu',
    idempotencyKey: '<同一任务同一意图固定不变>',
    packet: { objective: '…', acceptance: ['…'], constraints: [], materialRefs: [] },
  },
  reportTaskResult: {
    taskId: 'task_…',
    attemptId: 'att_…',
    reportVersion: 1,
    summary: '做了什么、结果是什么',
    checks: [{ name: '检查项', ok: true, detail: '证据' }],
    artifactRefs: ['art_…'],
  },
  requestTaskInput: {
    taskId: 'task_…',
    attemptId: 'att_…',
    reason: '缺什么、为什么必须由用户决定',
  },
  syncDecision: {
    taskId: 'task_…',
    decision: 'approve | reject | retry',
    note: '可选说明',
  },
})

/** 渲染成可直接贴进部门系统提示的一小段说明。 */
export function describeContract() {
  const lines = [
    `需要走程序的动作，请单独起一行，写作：${CONTRACT_ACTION_PREFIX}{…单行 JSON…}`,
    '平台只认下面四个动作，且只认结构化字段——在正文里写“已完成”不会改变任务状态。',
  ]
  for (const action of CONTRACT_ACTIONS) {
    lines.push(`· ${action}：${JSON.stringify(TEMPLATES[action])}`)
  }
  return lines.join('\n')
}

/**
 * 单条调用的轻量校验（字段存在性与形状）。业务级校验（归属、状态机、幂等）在 service 层，
 * 这里只拦“明显没法处理”的调用，让错误尽早、可读地回到部门。
 */
export function validateContractCall(call) {
  const errors = []
  if (call === null || typeof call !== 'object') return ['调用必须是对象']
  if (!ACTION_SET.has(call.action)) errors.push(`未知动作：${String(call.action)}`)
  const payload = call.payload ?? {}
  if (typeof payload.taskId !== 'string' || payload.taskId.trim() === '') errors.push('缺少 taskId')
  switch (call.action) {
    case 'dispatchTask':
      if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.trim() === '') {
        errors.push('dispatchTask 必须带 idempotencyKey（同一意图固定不变）')
      }
      break
    case 'reportTaskResult':
      if (typeof payload.attemptId !== 'string' || payload.attemptId.trim() === '') errors.push('reportTaskResult 必须带 attemptId')
      if (typeof payload.summary !== 'string' || payload.summary.trim() === '') errors.push('reportTaskResult 必须带非空 summary')
      break
    case 'requestTaskInput':
      if (typeof payload.reason !== 'string' || payload.reason.trim() === '') errors.push('requestTaskInput 必须带 reason')
      break
    case 'syncDecision':
      if (typeof payload.decision !== 'string' || payload.decision.trim() === '') errors.push('syncDecision 必须带 decision')
      break
    default:
      break
  }
  return errors
}
