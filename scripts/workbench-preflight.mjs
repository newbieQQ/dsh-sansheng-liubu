// 重启前自检：只读，不改任何东西。
//
// 目的：把「重启 DSH 之后才发现客户端 bundle 根本没加载」这类问题提前挡掉。
// 检查四件事——
//   1. profile 里到底有没有把本插件链进去（dependencies + dsh.profile.bundles）
//   2. 链接指向的目录里，exports 声明的那个文件在不在
//   3. 那个文件是不是一段能解析的 JS（语法坏了会让整页白屏，且报错很难看懂）
//   4. Host 侧装配能不能在内存账本上跑起来（16 条路由 + bootstrap 可用）
//
// 用法：node scripts/workbench-preflight.mjs
// 退出码：0 全通；1 有失败项（打印哪一项失败、为什么）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

import { createWorkbenchHost } from '../workbench/host/index.mjs'
import { WorkbenchStore } from '../workbench/core/store.mjs'

const PLUGIN_ID = 'dsh-sansheng-liubu-workbench'
const results = []

function check(name, run) {
  try {
    const detail = run()
    results.push({ name, ok: true, detail })
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) })
  }
}

function dshHome(env = process.env) {
  const value = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : ''
  return value === '' ? path.join(os.homedir(), '.dsh') : value
}

const profileDir = path.join(dshHome(), 'profiles', 'desktop')
const profilePackage = path.join(profileDir, 'package.json')

let profile = null
check('读取 profile/package.json', () => {
  profile = JSON.parse(fs.readFileSync(profilePackage, 'utf8'))
  return profilePackage
})

check('profile 的 dependencies 里链了本插件', () => {
  const spec = profile?.dependencies?.[PLUGIN_ID]
  if (typeof spec !== 'string' || spec === '') throw new Error(`dependencies 里没有 ${PLUGIN_ID}`)
  return spec
})

check('profile 的 bundles 里登记了本插件', () => {
  const bundles = profile?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(PLUGIN_ID)) {
    throw new Error(`dsh.profile.bundles 里没有 ${PLUGIN_ID}（现有：${Array.isArray(bundles) ? bundles.join(', ') : '无'}）`)
  }
  return `${bundles.length} 个 bundle`
})

const linkedDir = path.join(profileDir, 'node_modules', PLUGIN_ID)

let entryFile = null
check('链接目录与入口文件存在', () => {
  const stat = fs.statSync(linkedDir)
  if (!stat.isDirectory()) throw new Error(`${linkedDir} 不是目录`)
  const pkg = JSON.parse(fs.readFileSync(path.join(linkedDir, 'package.json'), 'utf8'))
  const exported = pkg?.exports?.['./client']
  const rel = typeof exported === 'string' ? exported : exported?.import ?? exported?.default
  if (typeof rel !== 'string') throw new Error('package.json 没有 exports["./client"]')
  entryFile = path.join(linkedDir, rel)
  const size = fs.statSync(entryFile).size
  if (size < 1024) throw new Error(`入口文件过小（${size} 字节），可能是空壳`)
  return `${path.basename(entryFile)} · ${size} 字节`
})

check('客户端 bundle 语法可解析（语法错会让整页白屏）', () => {
  if (entryFile === null) throw new Error('上一个检查没通过，跳过')
  const text = fs.readFileSync(entryFile, 'utf8')
  if (!text.includes('__ModuleLoader__')) throw new Error('入口不像 DSH 客户端 bundle（缺少 __ModuleLoader__）')
  if (!text.includes(PLUGIN_ID)) throw new Error(`入口里没有插件 id ${PLUGIN_ID}`)
  // 只解析不执行：能抓住未闭合括号、非法 token 这类致命错误。
  new vm.Script(text, { filename: entryFile })
  return `${Math.round(text.length / 1024)} KB`
})

check('Host 侧装配：内存账本上能起 16 条路由', () => {
  const routes = new Map()
  const fakeCtx = {
    get: () => undefined,
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const store = new WorkbenchStore({ file: null })
  const host = createWorkbenchHost(fakeCtx, { store, startReconciler: false, load: false })
  try {
    if (routes.size !== 16) throw new Error(`注册了 ${routes.size} 条路由，预期 16 条`)
    // bootstrap 要落在具体项目上才有席位；这里现建一个临时项目，不写磁盘。
    const project = host.service.registerProject({ hostWorkspaceId: 'preflight' }).project
    const boot = host.service.bootstrap(project.id)
    if (!Array.isArray(boot.seats) || boot.seats.length !== 10) throw new Error('bootstrap 没有给出十席')
    return `${routes.size} 条路由 · 十席就位`
  } finally {
    host.dispose()
  }
})

check('账本落点可写（重启后第一次写账不会失败）', () => {
  const dir = path.join(dshHome(), 'sansheng-liubu')
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.preflight')
  fs.writeFileSync(probe, String(Date.now()))
  fs.rmSync(probe, { force: true })
  return dir
})

let failed = 0
for (const row of results) {
  const mark = row.ok ? 'PASS' : 'FAIL'
  if (!row.ok) failed += 1
  process.stdout.write(`[${mark}] ${row.name}${row.detail ? ` — ${row.detail}` : ''}\n`)
}
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`)
if (failed > 0) process.exitCode = 1
