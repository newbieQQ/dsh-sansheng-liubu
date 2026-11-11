// 三省六部工作台 · 宿主入口。
//
// 0.11.0 起老预设线退役：不再有「上朝」模式、Team 政策插件与朝堂侧栏。
// 本入口只做一件事——在应用根上把工作台宿主拉起来（账本、HTTP 接口、
// 会话装配、记忆都在 workbench/host 里），插件卸载时把它停掉。
// 工作台宿主自身对缺失能力一律降级并给出 warnings，所以这里不预检、
// 不抛错：工作台起不来不该拖垮整个应用。
//
// 防重复启动：宿主只该有一份。若本插件被重复应用（例如旧预设段还留在
// profile 里、按会话重复挂载），后来的应用只增加引用计数，不再另起一份
// 宿主——两份宿主会重复注册路由、双写同一本账本。用 Symbol.for 注册到
// globalThis，是为了连「包被复制成两份、模块身份不同」的情况也拦得住。

import { createWorkbenchHost } from './workbench/host/index.mjs'

export const name = 'sansheng-liubu-workbench-host'

const BOOT_KEY = Symbol.for('sansheng-liubu.workbench-host')

function release(entry) {
  entry.refs -= 1
  if (entry.refs > 0) return
  if (globalThis[BOOT_KEY] === entry) delete globalThis[BOOT_KEY]
  try {
    entry.host.dispose()
  } catch {
    // 卸载失败不影响插件卸载；下次启动仍会从同一个账本继续。
  }
}

export function apply(ctx) {
  if (ctx === null || ctx === undefined) return undefined
  const existing = globalThis[BOOT_KEY]
  if (existing !== undefined) {
    existing.refs += 1
    return () => release(existing)
  }
  let host = null
  try {
    host = createWorkbenchHost(ctx?.root ?? ctx, {})
  } catch (error) {
    try {
      ctx?.logger?.info?.(`[sansheng-liubo] 工作台启动失败：${error?.message ?? error}`)
    } catch {
      // 日志失败不能影响应用启动。
    }
    return undefined
  }
  for (const warning of host.warnings ?? []) {
    try {
      ctx?.logger?.info?.(`[sansheng-liubo] ${warning}`)
    } catch {
      // 同上。
    }
  }
  const entry = { host, refs: 1 }
  globalThis[BOOT_KEY] = entry
  return () => release(entry)
}
