#!/usr/bin/env node
// 工作台前端（workbench/panel）的安装开关：只动 profile 的 package.json、
// bundles 列表，以及 node_modules 里的一个链接。它不碰 cordis.patch.yml，
// 也不改「上朝」预设——那是 scripts/mode.mjs 的事。
//
//   node scripts/workbench-install.mjs status   # 现在装没装
//   node scripts/workbench-install.mjs on       # 装上（需要彻底重启 DSH 才生效）
//   node scripts/workbench-install.mjs off      # 卸掉
//
// 幂等：重复执行结果一致；不需要备份（版本历史由 Git 管）。

import { readFile, writeFile, mkdir, lstat, readlink, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const NAME = 'dsh-sansheng-liubu-workbench'
const REPO = resolve(import.meta.dirname, '..')
const TARGET = join(REPO, 'workbench', 'panel')
const profileDir = resolve(process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'))
const profilePath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', NAME)

/** Windows 上 `link:` 依赖写成正斜杠；反斜杠在 profile 里会被当成转义。 */
const posix = (value) => value.replace(/\\/g, '/')

async function readProfile() {
  return JSON.parse(await readFile(profilePath, 'utf8'))
}

async function writeProfile(profile) {
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

async function linkState() {
  try {
    const stat = await lstat(linkPath)
    if (!stat.isSymbolicLink()) return { linked: false, note: '不是链接（可能有同名真实目录）' }
    const actual = await readlink(linkPath)
    const resolved = resolve(profileDir, 'node_modules', actual)
    const ok = resolved.toLowerCase() === resolve(TARGET).toLowerCase()
    return { linked: ok, target: actual, note: ok ? undefined : `链接指向 ${actual}` }
  } catch (error) {
    if (error.code === 'ENOENT') return { linked: false, note: '链接不存在' }
    throw error
  }
}

async function status() {
  const profile = await readProfile()
  const link = await linkState()
  const bundles = profile.dsh?.profile?.bundles ?? []
  return {
    profile: profilePath,
    target: TARGET,
    targetExists: existsSync(join(TARGET, 'lib', 'client.js')),
    dependency: profile.dependencies?.[NAME] ?? null,
    inBundles: bundles.includes(NAME),
    link,
    installed: profile.dependencies?.[NAME] === `link:${posix(TARGET)}` && bundles.includes(NAME) && link.linked,
  }
}

async function ensureLink() {
  await mkdir(dirname(linkPath), { recursive: true })
  const state = await linkState()
  if (state.linked) return { changed: false }
  if (existsSync(linkPath) || state.note === '不是链接（可能有同名真实目录）') await rm(linkPath, { recursive: true, force: true })
  // Windows 上用 junction：不需要管理员权限，跳转由文件系统处理。
  await symlink(TARGET, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return { changed: true }
}

async function enable() {
  if (!existsSync(join(TARGET, 'lib', 'client.js'))) {
    throw new Error(`找不到 ${join(TARGET, 'lib', 'client.js')}：工作台前端还没构建出来，先别装。`)
  }
  const profile = await readProfile()
  let changed = false
  profile.dependencies ??= {}
  const wanted = `link:${posix(TARGET)}`
  if (profile.dependencies[NAME] !== wanted) {
    profile.dependencies[NAME] = wanted
    changed = true
  }
  profile.dsh ??= {}
  profile.dsh.profile ??= {}
  profile.dsh.profile.bundles ??= []
  if (!profile.dsh.profile.bundles.includes(NAME)) {
    profile.dsh.profile.bundles.push(NAME)
    changed = true
  }
  if (changed) await writeProfile(profile)
  const link = await ensureLink()
  return {
    ...(await status()),
    changed: changed || link.changed,
    hint: changed || link.changed
      ? '已装上。彻底退出并重启 DSH 后生效（客户端 bundle 在启动时加载，热更新不覆盖）。'
      : '本来就已经装好，未改动。',
  }
}

async function disable() {
  const profile = await readProfile()
  let changed = false
  if (profile.dependencies && NAME in profile.dependencies) {
    delete profile.dependencies[NAME]
    changed = true
  }
  const bundles = profile.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(NAME)) {
    profile.dsh.profile.bundles = bundles.filter((name) => name !== NAME)
    changed = true
  }
  if (changed) await writeProfile(profile)
  let unlinked = false
  try {
    await rm(linkPath, { recursive: true, force: true })
    unlinked = true
  } catch {
    /* 链接本来就不在 */
  }
  return {
    ...(await status()),
    changed: changed || unlinked,
    hint: changed || unlinked ? '已卸掉。彻底重启 DSH 后生效。' : '本来就没装，未改动。',
  }
}

const action = (process.argv[2] ?? 'status').toLowerCase()
const handlers = { status, on: enable, off: disable }
const handler = handlers[action]
if (!handler) {
  console.error(`未知动作：${action}（可用：status / on / off）`)
  process.exit(2)
}

try {
  console.log(JSON.stringify(await handler(), null, 2))
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exit(1)
}
