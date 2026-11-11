// 前端与 Host 的接线契约：路径前缀、端点名、方法。
//
// 这一条是为"重启后才暴露"的那类错误准备的：如果 panel 里写的是 /sansheng/workbench、
// 而 Host 改了 ROUTE_PREFIX，真实宿主里所有请求都会 404，界面看起来就是"一直在读、什么都不出来"。
// 单测跑得比重启快，所以把这条约束钉在测试里。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ROUTE_PREFIX, listWorkbenchRoutes } from '../host/routes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, '..', 'panel', 'lib', 'client.js')

function readClient() {
  return readFileSync(clientFile, 'utf8')
}

/** 从 apiGet("x") / apiPost("x") 里取出前端真正会请求的端点名。 */
function clientEndpoints(source) {
  const names = new Set()
  const pattern = /api(?:Get|Post)\(\s*"([^"]+)"/g
  let match = pattern.exec(source)
  while (match !== null) {
    names.add(match[1])
    match = pattern.exec(source)
  }
  return [...names].sort()
}

test('panel 的 API_BASE 与 Host 的 ROUTE_PREFIX 完全一致', () => {
  const source = readClient()
  const match = /const\s+API_BASE\s*=\s*"([^"]+)"/.exec(source)
  assert.ok(match, 'panel 里找不到 API_BASE 声明')
  assert.equal(match[1], ROUTE_PREFIX, '两边前缀不一致，真实宿主里会全体 404')
})

test('panel 请求的每个端点，Host 都真的注册了', () => {
  const routes = listWorkbenchRoutes()
  const known = new Set(routes.map((route) => route.path.slice(ROUTE_PREFIX.length + 1)))
  const requested = clientEndpoints(readClient())

  assert.ok(requested.length >= 5, `只解析到 ${requested.length} 个端点，说明提取规则失效了`)
  const missing = requested.filter((name) => !known.has(name))
  assert.deepEqual(missing, [], `panel 请求了 Host 没有的端点：${missing.join(', ')}`)
})

test('前端会改状态的端点都是 POST，读取类都是 GET', () => {
  const source = readClient()
  const byMethod = new Map(listWorkbenchRoutes().map((route) => [route.path.slice(ROUTE_PREFIX.length + 1), route.method]))

  const postPattern = /apiPost\(\s*"([^"]+)"/g
  let match = postPattern.exec(source)
  while (match !== null) {
    assert.equal(byMethod.get(match[1]), 'POST', `apiPost 打了 ${match[1]}，但 Host 上它不是 POST`)
    match = postPattern.exec(source)
  }

  const getPattern = /apiGet\(\s*"([^"]+)"/g
  match = getPattern.exec(source)
  while (match !== null) {
    assert.equal(byMethod.get(match[1]), 'GET', `apiGet 打了 ${match[1]}，但 Host 上它不是 GET`)
    match = getPattern.exec(source)
  }
})
