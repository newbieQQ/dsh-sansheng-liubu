import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTEMPT_STATES,
  DEPARTMENT_STATES,
  DISPATCH_STATES,
  STATE_MACHINES,
  TASK_STATES,
  TERMINAL_STATES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isState,
  isTerminal,
  statesOf,
} from '../core/states.mjs'

test('every machine lists the plan states verbatim', () => {
  assert.deepEqual([...TASK_STATES], [
    'draft',
    'queued',
    'running',
    'waiting_input',
    'needs_attention',
    'completed',
    'failed',
    'cancelled',
  ])
  assert.deepEqual([...DISPATCH_STATES], ['prepared', 'sending', 'accepted', 'unknown', 'rejected'])
  assert.deepEqual([...ATTEMPT_STATES], [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancel_requested',
    'cancelled',
    'unknown',
  ])
  assert.deepEqual([...DEPARTMENT_STATES], ['uninitialized', 'idle', 'queued', 'running', 'unavailable'])
  assert.equal(Object.keys(STATE_MACHINES).length, 4)
})

test('state queries validate the machine name', () => {
  assert.equal(isState('task', 'draft'), true)
  assert.equal(isState('task', 'pending'), false, '旧 pending/in_progress 不属于新状态机')
  assert.equal(isState('attempt', 'cancel_requested'), true)
  assert.deepEqual(statesOf('department'), DEPARTMENT_STATES)
  assert.throws(() => statesOf('nope'), /未知状态机/)
  assert.throws(() => allowedTransitions('task', 'pending'), /未知状态/)
})

test('task happy path and legal detours', () => {
  assert.deepEqual([...allowedTransitions('task', 'draft')], ['queued', 'cancelled'])
  assert.equal(canTransition('task', 'draft', 'queued'), true)
  assert.equal(canTransition('task', 'queued', 'running'), true)
  assert.equal(canTransition('task', 'running', 'completed'), true)
  assert.equal(canTransition('task', 'running', 'waiting_input'), true)
  assert.equal(canTransition('task', 'waiting_input', 'queued'), true)
  assert.equal(canTransition('task', 'needs_attention', 'completed'), true, '补报后可完成')
  assert.equal(canTransition('task', 'running', 'draft'), false)
  assert.equal(canTransition('task', 'completed', 'running'), false, '终态不回退')
  assert.equal(canTransition('task', 'failed', 'running'), false)
  assert.equal(canTransition('task', 'cancelled', 'queued'), false)
  assert.equal(canTransition('task', 'running', 'running'), true, '同状态重复写入视为幂等')
})

test('dispatch states separate sending from accepted', () => {
  assert.equal(canTransition('dispatch', 'prepared', 'sending'), true)
  assert.equal(canTransition('dispatch', 'sending', 'accepted'), true)
  assert.equal(canTransition('dispatch', 'sending', 'unknown'), true, '回执超时进入 unknown')
  assert.equal(canTransition('dispatch', 'unknown', 'accepted'), true, '对账后可确认已接收')
  assert.equal(canTransition('dispatch', 'unknown', 'rejected'), true)
  assert.equal(canTransition('dispatch', 'accepted', 'unknown'), false)
  assert.equal(canTransition('dispatch', 'rejected', 'sending'), false)
  assert.equal(canTransition('dispatch', 'prepared', 'accepted'), false, '不能跳过发送直接接收')
})

test('attempt states keep cancel requests separate from cancellation', () => {
  assert.equal(canTransition('attempt', 'queued', 'running'), true)
  assert.equal(canTransition('attempt', 'running', 'cancel_requested'), true)
  assert.equal(canTransition('attempt', 'cancel_requested', 'cancelled'), true)
  assert.equal(canTransition('attempt', 'cancel_requested', 'succeeded'), true, '取消与成功竞争照常落终态')
  assert.equal(canTransition('attempt', 'cancelled', 'running'), false)
  assert.equal(canTransition('attempt', 'unknown', 'running'), true, '对账发现仍在跑')
  assert.equal(canTransition('attempt', 'succeeded', 'failed'), false)
})

test('department states describe the session, not the task', () => {
  assert.equal(canTransition('department', 'uninitialized', 'queued'), true)
  assert.equal(canTransition('department', 'running', 'unavailable'), true)
  assert.equal(canTransition('department', 'unavailable', 'idle'), true)
  assert.equal(canTransition('department', 'idle', 'completed'), false, '部门没有完成态')
})

test('assertTransition throws readable errors and returns the target', () => {
  assert.equal(assertTransition('task', 'draft', 'queued'), 'queued')
  assert.equal(assertTransition('task', 'queued', 'queued'), 'queued')
  assert.throws(() => assertTransition('task', 'completed', 'running'), /Task 不允许从 completed 迁移到 running/)
  assert.throws(() => assertTransition('task', 'bogus', 'running'), /当前状态非法/)
  assert.throws(() => assertTransition('task', 'draft', 'bogus'), /目标状态非法/)
  assert.throws(() => assertTransition('nope', 'draft', 'queued'), /未知状态机/)
})

test('terminal states are explicit per machine', () => {
  assert.equal(isTerminal('task', 'completed'), true)
  assert.equal(isTerminal('task', 'needs_attention'), false, '待核不算完成')
  assert.equal(isTerminal('dispatch', 'accepted'), true)
  assert.equal(isTerminal('dispatch', 'unknown'), false, 'unknown 必须对账')
  assert.equal(isTerminal('attempt', 'cancel_requested'), false)
  assert.equal(isTerminal('attempt', 'cancelled'), true)
  assert.equal(isTerminal('department', 'unavailable'), false)
  assert.throws(() => isTerminal('nope', 'x'), /未知状态机/)
})

test('terminal state sets match the machines', () => {
  assert.deepEqual([...TERMINAL_STATES.task], ['completed', 'failed', 'cancelled'])
  assert.deepEqual([...TERMINAL_STATES.dispatch], ['accepted', 'rejected'])
  assert.deepEqual([...TERMINAL_STATES.attempt], ['succeeded', 'failed', 'cancelled'])
  // 部门不是业务流程，没有“完成”概念
  assert.deepEqual([...TERMINAL_STATES.department], [])
  for (const key of Object.keys(TERMINAL_STATES)) {
    for (const state of TERMINAL_STATES[key]) {
      assert.equal(isTerminal(key, state), true, )
      assert.deepEqual(allowedTransitions(key, state), [], )
    }
  }
})
