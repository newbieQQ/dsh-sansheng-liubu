// 稳定随机 ID：所有业务主键都由这里生成，名称/路径只作属性，不复用为键。
// 随机源可注入，测试里给定字符表就能复现同一串 ID，避免断言依赖运气。

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 方案里出现的所有前缀；拼错前缀属于开发期错误，直接抛而不是静默接受。 */
export const ID_PREFIXES = Object.freeze({
  project: 'proj',
  binding: 'bind',
  config: 'cfg',
  task: 'task',
  dispatch: 'dsp',
  attempt: 'att',
  contextPacket: 'ctx',
  result: 'res',
  artifact: 'art',
  event: 'evt',
  authorization: 'auth',
})

export const ID_ENTITIES = Object.freeze(Object.keys(ID_PREFIXES))

/** 默认随机源：crypto.getRandomValues，取 0..35 的字符。 */
export function cryptoRandom() {
  const crypto = globalThis.crypto
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('缺少可用的随机源，请注入 random 参数')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  // 除 36 取余有轻微偏差，但只用于 ID 唯一性，不用于安全令牌。
  return ALPHABET[bytes[0] % ALPHABET.length]
}

/**
 * 注入的随机源可以返回数字（映射到字母表）或单个字符（必须来自字母表）。
 * 两种都接受是为了测试能写 `() => 0` 这样最直白的桩。
 */
function pick(random, index) {
  const value = random(index)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('随机源必须返回整数或字母表内字符')
    // 随机源常被测试当作递增计数器使用，数值可能超过字母表长度甚至为负；
    // 先取绝对整数再取模，保证任意整数都能映射到合法字符。
    return ALPHABET[Math.abs(value) % 36]
  }
  const char = String(value)
  if (char.length !== 1 || !ALPHABET.includes(char)) throw new Error(`随机源返回了字母表外字符: ${char}`)
  return char
}

/**
 * 生成 `<prefix>_<随机串>`。
 * 前缀既可用实体名（'task'）也可用前缀本身（'task'），两者一致时可省心。
 */
export function newId(prefix, options = {}) {
  const { random = cryptoRandom, length = 12 } = options
  const known = ID_PREFIXES[prefix]
  const resolved = known ?? (Object.values(ID_PREFIXES).includes(prefix) ? prefix : undefined)
  if (resolved === undefined) throw new Error(`未知 ID 前缀: ${prefix}`)
  if (!Number.isInteger(length) || length < 4 || length > 64) throw new Error('ID 随机串长度须为 4..64')
  let out = ''
  for (let index = 0; index < length; index += 1) out += pick(random, index)
  return `${resolved}_${out}`
}

/** 每个实体一个绑定好随机源的生成器，便于在服务层统一注入并保持测试确定性。 */
export function createIdFactory(options = {}) {
  const { random = cryptoRandom, length = 12 } = options
  const factory = {}
  for (const entity of ID_ENTITIES) {
    factory[entity] = () => newId(ID_PREFIXES[entity], { random, length })
  }
  return Object.freeze(factory)
}

/** 校验外部传入的 ID 形状（防伪 ID 进账；存在性仍由 store 查表）。 */
export function isIdOf(entity, value) {
  const prefix = ID_PREFIXES[entity]
  if (typeof value !== 'string' || typeof prefix !== 'string') return false
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1
}
