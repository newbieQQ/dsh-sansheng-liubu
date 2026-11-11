// 记忆层测试：三层记忆的读写与隔离、派发注入、成果自动记账。
// 用真实 WorkbenchStore（内存账本）+ 临时目录里的真实记忆文件，不 mock 存储层。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchStore } from '../core/store.mjs'
import { createMemoryStore, MEMORY_EXCERPT_CHARS } from '../core/memory.mjs'
import { createWorkbenchService } from '../host/service.mjs'

const FIXED_NOW = Date.parse('2026-11-10T12:00:00.000Z')

function makeWorld(withMemory = true) {
  const dir = mkdtempSync(join(tmpdir(), 'sansheng-memory-'))
  let counter = 1234567
  const random = () => Math.imul(counter++, 2654435761) >>> 0
  const store = new WorkbenchStore({ file: null, clock: () => FIXED_NOW, random })
  const memory = createMemoryStore({ dir: join(dir, 'memory'), clock: () => FIXED_NOW })
  const service = createWorkbenchService({
    store,
    clock: () => FIXED_NOW,
    ...(withMemory ? { memory } : {}),
  })
  const project = service.registerProject({ hostWorkspaceId: 'ws-1', displayNameCache: '项目一' }).project
  service.bindDepartmentSession({ projectId: project.id, roleId: 'libu', sessionId: 'sess-libu' })
  return { dir, store, memory, service, project }
}

function cleanup(world) {
  rmSync(world.dir, { recursive: true, force: true })
}

// ---------- 记忆存储 ----------

test('memory store: long-term write/read and dated appends', () => {
  const world = makeWorld()
  try {
    const { memory } = world
    assert.deepEqual(memory.readLongTerm(), { text: '', exists: false })
    memory.writeLongTerm('用户偏好：结论先行')
    assert.equal(memory.readLongTerm().text, '用户偏好：结论先行')
    memory.appendLongTerm('长期经验：先小步验证')
    const text = memory.readLongTerm().text
    assert.ok(text.includes('用户偏好：结论先行'))
    assert.ok(text.includes('## 2026-11-10'))
    assert.ok(text.includes('长期经验：先小步验证'))
    // 文件就是普通 Markdown，落在 long-term.md
    assert.equal(readFileSync(memory.longTermPath, 'utf8'), text)
  } finally { cleanup(world) }
})

test('memory store: project memories are isolated and ids are validated', () => {
  const world = makeWorld()
  try {
    const { memory, project } = world
    const other = world.service.registerProject({ hostWorkspaceId: 'ws-2' }).project
    memory.appendProject(project.id, '本项目的约定：数据先复算')
    assert.ok(memory.readProject(project.id).text.includes('数据先复算'))
    assert.equal(memory.readProject(other.id).exists, false, '别的项目读不到本项目记忆')
    assert.throws(() => memory.readProject('../evil'), /不合法/)
    assert.throws(() => memory.appendProject('task_abc', 'x'), /不合法/)
    assert.throws(() => memory.appendLongTerm('   '), /不能为空/)
    assert.throws(() => memory.writeLongTerm('x'.repeat(70 * 1024)), /上限/)
  } finally { cleanup(world) }
})

test('memory store: excerpts are labeled, project first, and capped', () => {
  const world = makeWorld()
  try {
    const { memory, project } = world
    assert.deepEqual(memory.excerptsFor(project.id), [], '没有记忆就没有摘录')
    memory.writeLongTerm('长'.repeat(MEMORY_EXCERPT_CHARS.longTerm + 100))
    memory.writeProject(project.id, '项'.repeat(MEMORY_EXCERPT_CHARS.project + 100))
    const excerpts = memory.excerptsFor(project.id)
    assert.equal(excerpts.length, 2)
    assert.ok(excerpts[0].startsWith('「项目记忆」'))
    assert.ok(excerpts[1].startsWith('「长期记忆」'))
    assert.ok(excerpts[0].includes('已截断'))
    assert.ok(excerpts[0].length < MEMORY_EXCERPT_CHARS.project + 40)
  } finally { cleanup(world) }
})

