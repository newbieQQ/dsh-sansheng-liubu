// 侧车（sidecar）路径与目录：业务账、导出物都放在宿主允许的位置，不进项目目录。
// 默认 %DSH_HOME%/sansheng-liubu/；没有 DSH_HOME 时退回 ~/.dsh。
// env 可注入：测试与多实例部署用同一套函数，不读第二份全局配置。
//
// 原子写在 store 里还有一份（先写 .tmp 再 rename）；这里只给 HTTP/导出这类
// “宿主侧杂项文件”用同一套规则，避免两处对“半截文件”的处理不一致。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'

export const SIDECAR_DIR_NAME = 'sansheng-liubu'

// DSH_HOME 是 Windows 绝对路径（盘符或 UNC）时按 Windows 语义拼：在 POSIX 上
// 直接 resolve 会把 C:\… 当相对路径拼到当前目录后面。与 core/store 的
// defaultStorePath 同一条规则，两处必须一致。
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

function isWindowsAbsolute(value) {
  return typeof value === 'string' && (WINDOWS_ABSOLUTE.test(value) || value.startsWith('\\\\'))
}

function joinUnder(dir, name) {
  return isWindowsAbsolute(dir) ? win32.join(dir, name) : join(dir, name)
}

/** 侧车目录：DSH_HOME 优先，其次 ~/.dsh；相对路径按当前目录解析，不做猜测。 */
export function resolveSidecarDir(env = process.env) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (isWindowsAbsolute(raw)) return win32.join(raw, SIDECAR_DIR_NAME)
  const home = raw === '' ? join(homedir(), '.dsh') : raw
  return resolve(home, SIDECAR_DIR_NAME)
}

/**
 * 账本文件路径。DSH_SANSHENG_WORKBENCH_FILE 可整体改写（用于独立测试实例）；
 * 它必须指向具体文件名，不能只是目录，否则会在目录名上写半截 JSON。
 */
export function resolveStorePath(env = process.env) {
  const override = env && typeof env.DSH_SANSHENG_WORKBENCH_FILE === 'string'
    ? env.DSH_SANSHENG_WORKBENCH_FILE.trim()
    : ''
  if (override !== '') return isWindowsAbsolute(override) ? win32.normalize(override) : resolve(override)
  return joinUnder(resolveSidecarDir(env), 'workbench.json')
}

/** 派生路径：同一侧车目录下按用途分开，便于用户自己备份或清理而不碰账本。 */
export function resolveSidecarFile(name, env = process.env) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('name 必须是非空字符串')
  if (name.includes('/') || name.includes('\\')) throw new Error('name 只能是一级文件名，不能带目录分隔符')
  return joinUnder(resolveSidecarDir(env), name)
}

/** 目录级入口：所有写入前都先建目录，缺目录不该表现为“保存失败”。 */
export function ensureSidecarDir(env = process.env) {
  const dir = resolveSidecarDir(env)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 损坏文件的改名后缀：.corrupt-<时间戳>，保留现场且不覆盖下一次的结果。 */
export function corruptPathFor(file, stamp = Date.now()) {
  return `${file}.corrupt-${stamp}`
}

/**
 * 把可能损坏的文件挪到一边：返回新路径；文件不存在返回 null（不算错误）。
 * 只改名不删除——损坏的账本里可能有用户唯一的业务记录，删掉就等于替用户做了决定。
 */
export function quarantineFile(file, stamp = Date.now()) {
  if (!existsSync(file)) return null
  let target = corruptPathFor(file, stamp)
  let attempt = 1
  while (existsSync(target)) {
    target = `${corruptPathFor(file, stamp)}-${attempt}`
    attempt += 1
  }
  renameSync(file, target)
  return target
}

/**
 * 原子写文本：同目录 .tmp → rename。
 * Windows 上覆盖 rename 可能因杀软/索引占用失败，退化成“删旧再改名”；
 * 最坏情况是目标短暂缺失，而不是留下半截内容。
 */
export function writeFileAtomic(file, text) {
  const target = resolve(file)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, String(text), 'utf8')
    try {
      renameSync(tmp, target)
    } catch {
      rmSync(target, { force: true })
      renameSync(tmp, target)
    }
  } finally {
    rmSync(tmp, { force: true })
  }
  return target
}

/**
 * 原子写 JSON：两空格缩进加尾换行，适合人读与 git diff。
 * 不能序列化的值（BigInt、循环引用）直接抛错，不写一份“看起来写成了”的内容。
 */
export function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  return writeFileAtomic(file, text)
}

/** 读 JSON；文件不存在或解析失败都返回 fallback，让调用方决定是否报错。 */
export function readJsonSafe(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 文件是否可读且非空；用于“成果文件已被删除”这类检查，不做内容解析。 */
export function fileLooksUsable(file) {
  try {
    const info = statSync(file)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}
