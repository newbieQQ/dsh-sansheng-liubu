// 十席角色常量：新工作台的身份只来自可信的 (projectId, roleId) 绑定，
// 不再用 Team membership 推断，也不再让模型自报角色。
// 布局按「丞相居中在顶 → 三省一列一个 → 六部两排（吏户礼 / 兵刑工）」给出，
// UI 直接按 order 渲染稳定三列，连线的上下级由结构表达，不靠坐标猜测。

/**
 * column：布局列（lead 跨三列居中）。
 * row：视觉行号（0 丞相、1 三省、2/3 六部一排/二排）。
 * tier：leaders = 丞相与三省，ministries = 六部；分组只用于展示，不是 session 父子关系。
 */
const SEATS = [
  {
    id: 'lead',
    name: '丞相',
    short: '丞',
    tier: 'leaders',
    group: 'lead',
    column: 'span',
    row: 0,
    duty: '接需求、分流、协调、汇报',
    responsibility: '面向用户承接想法：判断是否需要开工、必要时派给具体部门，并把各部门结果汇总成对用户的一次交付。',
    canDispatch: true,
  },
  {
    id: 'zhongshu',
    name: '中书',
    short: '中',
    tier: 'leaders',
    group: 'sansheng',
    column: 'left',
    row: 1,
    duty: '调查、澄清、规划',
    responsibility: '先把问题问清、把材料看全，再给出可执行的方案与验收标准草案，不直接产出最终交付物。',
    canDispatch: false,
  },
  {
    id: 'shangshu',
    name: '尚书',
    short: '尚',
    tier: 'leaders',
    group: 'sansheng',
    column: 'center',
    row: 1,
    duty: '分工建议、组织交付',
    responsibility: '把已经明确的方案拆成部门分工并组织交付；六部直属于尚书这一同级分组，六部之间不是上下级。',
    canDispatch: true,
  },
  {
    id: 'menxia',
    name: '门下',
    short: '门',
    tier: 'leaders',
    group: 'sansheng',
    column: 'right',
    row: 1,
    duty: '审议与整体审核',
    responsibility: '对方案和交付做独立审议，指出风险与不达标处。首版没有门下审核的任务必须如实标注“未审核”。',
    canDispatch: false,
  },
  {
    id: 'libu',
    name: '吏部',
    short: '吏',
    tier: 'ministries',
    group: 'ministries',
    column: 'left',
    row: 2,
    duty: '角色和技能配置建议',
    responsibility: '对角色、技能与编制给出建议；职责不含绕过用户授权去改权限或其他项目设置。',
    canDispatch: false,
  },
  {
    id: 'hubu',
    name: '户部',
    short: '户',
    tier: 'ministries',
    group: 'ministries',
    column: 'center',
    row: 2,
    duty: '数据、表格、计算',
    responsibility: '处理数据、表格与计算，结论应可复算。',
    canDispatch: false,
  },
  {
    id: 'lipu',
    name: '礼部',
    short: '礼',
    tier: 'ministries',
    group: 'ministries',
    column: 'right',
    row: 2,
    duty: '文档、内容、呈现',
    responsibility: '负责文档、内容与呈现形式，产出可编辑的源文件。',
    canDispatch: false,
  },
  {
    id: 'bingbu',
    name: '兵部',
    short: '兵',
    tier: 'ministries',
    group: 'ministries',
    column: 'left',
    row: 3,
    duty: '环境、调试、部署',
    responsibility: '负责环境、调试与部署；部署/发布等外部副作用仍服从用户授权与宿主审批。',
    canDispatch: false,
  },
  {
    id: 'xingbu',
    name: '刑部',
    short: '刑',
    tier: 'ministries',
    group: 'ministries',
    column: 'center',
    row: 3,
    duty: '测试与风险检查',
    responsibility: '做测试与风险检查，给出可追溯的检查结果，而不是一句“已通过”。',
    canDispatch: false,
  },
  {
    id: 'gongbu',
    name: '工部',
    short: '工',
    tier: 'ministries',
    group: 'ministries',
    column: 'right',
    row: 3,
    duty: '代码实现与工程产出',
    responsibility: '负责代码实现与工程产出，交付可编辑源文件与真实检查结果。',
    canDispatch: false,
  },
]

export const ROLE_IDS = Object.freeze(SEATS.map((seat) => seat.id))

const byId = new Map(SEATS.map((seat) => [seat.id, Object.freeze(seat)]))

/** 稳定顺序（上表即布局顺序），UI 与初始化都按这个序写，避免每次渲染顺序抖动。 */
export const ROLES = Object.freeze(ROLE_IDS.map((id) => byId.get(id)))

/** 布局顺序 = 数组顺序；单独导出常量是为了让调用方不必依赖“数组被排序过”这个隐含约定。 */
export const LAYOUT_ORDER = ROLE_IDS

export const LEADERS = Object.freeze(ROLES.filter((seat) => seat.tier === 'leaders').map((seat) => seat.id))
export const MINISTRIES = Object.freeze(ROLES.filter((seat) => seat.tier === 'ministries').map((seat) => seat.id))

export function isRoleId(value) {
  return typeof value === 'string' && byId.has(value)
}

/** 未知角色返回 undefined，由调用方决定报错文案（不同入口提示不同）。 */
export function getRole(roleId) {
  return byId.get(roleId)
}

/** 找不到就抛：角色是内部常量，拼错属于代码错误而非用户输入错误。 */
export function requireRole(roleId) {
  const seat = byId.get(roleId)
  if (seat === undefined) throw new Error(`未知角色: ${String(roleId)}`)
  return seat
}

export const ROLE_NAMES = Object.freeze(Object.fromEntries(ROLES.map((seat) => [seat.id, seat.name])))

/** 存储与显示的兼容映射：旧代码用“中书省/尚书省/门下省”，roleId 不变，名称不参与身份。 */
export const ROLE_NAME_ALIASES = Object.freeze({
  zhongshu: Object.freeze(['中书省']),
  shangshu: Object.freeze(['尚书省']),
  menxia: Object.freeze(['门下省']),
})

/** 按布局把十席分成分组，供右侧部门树一次画完：top / sansheng / ministries 两排。 */
export function layoutGroups() {
  return {
    lead: ROLES.filter((seat) => seat.id === 'lead').map((seat) => seat.id),
    sansheng: ROLES.filter((seat) => seat.group === 'sansheng').map((seat) => seat.id),
    ministries: [
      ROLES.filter((seat) => seat.tier === 'ministries' && seat.row === 2).map((seat) => seat.id),
      ROLES.filter((seat) => seat.tier === 'ministries' && seat.row === 3).map((seat) => seat.id),
    ],
  }
}

/** 首版允许主动派工的席：丞相默认，尚书在用户明确要求时经同一权限校验。 */
export function canDispatch(roleId) {
  return byId.get(roleId)?.canDispatch === true
}

/** 初始化项目时用的角色清单（不创建会话，只建配置与绑定初值）。 */
export function initialSeats() {
  return ROLES.map((seat) => ({ roleId: seat.id, name: seat.name, tier: seat.tier }))
}
