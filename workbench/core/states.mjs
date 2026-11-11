// 四套状态机分开维护：部门运行、任务结论、投递进度、单次尝试。
// 合并成一个大状态会让“空闲”被当成“已完成”，正是方案 7.3/8.1 明确禁止的误判。

export const TASK_STATES = Object.freeze([
  'draft',
  'queued',
  'running',
  'waiting_input',
  'needs_attention',
  'completed',
  'failed',
  'cancelled',
])

export const DISPATCH_STATES = Object.freeze(['prepared', 'sending', 'accepted', 'unknown', 'rejected'])

export const ATTEMPT_STATES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'unknown',
])

export const DEPARTMENT_STATES = Object.freeze(['uninitialized', 'idle', 'queued', 'running', 'unavailable'])

/**
 * Task：draft 校验通过且授权有效才入队；waiting_input 只能回到原任务的执行路径，
 * completed 是唯一“可交付”终态；needs_attention 仍可补报后完成，也可显式失败/取消。
 * 终态（completed / failed / cancelled）不回到任何活动状态：重试一律新 attempt 或新任务。
 */
const TASK_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['queued', 'cancelled']),
  queued: Object.freeze(['running', 'waiting_input', 'needs_attention', 'failed', 'cancelled']),
  running: Object.freeze(['waiting_input', 'needs_attention', 'completed', 'failed', 'cancelled']),
  waiting_input: Object.freeze(['queued', 'running', 'cancelled']),
  needs_attention: Object.freeze(['running', 'completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** Dispatch：发出不等于接收；超时可能 unknown，必须先对账，不能自动当失败重试。 */
const DISPATCH_TRANSITIONS = Object.freeze({
  prepared: Object.freeze(['sending', 'rejected', 'unknown']),
  sending: Object.freeze(['accepted', 'unknown', 'rejected']),
  accepted: Object.freeze([]),
  unknown: Object.freeze(['accepted', 'rejected']),
  rejected: Object.freeze([]),
})

/** Attempt：cancel_requested 不等于已取消；unknown 必须先核对宿主运行再定终态。 */
const ATTEMPT_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled', 'failed', 'unknown']),
  running: Object.freeze(['succeeded', 'failed', 'cancel_requested', 'unknown']),
  cancel_requested: Object.freeze(['cancelled', 'succeeded', 'unknown']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  unknown: Object.freeze(['succeeded', 'failed', 'cancelled', 'running']),
})

/** Department 只表达会话运行情况：unavailable 是绑定失效，仍保留旧引用。 */
const DEPARTMENT_TRANSITIONS = Object.freeze({
  uninitialized: Object.freeze(['idle', 'queued', 'unavailable']),
  idle: Object.freeze(['queued', 'running', 'unavailable']),
  queued: Object.freeze(['running', 'idle', 'unavailable']),
  running: Object.freeze(['idle', 'queued', 'unavailable']),
  unavailable: Object.freeze(['uninitialized', 'idle']),
})

const MACHINES = Object.freeze({
  task: Object.freeze({ key: 'task', name: 'Task', states: TASK_STATES, transitions: TASK_TRANSITIONS }),
  dispatch: Object.freeze({ key: 'dispatch', name: 'Dispatch', states: DISPATCH_STATES, transitions: DISPATCH_TRANSITIONS }),
  attempt: Object.freeze({ key: 'attempt', name: 'Attempt', states: ATTEMPT_STATES, transitions: ATTEMPT_TRANSITIONS }),
  department: Object.freeze({ key: 'department', name: 'Department', states: DEPARTMENT_STATES, transitions: DEPARTMENT_TRANSITIONS }),
})

export const STATE_MACHINES = Object.freeze(
  Object.fromEntries(Object.entries(MACHINES).map(([key, machine]) => [key, Object.freeze({
    name: machine.name,
    states: machine.states,
    transitions: machine.transitions,
  })])),
)

export const TERMINAL_STATES = Object.freeze({
  task: Object.freeze(['completed', 'failed', 'cancelled']),
  dispatch: Object.freeze(['accepted', 'rejected']),
  attempt: Object.freeze(['succeeded', 'failed', 'cancelled']),
  department: Object.freeze([]),
})

function machineOf(kind) {
  const machine = MACHINES[kind]
  if (machine === undefined) throw new Error(`未知状态机: ${String(kind)}`)
  return machine
}

export function statesOf(kind) {
  return machineOf(kind).states
}

export function isState(kind, value) {
  return machineOf(kind).states.includes(value)
}

export function allowedTransitions(kind, from) {
  const machine = machineOf(kind)
  if (!machine.states.includes(from)) throw new Error(`${machine.name} 未知状态: ${String(from)}`)
  return machine.transitions[from]
}

export function canTransition(kind, from, to) {
  // 同状态重复写入不算迁移：事件重放时应由调用方静默忽略，而不是报错。
  if (from === to) return true
  return allowedTransitions(kind, from).includes(to)
}

const MACHINE_KEY = Object.freeze({ task: 'task', dispatch: 'dispatch', attempt: 'attempt', department: 'department' })

export function isTerminal(kind, state) {
  return TERMINAL_STATES[machineOf(kind).key].includes(state)
}

/** 非法迁移一律抛错：状态倒退还沉默会让故障矩阵里“终态不被覆盖”的保证失效。 */
export function assertTransition(kind, from, to) {
  const machine = machineOf(kind)
  if (!machine.states.includes(from)) throw new Error(`${machine.name} 当前状态非法: ${String(from)}`)
  if (!machine.states.includes(to)) throw new Error(`${machine.name} 目标状态非法: ${String(to)}`)
  if (from === to) return to
  if (!machine.transitions[from].includes(to)) {
    throw new Error(`${machine.name} 不允许从 ${from} 迁移到 ${to}`)
  }
  return to
}