// ---------- 服务层 ----------

test('service memory API: scopes, project checks, and disabled memory', () => {
  const world = makeWorld()
  try {
    const { service, project } = world
    service.putMemory({ scope: 'long-term', text: '全局约定' })
    assert.equal(service.getMemory({ scope: 'long-term' }).text, '全局约定')
    service.appendMemory({ scope: 'project', projectId: project.id, text: '第一次结论' })
    const got = service.getMemory({ scope: 'project', projectId: project.id })
    assert.ok(got.text.includes('第一次结论'))
    assert.throws(() => service.getMemory({ scope: 'sideways' }), (e) => e.code === 'INVALID_INPUT')
    assert.throws(() => service.getMemory({ scope: 'project', projectId: 'proj_missing1' }), (e) => e.code === 'NOT_FOUND')
  } finally { cleanup(world) }

  const bare = makeWorld(false)
  try {
    assert.throws(() => bare.service.getMemory({ scope: 'long-term' }), (e) => e.code === 'INVALID_STATE')
  } finally { cleanup(bare) }
})

test('dispatch injects memory excerpts into the context packet', () => {
  const world = makeWorld()
  try {
    const { service, project } = world
    service.putMemory({ scope: 'long-term', text: '长期偏好：先给结论' })
    service.putMemory({ scope: 'project', projectId: project.id, text: '项目背景：二期工程' })
    const task = service.createTask({ projectId: project.id, title: '甲', objective: '甲目标', ownerRoleId: 'libu' }).task
    const dispatched = service.dispatchTask({
      projectId: project.id,
      taskId: task.id,
      idempotencyKey: 'idem-mem-1',
      packet: { excerpts: ['原始需求'] },
    })
    const excerpts = dispatched.contextPacket.excerpts
    assert.equal(excerpts[0], '原始需求', '调用方摘录在最前')
    assert.ok(excerpts.some((line) => line.startsWith('「项目记忆」') && line.includes('二期工程')))
    assert.ok(excerpts.some((line) => line.startsWith('「长期记忆」') && line.includes('先给结论')))
  } finally { cleanup(world) }
})

test('result report journals into project memory once, duplicates do not re-journal', () => {
  const world = makeWorld()
  try {
    const { service, memory, project } = world
    const task = service.createTask({ projectId: project.id, title: '乙', objective: '乙目标', ownerRoleId: 'libu' }).task
    const dispatched = service.dispatchTask({ projectId: project.id, taskId: task.id, idempotencyKey: 'idem-mem-2' })
    service.startAttempt({ projectId: project.id, taskId: task.id, attemptId: dispatched.attempt.id, hostRunId: 'run-1' })
    const input = {
      projectId: project.id,
      taskId: task.id,
      attemptId: dispatched.attempt.id,
      report: { summary: '已完成测算' },
      runTerminal: 'succeeded',
    }
    service.reportTaskResult(input)
    service.reportTaskResult(input)
    const text = memory.readProject(project.id).text
    assert.ok(text.includes('libu 汇报成果'))
    assert.ok(text.includes('已完成测算'))
    assert.equal(text.split('已完成测算').length - 1, 1, '重复汇报只记一行')
  } finally { cleanup(world) }
})

// ---------- 部门记忆（第三层） ----------

test('memory store: department memories are per-role, isolated, and validated', () => {
  const world = makeWorld()
  try {
    const { memory } = world
    assert.deepEqual(memory.readDepartment('gongbu'), { text: '', exists: false })
    memory.appendDepartment('gongbu', '工部经验：先量尺寸再下料')
    assert.ok(memory.readDepartment('gongbu').text.includes('先量尺寸再下料'))
    assert.equal(memory.readDepartment('xingbu').exists, false, '别的部门读不到工部记忆')
    // 文件落在 departments/<roleId>.md，就是普通 Markdown
    assert.equal(readFileSync(memory.departmentPath('gongbu'), 'utf8'), memory.readDepartment('gongbu').text)
    assert.throws(() => memory.readDepartment('not-a-role'), /不合法/)
    assert.throws(() => memory.appendDepartment('../evil', 'x'), /不合法/)
  } finally { cleanup(world) }
})

