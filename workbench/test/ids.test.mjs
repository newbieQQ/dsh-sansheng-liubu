import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createIdFactory,
  ID_ENTITIES,
  ID_PREFIXES,
  cryptoRandom,
  isIdOf,
  newId,
} from '../core/ids.mjs'

test('every entity prefix appears in the plan and generated ids round-trip', () => {
  for (const entity of ID_ENTITIES) {
    const id = newId(entity, { random: () => 0 })
    assert.match(id, new RegExp(`^${ID_PREFIXES[entity]}_[0-9a-z]{12}$`), `${entity} 前缀正确`)
    assert.equal(isIdOf(entity, id), true)
  }
  // 前缀本身也能直接使用，方便调用方不想记实体名的场景。
  assert.match(newId('task', { random: () => 3 }), /^task_3{12}$/)
})

test('prefixes stay unique so ids cannot be confused across entities', () => {
  const prefixes = Object.values(ID_PREFIXES)
  assert.equal(new Set(prefixes).size, prefixes.length)
  assert.deepEqual(prefixes.slice(0, 3), ['proj', 'bind', 'cfg'])
})

test('injected random source makes ids reproducible', () => {
  const seq = (limit) => {
    let index = 0
    return () => index++ % limit
  }
  assert.equal(newId('project', { random: seq(36), length: 6 }), 'proj_012345')
  const a = createIdFactory({ random: () => 1, length: 4 })
  const b = createIdFactory({ random: () => 1, length: 4 })
  for (const entity of ID_ENTITIES) {
    assert.equal(a[entity](), b[entity]())
    assert.match(a[entity](), new RegExp(`^${ID_PREFIXES[entity]}_`))
  }
})

test('character alphabet values are accepted and unknown prefixes rejected', () => {
  assert.equal(newId('result', { random: (i) => ['a', 'b', 'c', 'd'][i], length: 4 }), 'res_abcd')
  assert.throws(() => newId('nope', { random: () => 0 }), /未知 ID 前缀/)
  assert.throws(() => newId('task', { random: () => 'Z', length: 4 }), /字母表外/)
  assert.throws(() => newId('task', { random: () => 1.5, length: 4 }), /整数/)
  assert.throws(() => newId('task', { random: () => 0, length: 2 }), /4..64/)
  assert.equal(isIdOf('task', 'dsp_abc'), false)
  assert.equal(isIdOf('task', 'task_'), false)
  assert.equal(isIdOf('task', undefined), false)
})

test('default crypto source produces distinct ids', () => {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return
  assert.match(cryptoRandom(), /^[0-9a-z]$/)
  const ids = new Set(Array.from({ length: 50 }, () => newId('task')))
  assert.ok(ids.size >= 45, '随机 ID 冲突率应很低')
})
