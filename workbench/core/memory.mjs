// 记忆层：模仿 DS Bot 的分层记忆，但按本项目的隔离规矩落在原生账本之外。
//
// 三层：
// - 长期记忆（long-term.md）：跨项目只此一份，记用户偏好与长期有效的经验。
// - 项目记忆（projects/<projectId>.md）：一个项目一份，记这个项目发生过什么、
//   结论是什么；项目之间互不可见——DS Bot 上游「主 Bot 可读全部 Bot 记忆」的
//   弱隔离（归档分支 docs/p0 记录的 M-03 边界）不学。
// - 部门记忆（departments/<roleId>.md）：一个席位一份，跟着部门跨项目走，
//   记这个部门自己摸出的经验；派发时只注入目标部门自己那一份，
//   别的部门读不到——隔离规矩与项目记忆一致。
//
// 都是 Markdown：用户可以直接打开看、打开改。程序写入走临时文件 + rename，
// 不写半截；读取惰性（文件不存在 = 空记忆），构造时不碰磁盘，测试与预检
// 装配不会在真实侧车目录里留下东西。
//
// 记忆是参考资料，不是账本：本模块只对「形状不对」（非法项目 ID、超上限）
// 抛 MemoryError；读不到文件一律按空记忆处理，绝不让记忆拖垮业务流程。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isIdOf } from './ids.mjs'
import { isRoleId } from './roles.mjs'

/** 单个记忆文件的字符上限：记忆要短而精，写满说明该整理了。 */
export const MEMORY_FILE_MAX_CHARS = 64 * 1024

/** 派发注入时的摘录上限：交接材料是给部门开工看的，不能被记忆淹没。 */
export const MEMORY_EXCERPT_CHARS = Object.freeze({ department: 2000, project: 3000, longTerm: 2000 })

export class MemoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function requireProjectId(projectId) {
  if (!isIdOf('project', projectId)) {
    throw new MemoryError('INVALID_ID', `项目 ID 不合法：${String(projectId)}`, { field: 'projectId' })
  }
  return projectId
}

function requireRoleId(roleId) {
  if (!isRoleId(roleId)) {
    throw new MemoryError('INVALID_ID', `部门 ID 不合法：${String(roleId)}`, { field: 'roleId' })
  }
  return roleId
}

function requireMemoryText(text, field = 'text') {
  if (typeof text !== 'string') {
    throw new MemoryError('INVALID_INPUT', `${field} 必须是字符串`, { field })
  }
  if (text.length > MEMORY_FILE_MAX_CHARS) {
    throw new MemoryError('INVALID_INPUT', `记忆内容超过 ${MEMORY_FILE_MAX_CHARS} 字符上限，请先整理再写入`, { field })
  }
  return text
}

/** 原子写：先写同目录临时文件再 rename，崩溃时不会留下半截记忆。 */
function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 临时文件清不掉不影响主流程 */ }
    throw error
  }
}

function readIfExists(file) {
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

function excerptOf(label, text, cap) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.length <= cap) return `「${label}」\n${trimmed}`
  return `「${label}」\n${trimmed.slice(0, cap)}\n…（已截断，完整内容见记忆文件）`
}

/**
 * @param {object} options
 * @param {string} options.dir 记忆根目录（宿主装配时给侧车目录下的 memory/）
 * @param {() => number} [options.clock] 时间源，可注入以便测试复现
 */
export function createMemoryStore(options = {}) {
  const { dir, clock = Date.now } = options
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new MemoryError('INVALID_INPUT', 'createMemoryStore 需要 dir（记忆根目录）')
  }
  const longTermFile = join(dir, 'long-term.md')
  const projectFile = (projectId) => join(dir, 'projects', `${requireProjectId(projectId)}.md`)
  const departmentFile = (roleId) => join(dir, 'departments', `${requireRoleId(roleId)}.md`)

  const today = () => new Date(clock()).toISOString().slice(0, 10)

  function appendTo(file, title, text) {
    const entry = requireMemoryText(text, 'text')
    if (entry.trim() === '') {
      throw new MemoryError('INVALID_INPUT', 'append 的内容不能为空', { field: 'text' })
    }
    const current = readIfExists(file)
    const head = current === null || current.trim() === '' ? `# ${title}\n` : current.replace(/\s+$/, '') + '\n'
    const next = `${head}\n## ${today()}\n\n${entry.trim()}\n`
    if (next.length > MEMORY_FILE_MAX_CHARS) {
      throw new MemoryError('INVALID_INPUT', `记忆文件已达 ${MEMORY_FILE_MAX_CHARS} 字符上限，请先整理再追加`, {})
    }
    writeFileAtomic(file, next)
    return { text: next }
  }

  function writeWhole(file, text) {
    const value = requireMemoryText(text)
    writeFileAtomic(file, value)
    return { text: value }
  }

  const readLongTermFile = () => {
    const text = readIfExists(longTermFile)
    return { text: text ?? '', exists: text !== null }
  }
  const readProjectFile = (projectId) => {
    const text = readIfExists(projectFile(projectId))
    return { text: text ?? '', exists: text !== null }
  }
  const readDepartmentFile = (roleId) => {
    const text = readIfExists(departmentFile(roleId))
    return { text: text ?? '', exists: text !== null }
  }

  return Object.freeze({
    dir,
    longTermPath: longTermFile,
    projectPath: projectFile,
    departmentPath: departmentFile,

    readLongTerm: readLongTermFile,
    writeLongTerm(text) {
      return writeWhole(longTermFile, text)
    },
    appendLongTerm(text) {
      return appendTo(longTermFile, '长期记忆', text)
    },

    readProject: readProjectFile,
    writeProject(projectId, text) {
      return writeWhole(projectFile(projectId), text)
    },
    appendProject(projectId, text) {
      return appendTo(projectFile(projectId), '项目记忆', text)
    },

    readDepartment: readDepartmentFile,
    writeDepartment(roleId, text) {
      return writeWhole(departmentFile(roleId), text)
    },
    appendDepartment(roleId, text) {
      return appendTo(departmentFile(roleId), '部门记忆', text)
    },

    /**
     * 派发时用的摘录：部门记忆在前（干活的人是谁），项目记忆居中
     * （这次活的来龙去脉），长期记忆在后（不变的偏好与规矩）。
     * roleId 缺失或不合法时跳过部门层——摘录是尽力而为，绝不因此抛错。
     * 没有内容的层不产生摘录；返回纯字符串数组，直接并进上下文包的 excerpts。
     */
    excerptsFor(projectId, roleId = null) {
      const out = []
      if (isRoleId(roleId)) {
        const department = excerptOf('部门记忆', readDepartmentFile(roleId).text, MEMORY_EXCERPT_CHARS.department)
        if (department !== null) out.push(department)
      }
      const project = excerptOf('项目记忆', readProjectFile(projectId).text, MEMORY_EXCERPT_CHARS.project)
      if (project !== null) out.push(project)
      const longTerm = excerptOf('长期记忆', readLongTermFile().text, MEMORY_EXCERPT_CHARS.longTerm)
      if (longTerm !== null) out.push(longTerm)
      return out
    },
  })
}
