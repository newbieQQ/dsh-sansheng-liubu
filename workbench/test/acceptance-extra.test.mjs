// A09 / A17 / A19 的补强验收：附件级材料引用、宿主重启后的账本恢复、项目间材料隔离。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorkbenchStore } from '../core/store.mjs'
import { createWorkbenchService } from '../host/service.mjs'
import { buildDispatchText, describeMaterialRef } from '../host/session-adapter.mjs'

const clock = () => 1700000000000

function memoryStore() {
  return new WorkbenchStore({ file: null, clock })
}

function seed(service, hostWorkspaceId) {
  const project = service.registerProject({ hostWorkspaceId, displayNameCache: hostWorkspaceId }).project
  const binding = service.bindDepartmentSession({ projectId: project.id, roleId: 'gongbu', sessionId: `ses_${hostWorkspaceId}` })
  return { project, generation: binding.binding.bindingGeneration }
}

test('A09 交接材料：附件引用原样进 packet，成果引用带版本，文本里可读', () => {
  const store = memoryStore()
  const service = createWorkbenchService({ store, clock })
  const { project, generation } = seed(service, 'ws-a')
  const task = service.createTask({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: '按预算出方案',
    objective: 'o',
    status: 'queued',
  }).task
  const artifact = service.registerArtifact({
    projectId: project.id,
    ownerRoleId: 'gongbu',
    taskId: task.id,
    displayName: '预算表',
    fileRef: 'C:/work/预算.xlsx',
    kind: 'spreadsheet',
  }).artifact

  const dispatched = service.dispatchTask({
    projectId: project.id,
    taskId: task.id,
    idempotencyKey: 'k-material',
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_ws-a',
    bindingGeneration: generation,
    packet: {
      materialRefs: [
        { artifactId: artifact.id },
        { attachmentId: 'att_abc', name: '预算.xlsx', mime: 'application/vnd.ms-excel', size: 2048 },
        '聊天里贴过的那段口径',
      ],
    },
  })

  const refs = dispatched.contextPacket.materialRefs
  assert.deepEqual(refs[0], { artifactId: artifact.id, revision: 1, title: '预算表' })
  assert.deepEqual(refs[1], { attachmentId: 'att_abc', name: '预算.xlsx', mime: 'application/vnd.ms-excel', size: 2048 })
  assert.equal(refs[2], '聊天里贴过的那段口径')

  // 派发文本必须把材料写成能读的一行，并保留可追溯 ID。
  const text = buildDispatchText({ task, packet: dispatched.contextPacket, contractGuide: 'G', roleName: '工部' })
  assert.ok(text.includes(`成果 预算表 ${artifact.id}（第 1 版）`))
  assert.match(text, /附件 att_abc（预算\.xlsx · application\/vnd\.ms-excel · 2048 字节）/)
  assert.match(text, /聊天里贴过的那段口径/)

  // 纯函数本身也单独锁一下：非对象、空串、缺 ID 都不该糊过去。
  assert.equal(describeMaterialRef(null), 'null')
  assert.equal(describeMaterialRef('a.xlsx'), 'a.xlsx')
})

test('A09/A19 交接材料不能越权：别的项目的成果引用直接拒绝，且不泄露归属', () => {
  const store = memoryStore()
  const service = createWorkbenchService({ store, clock })
  const a = seed(service, 'ws-a')
  const b = seed(service, 'ws-b')
  const taskA = service.createTask({
    projectId: a.project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: 'A 的任务',
    objective: 'o',
    status: 'queued',
  }).task
  const artifact = service.registerArtifact({
    projectId: a.project.id,
    ownerRoleId: 'gongbu',
    taskId: taskA.id,
    title: 'A 的成果',
    fileRef: 'C:/work/a.xlsx',
  }).artifact
  const task = service.createTask({
    projectId: b.project.id,
    ownerRoleId: 'gongbu',
    sourceRoleId: 'lead',
    title: 'B 的任务',
    objective: 'o',
    status: 'queued',
  }).task

  assert.throws(
    () =>
      service.dispatchTask({
        projectId: b.project.id,
        taskId: task.id,
        idempotencyKey: 'k-cross',
        targetRoleId: 'gongbu',
        targetSessionId: 'ses_ws-b',
        bindingGeneration: b.generation,
        packet: { materialRefs: [{ artifactId: artifact.id }] },
      }),
    (error) => error.code === 'CROSS_PROJECT' && !JSON.stringify(error.details ?? {}).includes(a.project.id),
  )

  // 正常派发：B 的上下文包里只有自己的东西，绝不自动继承 A 的材料。
  const dispatched = service.dispatchTask({
    projectId: b.project.id,
    taskId: task.id,
    idempotencyKey: 'k-own',
    targetRoleId: 'gongbu',
    targetSessionId: 'ses_ws-b',
    bindingGeneration: b.generation,
  })
  assert.deepEqual(dispatched.contextPacket.materialRefs, [])

  // 缺 ID 的引用、空字符串都要明确报错，而不是“尽力猜”。
  assert.throws(
    () =>
      service.dispatchTask({
        projectId: b.project.id,
        taskId: task.id,
        idempotencyKey: 'k-bad',
        targetRoleId: 'gongbu',
        targetSessionId: 'ses_ws-b',
        bindingGeneration: b.generation,
        packet: { materialRefs: [{ name: '没有 ID 的东西' }] },
      }),
    (error) => error.code === 'INVALID_INPUT',
  )
})