test('memory store: excerpts put department first when a role is given', () => {
  const world = makeWorld()
  try {
    const { memory, project } = world
    memory.writeDepartment('libu', '吏部经验：名册先行')
    memory.writeProject(project.id, '项目背景')
    memory.writeLongTerm('长期偏好')
    const withRole = memory.excerptsFor(project.id, 'libu')
    assert.equal(withRole.length, 3)
    assert.ok(withRole[0].startsWith('「部门记忆」'))
    assert.ok(withRole[1].startsWith('「项目记忆」'))
    assert.ok(withRole[2].startsWith('「长期记忆」'))
    const withoutRole = memory.excerptsFor(project.id)
    assert.equal(withoutRole.length, 2, '不给部门就没有部门层（旧行为不变）')
    const bogusRole = memory.excerptsFor(project.id, 'not-a-role')
    assert.equal(bogusRole.length, 2, '非法部门跳过部门层，不抛错')
  } finally { cleanup(world) }
})

test('service memory API: department scope roundtrip and role validation', () => {
  const world = makeWorld()
  try {
    const { service } = world
    service.putMemory({ scope: 'department', roleId: 'hubu', text: '户部全局约定' })
    assert.equal(service.getMemory({ scope: 'department', roleId: 'hubu' }).text, '户部全局约定')
    service.appendMemory({ scope: 'department', roleId: 'hubu', text: '追加一条' })
    assert.ok(service.getMemory({ scope: 'department', roleId: 'hubu' }).text.includes('追加一条'))
    assert.throws(() => service.getMemory({ scope: 'department', roleId: 'nobody' }), (e) => e.code === 'INVALID_ROLE')
    assert.throws(() => service.putMemory({ scope: 'department', text: 'x' }), (e) => e.code === 'INVALID_ROLE')
  } finally { cleanup(world) }
})

test('dispatch injects only the owner department memory', () => {
  const world = makeWorld()
  try {
    const { service, project } = world
    service.putMemory({ scope: 'department', roleId: 'libu', text: '吏部经验：先建名册' })
    service.putMemory({ scope: 'department', roleId: 'gongbu', text: '工部经验：先量尺寸' })
    const task = service.createTask({ projectId: project.id, title: '丙', objective: '丙目标', ownerRoleId: 'libu' }).task
    const dispatched = service.dispatchTask({ projectId: project.id, taskId: task.id, idempotencyKey: 'idem-mem-3' })
    const excerpts = dispatched.contextPacket.excerpts
    const dept = excerpts.find((line) => line.startsWith('「部门记忆」'))
    assert.ok(dept !== undefined && dept.includes('先建名册'), '带上主责部门自己的记忆')
    assert.ok(!excerpts.some((line) => line.includes('先量尺寸')), '别的部门的记忆不注入')
  } finally { cleanup(world) }
})

test('result report also journals into the owner department memory, once', () => {
  const world = makeWorld()
  try {
    const { service, memory, project } = world
    const task = service.createTask({ projectId: project.id, title: '丁', objective: '丁目标', ownerRoleId: 'libu' }).task
    const dispatched = service.dispatchTask({ projectId: project.id, taskId: task.id, idempotencyKey: 'idem-mem-4' })
    service.startAttempt({ projectId: project.id, taskId: task.id, attemptId: dispatched.attempt.id, hostRunId: 'run-9' })
    const input = {
      projectId: project.id,
      taskId: task.id,
      attemptId: dispatched.attempt.id,
      report: { summary: '名册已建好' },
      runTerminal: 'succeeded',
    }
    service.reportTaskResult(input)
    service.reportTaskResult(input)
    const text = memory.readDepartment('libu').text
    assert.ok(text.includes('在项目「项目一」汇报成果'), '部门记忆里带项目名，跨项目时知道出处')
    assert.ok(text.includes('名册已建好'))
    assert.equal(text.split('名册已建好').length - 1, 1, '重复汇报只记一行')
    assert.equal(memory.readDepartment('gongbu').exists, false, '没干活的部门不记账')
  } finally { cleanup(world) }
})
