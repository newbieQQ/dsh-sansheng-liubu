import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LAYOUT_ORDER,
  LEADERS,
  MINISTRIES,
  ROLE_IDS,
  ROLE_NAMES,
  ROLE_NAME_ALIASES,
  ROLES,
  canDispatch,
  getRole,
  initialSeats,
  isRoleId,
  layoutGroups,
  requireRole,
} from '../core/roles.mjs'

test('ten seats keep the plan roleIds in the plan order', () => {
  assert.deepEqual([...ROLE_IDS], ['lead', 'zhongshu', 'shangshu', 'menxia', 'libu', 'hubu', 'lipu', 'bingbu', 'xingbu', 'gongbu'])
  assert.deepEqual(ROLES.map((seat) => seat.id), [...ROLE_IDS], '导出数组即布局顺序')
  assert.equal(ROLES.length, 10)
  // 吏部与礼部不可混用：名称、ID、位置都不同。
  assert.equal(ROLE_NAMES.libu, '吏部')
  assert.equal(ROLE_NAMES.lipu, '礼部')
})

test('seat names and duties match the plan table', () => {
  const expected = {
    lead: '丞相',
    zhongshu: '中书',
    shangshu: '尚书',
    menxia: '门下',
    libu: '吏部',
    hubu: '户部',
    lipu: '礼部',
    bingbu: '兵部',
    xingbu: '刑部',
    gongbu: '工部',
  }
  for (const [id, name] of Object.entries(expected)) {
    assert.equal(ROLE_NAMES[id], name)
    assert.ok(getRole(id).duty.length > 0, `${id} 有职责描述`)
    assert.ok(getRole(id).responsibility.length > 10, `${id} 有较完整职责说明`)
  }
  assert.equal(getRole('lead').duty, '接需求、分流、协调、汇报')
  assert.equal(getRole('gongbu').duty, '代码实现与工程产出')
})

test('tiers split the chancellery from the six ministries', () => {
  assert.deepEqual([...LEADERS], ['lead', 'zhongshu', 'shangshu', 'menxia'])
  assert.deepEqual([...MINISTRIES], ['libu', 'hubu', 'lipu', 'bingbu', 'xingbu', 'gongbu'])
  assert.equal(getRole('lead').tier, 'leaders')
  assert.equal(getRole('shangshu').tier, 'leaders')
  assert.equal(getRole('gongbu').tier, 'ministries')
})

test('layout is three columns with the chancellor centred on top', () => {
  assert.deepEqual(
    { row: getRole('lead').row, column: getRole('lead').column },
    { row: 0, column: 'span' },
    '丞相跨三列居中',
  )
  const sansheng = ['zhongshu', 'shangshu', 'menxia'].map((id) => getRole(id))
  assert.deepEqual(sansheng.map((seat) => seat.column), ['left', 'center', 'right'])
  assert.ok(sansheng.every((seat) => seat.row === 1))
  // 六部两排：吏户礼 / 兵刑工
  assert.deepEqual(
    ['libu', 'hubu', 'lipu'].map((id) => getRole(id).column),
    ['left', 'center', 'right'],
  )
  assert.deepEqual(
    ['bingbu', 'xingbu', 'gongbu'].map((id) => getRole(id).column),
    ['left', 'center', 'right'],
  )
  assert.ok(['libu', 'hubu', 'lipu'].every((id) => getRole(id).row === 2))
  assert.ok(['bingbu', 'xingbu', 'gongbu'].every((id) => getRole(id).row === 3))
  // 六部同属一个分组，连线不画成吏部下辖兵部。
  assert.equal(new Set(MINISTRIES.map((id) => getRole(id).group)).size, 1)
})

test('layoutGroups renders three tiers without inventing parent links', () => {
  assert.deepEqual(layoutGroups().lead, ['lead'])
  assert.deepEqual(layoutGroups().sansheng, ['zhongshu', 'shangshu', 'menxia'])
  assert.deepEqual(layoutGroups().ministries, [['libu', 'hubu', 'lipu'], ['bingbu', 'xingbu', 'gongbu']])
})

test('role lookups reject unknown ids and keep legacy name aliases', () => {
  assert.equal(isRoleId('gongbu'), true)
  assert.equal(isRoleId('xingbu'), true)
  assert.equal(isRoleId('兵部'), false)
  assert.equal(isRoleId(undefined), false)
  assert.equal(getRole('unknown'), undefined)
  assert.throws(() => requireRole('hufu'), /未知角色/)
  assert.deepEqual([...ROLE_NAME_ALIASES.zhongshu], ['中书省'])
  assert.equal(ROLE_NAME_ALIASES.libu, undefined, '吏部没有旧名别名，防止与礼部混淆')
})

test('only the chancellor and shangshu may dispatch by default', () => {
  assert.equal(canDispatch('lead'), true)
  assert.equal(canDispatch('shangshu'), true)
  for (const id of ROLE_IDS.filter((role) => role !== 'lead' && role !== 'shangshu')) {
    assert.equal(canDispatch(id), false, `${id} 不自主派工`)
  }
})

test('initial seats describe configuration rows without creating sessions', () => {
  const seats = initialSeats()
  assert.equal(seats.length, 10)
  assert.deepEqual(seats[0], { roleId: 'lead', name: '丞相', tier: 'leaders' })
  assert.deepEqual(Object.keys(seats[0]).sort(), ['name', 'roleId', 'tier'])
})

test('LAYOUT_ORDER 是按布局排序的数组，可直接给 UI 渲染', () => {
  assert.deepEqual(
    [...LAYOUT_ORDER],
    ['lead', 'zhongshu', 'shangshu', 'menxia', 'libu', 'hubu', 'lipu', 'bingbu', 'xingbu', 'gongbu'],
  )
  assert.equal(LAYOUT_ORDER.length, ROLE_IDS.length)
  // 每席的 row/column 沿数组单调排列，UI 直接按顺序铺即可
  const rows = LAYOUT_ORDER.map((id) => getRole(id).row)
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b))
})