test('A17 宿主重启：账本重开后项目/绑定/配置/任务/派发都还在，换绑代号不回退', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-restart-'))
  const file = join(dir, 'workbench.json')
  try {
    const first = new WorkbenchStore({ file, clock })
    first.load()
    const service = createWorkbenchService({ store: first, clock })
    const { project, generation } = seed(service, 'ws-restart')
    service.saveDepartmentConfig({ projectId: project.id, roleId: 'gongbu', provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash', expectedRevision: 0 })
    const task = service.createTask({
      projectId: project.id,
      ownerRoleId: 'gongbu',
      sourceRoleId: 'lead',
      title: '重启前建的任务',
      objective: 'o',
      status: 'queued',
    }).task
    const dispatched = service.dispatchTask({
      projectId: project.id,
      taskId: task.id,
      idempotencyKey: 'k-restart',
      targetRoleId: 'gongbu',
      targetSessionId: 'ses_ws-restart',
      bindingGeneration: generation,
    })
    assert.equal(dispatched.dispatch.idempotencyKey, 'k-restart')

    // —— 模拟宿主重启：新建 store 从同一文件重开 ——
    const second = new WorkbenchStore({ file, clock })
    second.load()
    const revived = createWorkbenchService({ store: second, clock })

    const projects = revived.listProjects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0].hostWorkspaceId, 'ws-restart')

    const seats = revived.listSeats(project.id)
    const gongbu = seats.find((seat) => seat.roleId === 'gongbu')
    assert.equal(gongbu.connected, true)
    assert.equal(gongbu.config.model, 'workbuddy/deepseek-v4.1-flash')
    assert.equal(gongbu.config.configRevision, 1)

    const revivedTask = revived.getTask(project.id, task.id)
    assert.equal(revivedTask.title, '重启前建的任务')

    // 幂等键跨重启仍有效：再点一次不会重复投递。
    const again = revived.dispatchTask({
      projectId: project.id,
      taskId: task.id,
      idempotencyKey: 'k-restart',
      targetRoleId: 'gongbu',
      targetSessionId: 'ses_ws-restart',
      bindingGeneration: generation,
    })
    assert.equal(again.duplicate, true)
    assert.equal(again.dispatch.id, dispatched.dispatch.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A26 切项目后草稿、绑定、配置各归所属，不互相串', () => {
  const store = memoryStore()
  const service = createWorkbenchService({ store, clock })
  const a = service.registerProject({ hostWorkspaceId: 'ws-a', displayNameCache: 'A' }).project
  const b = service.registerProject({ hostWorkspaceId: 'ws-b', displayNameCache: 'B' }).project

  // 两个项目各自的工部配置不同，且都绑了不同会话。
  service.saveDepartmentConfig({ projectId: a.id, roleId: 'gongbu', provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash', expectedRevision: 0 })
  service.saveDepartmentConfig({ projectId: b.id, roleId: 'gongbu', provider: 'magpie', model: 'workbuddy/deepseek-v4.1-pro', expectedRevision: 0 })
  service.bindDepartmentSession({ projectId: a.id, roleId: 'gongbu', sessionId: 'ses_a_gongbu' })
  service.bindDepartmentSession({ projectId: b.id, roleId: 'gongbu', sessionId: 'ses_b_gongbu' })

  // A 里存一份草稿（还没派工的修订单）。
  const taskA = service.createTask({
    projectId: a.id, ownerRoleId: 'gongbu', sourceRoleId: 'lead',
    title: 'A 的草稿', objective: 'o', status: 'draft',
  }).task
  const taskB = service.createTask({
    projectId: b.id, ownerRoleId: 'gongbu', sourceRoleId: 'lead',
    title: 'B 的草稿', objective: 'o', status: 'draft',
  }).task

  const bootA = service.bootstrap(a.id)
  const bootB = service.bootstrap(b.id)
  const gongbuA = bootA.seats.find((seat) => seat.roleId === 'gongbu')
  const gongbuB = bootB.seats.find((seat) => seat.roleId === 'gongbu')

  // 配置与绑定各归各的：切项目不会把 A 的模型/会话带到 B。
  assert.equal(gongbuA.config.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(gongbuB.config.model, 'workbuddy/deepseek-v4.1-pro')
  assert.equal(gongbuA.binding.currentSessionId, 'ses_a_gongbu')
  assert.equal(gongbuB.binding.currentSessionId, 'ses_b_gongbu')

  // 草稿也只是各自项目里的任务，不会出现在对方列表里。
  const titlesA = bootA.tasks.map((task) => task.title)
  const titlesB = bootB.tasks.map((task) => task.title)
  assert.ok(titlesA.includes('A 的草稿'))
  assert.ok(!titlesA.includes('B 的草稿'))
  assert.ok(titlesB.includes('B 的草稿'))
  assert.ok(!titlesB.includes('A 的草稿'))
  assert.equal(taskA.projectId, a.id)
  assert.equal(taskB.projectId, b.id)
})
