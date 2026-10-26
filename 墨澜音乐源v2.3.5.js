/*!
 * @name 墨澜聚合音源
 * @description 全平台支持flac，qq/wy/kw/kg/支持母带，新增汽水音乐
 * @version 2.3.5
 * @author 白姬9527(2449067834)
 * @homepage https://github.com/baiji6/molanyinyueyuan
 * @license MIT
 * @update 2026-10-26
 * @changelog
 *    1.修复QQ
      2.支持汽水音乐
      3.咪咕新增音质（LX不支持）
 * @tx_cookie null
 * @wy_cookie null
 */

const { EVENT_NAMES, request, on, send, currentScriptInfo } = globalThis.lx

// ==================== 解析头部注解 ====================

const currentScript = currentScriptInfo
  ? currentScriptInfo.rawScript
  : (typeof document !== 'undefined' ? document.currentScript?.textContent || '' : '')

const parseHeader = (str) => {
  const comment = /^\/\*!(?:.|\n)+?\*\//.exec(str)?.[0]
  if (!comment) return {}
  const result = {}
  const pairs = [
    { key: 'tx_cookie', regex: /\*\s*@tx_cookie\s+(.+)/ },
    { key: 'wy_cookie', regex: /\*\s*@wy_cookie\s+(.+)/ },
  ]
  for (const { key, regex } of pairs) {
    const match = regex.exec(comment)
    const val = match?.[1]?.trim()
    result[key] = (!val || val === 'null') ? '' : val
  }
  return result
}

const config = parseHeader(currentScript)
const TX_COOKIE = config.tx_cookie
const WY_COOKIE = config.wy_cookie
const HAS_TX_COOKIE = !!TX_COOKIE
const HAS_WY_COOKIE = !!WY_COOKIE

// ==================== 运行参数（缓存 / 限流，仿照云记） ====================

const CACHE_TTL = 1200000          // URL 缓存有效期：20 分钟
const CACHE_MAX_ENTRIES = 500      // 缓存条目上限，超出后清理过期 + 最旧记录
const RATE_LIMIT_MAX = 3           // 限流窗口内允许的最大请求数
const RATE_LIMIT_WINDOW = 1000     // 限流窗口：1 秒
const RATE_LIMIT_MAX_WAIT = 1500   // 触发限流后最长排队等待时间（超时则抛错）
const LOG_DEBUG = false            // 调试日志开关

const DEBUGLog = (...args) => {
  if (LOG_DEBUG) console.log('[墨澜-DEBUG]', ...args)
}

// ==================== 音质列表 ====================

const QUALITY_FULL = {
  // QQ 主接口已切换为云记（海堂），无需 Cookie 即可取到高音质，故不再按 Cookie 收敛音质档位
  tx: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'],
  wy: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
  kw: ['128k', '192k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
  // 咪咕主接口已切换为云记（海堂），支持无损/24bit/全景声/母带
  mg: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
  qs: ['128k', '320k', 'flac', 'spatial', 'hires'],
}

const MUSIC_QUALITY = Object.assign({}, QUALITY_FULL, {
  // 网易云仍走 ikun 接口，未配置 Cookie 时保持只开放基础音质（与原版一致）
  wy: HAS_WY_COOKIE ? QUALITY_FULL.wy : ['128k', '320k', 'flac'],
})

const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY)

// ==================== 工具函数 ====================

const isBufferLike = (obj) => obj && typeof obj === 'object' && (
  (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(obj)) ||
  (typeof obj.constructor === 'function' && obj.constructor.name === 'Buffer')
)

const parseBody = (body) => {
  if (body == null) return body
  const tryJson = (str) => {
    if (typeof str !== 'string') return str
    const trimmed = str.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed) } catch (e) {}
    }
    return str
  }
  if (typeof body === 'string') return tryJson(body)
  if (isBufferLike(body)) {
    try {
      const text = globalThis.lx?.utils?.buffer?.bufToString
        ? globalThis.lx.utils.buffer.bufToString(body, 'utf-8')
        : (typeof Buffer !== 'undefined' ? Buffer.from(body).toString('utf-8') : String(body))
      return tryJson(text)
    } catch (e) {
      return body
    }
  }
  return body
}

// 带超时保护的请求（超时逻辑仿照云记：JS 层兜底，避免后端长时间无响应）
const httpFetch = (url, options = { method: 'GET' }) => new Promise((resolve, reject) => {
  const timeout = options.timeout || 15000
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    reject(new Error('请求超时 ' + timeout + 'ms'))
  }, timeout)
  request(url, options, (err, resp) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (err) return reject(err)
    resolve({
      body: parseBody(resp.body),
      statusCode: resp.statusCode,
      headers: resp.headers || {},
    })
  })
})

// ==================== baimusic QQ 加密工具（备用后端） ====================

const _u8 = (arr) => {
  const bytes = new Uint8Array(arr.length)
  for (let i = 0; i < arr.length; i++) bytes[i] = arr[i]
  return bytes
}

const _utf8Encode = (str) => {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    }
  }
  return _u8(bytes)
}

const _base64Encode = (bytes) => {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += b64[b0 >> 2]
    out += b64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? b64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? b64[b2 & 63] : '='
  }
  return out
}

const _base64Decode = (str) => {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const map = {}
  for (let i = 0; i < b64.length; i++) map[b64[i]] = i
  str = str.replace(/=+$/, '')
  const out = []
  let buffer = 0, bits = 0
  for (let i = 0; i < str.length; i++) {
    buffer = (buffer << 6) | map[str[i]]
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return _u8(out)
}

const _hexDecode = (hex) => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

const _sha256 = (bytes) => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const l = bytes.length
  const bitLen = l * 8
  const padded = new Uint8Array(((l + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[l] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t] + w[t]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + temp1) | 0
      d = c; c = b; b = a; a = (temp1 + temp2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  const toHex = (x) => ('00000000' + (x >>> 0).toString(16)).slice(-8)
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7)
}

const _hmacSha256Hex = (key, msg) => {
  const k = key.length > 64 ? _hexDecode(_sha256(key)) : key
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) ipad[i] = 0x36
  for (let i = 0; i < 64; i++) opad[i] = 0x5c
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i] }
  const inner = new Uint8Array(ipad.length + msg.length)
  inner.set(ipad)
  inner.set(msg, ipad.length)
  const outer = new Uint8Array(opad.length + 32)
  outer.set(opad)
  outer.set(_hexDecode(_sha256(inner)), opad.length)
  return _sha256(outer)
}

// 魔改 AES SBOX
const _SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]

const _buildMagicSbox = () => {
  const s = _SBOX.slice()
  const swaps = [[0, 99], [82, 120], [160, 224], [27, 212]]
  for (const [a, b] of swaps) { const t = s[a]; s[a] = s[b]; s[b] = t }
  return s
}

const _REQ_KEY = _u8([0x4b, 0x72, 0x9a, 0xf3, 0x1d, 0x88, 0xc5, 0x07, 0xbe, 0x34, 0x61, 0xaa, 0x09, 0x55, 0xe2, 0x7c])
const _REQ_IV = _u8([0x3f, 0x91, 0x6d, 0x04, 0xba, 0x27, 0xcc, 0x58, 0x14, 0xf9, 0x8b, 0xe0, 0x72, 0x4a, 0xd6, 0x01])
const _RESP_KEY = _u8([0x9c, 0x4e, 0x71, 0xb2, 0xda, 0x38, 0x06, 0xf5, 0x83, 0xcc, 0x1a, 0x47, 0x29, 0xe8, 0x5d, 0xbf])
const _HMAC_KEY = _u8([0x5a, 0x1f, 0x8e, 0x3c, 0xb7, 0x92, 0x64, 0x0d, 0xfa, 0x48, 0x15, 0x7b, 0xe3, 0xc9, 0x2a, 0x86])

const _magicAesEncrypt = (plaintext) => {
  const bytes = _utf8Encode(plaintext)
  const padLen = 16 - (bytes.length % 16)
  const padByte = padLen ^ 90
  const padded = new Uint8Array(bytes.length + padLen)
  padded.set(bytes)
  for (let i = bytes.length; i < padded.length; i++) padded[i] = padByte
  const sbox = _buildMagicSbox()
  const key = _REQ_KEY
  const iv = _REQ_IV.slice()
  const out = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const block = new Array(16)
    for (let j = 0; j < 16; j++) block[j] = (padded[i + j] & 0xff) ^ iv[j]
    for (let j = 0; j < 16; j++) block[j] = sbox[block[j]]
    for (let j = 0; j < 16; j++) block[j] = block[j] ^ key[j]
    const shifted = new Array(16)
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        shifted[r * 4 + c] = block[r * 4 + ((c + r) % 4)]
    for (let j = 0; j < 16; j++) { out[i + j] = shifted[j]; iv[j] = shifted[j] }
  }
  return _base64Encode(out)
}

const _rc4Decrypt = (b64) => {
  const data = _base64Decode(b64)
  const key = _RESP_KEY
  const s = new Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = new Uint8Array(data.length)
  let i = 0; j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  let result = ''
  for (let ci = 0; ci < out.length;) {
    const b = out[ci]
    if (b < 0x80) { result += String.fromCharCode(b); ci++ }
    else if (b >= 0xc0 && b < 0xe0) { result += String.fromCharCode(((b & 31) << 6) | (out[ci + 1] & 63)); ci += 2 }
    else if (b >= 0xe0 && b < 0xf0) { result += String.fromCharCode(((b & 15) << 12) | ((out[ci + 1] & 63) << 6) | (out[ci + 2] & 63)); ci += 3 }
    else { const cp = ((b & 7) << 18) | ((out[ci + 1] & 63) << 12) | ((out[ci + 2] & 63) << 6) | (out[ci + 3] & 63); result += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023)); ci += 4 }
  }
  return result
}

// ==================== 酷我流媒体音质Level映射（175.27.166.236:8928 专用） ====================

const KW_STREAM_LEVEL_MAP = {
  '128k': '128k',
  '192k': '128k',
  '320k': '320k',
  flac: 'flac',
  flac24bit: 'flac',
  hires: 'hires',
  atmos: 'atmos',
  atmos_plus: 'atmos_plus',
  master: 'master',
}

// ==================== 云记（海堂）通用接口 ====================

const HTS_API_HOSTS = [
  'https://musicserver.haitangw.cc/v1/', // 云记主线路
  'https://qt.haitangw.net/v1/',         // 云记备用线路
]

const HTS_UA = 'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const genRequestId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 10; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return 'qm-muwat0on-' + suffix
}

// 云记 QQ 音质 → 海堂 level
const HTS_TX_LEVEL = {
  '128k': 'standard',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
  hires: 'hires',
  atmos: 'hires',
  atmos_plus: 'sur',
  master: 'jymaster',
}

// 云记的线路策略：主线路不可用时自动切备用线路
const htsResolveUrl = async (source, rid, level) => {
  const errors = []
  for (const host of HTS_API_HOSTS) {
    try {
      const res = await httpFetch(host + 'music/resolve-url', {
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': HTS_UA,
          'x-request-id': genRequestId(),
        },
        body: { source: source, rid: String(rid), level: level },
      })
      const d = res.body
      if (d && d.data && d.data.url) return d.data.url
      errors.push(host + ' -> ' + ((d && (d.message || d.msg)) || ('HTTP ' + res.statusCode)))
    } catch (e) {
      errors.push(host + ' -> ' + e.message)
    }
  }
  throw new Error(errors.join(' | ') || '无可用播放链接')
}

// ==================== 咪咕音质路径重写（取自云记） ====================
// 云记策略：接口固定按 standard 解析，再按面板音质改写 CDN 路径，从而拿到更高音质
const MG_PATH_DEFAULT = '标清高清/MP3_128_16_Stero'

const MG_QUALITY_PATH = {
  '128k': { dir: MG_PATH_DEFAULT, ext: '.mp3' },
  '320k': { dir: '标清高清/MP3_320_16_Stero', ext: '.mp3' },
  flac: { dir: '歌曲下载/flac', ext: '.flac' },
  flac24bit: { dir: '歌曲下载/flac_24bit', ext: '.flac' },
  hires: { dir: '歌曲下载/flac_24bit', ext: '.flac' },
  atmos: { dir: '歌曲下载/wav_3d', ext: '.wav' },
  master: { dir: '歌曲下载/wav_32bit', ext: '.wav' },
}

const rewriteMiguUrl = (rawUrl, quality) => {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl
  const target = MG_QUALITY_PATH[quality]
  if (!target) return rawUrl
  try {
    // 云记：去掉 query 再改路径（带签名 query 改路径会 404，实测必须去掉）
    let u = decodeURIComponent(rawUrl).split('?')[0]
    const before = u
    u = u.replace(MG_PATH_DEFAULT, target.dir)
    u = u.replace(/\.mp3$/, target.ext)
    if (u === before && quality !== '128k') {
      console.log('[mg] 云记咪咕: 链接未命中音质路径，返回原始链接（可能仍为 128k）')
    }
    return encodeURI(u)
  } catch (e) {
    DEBUGLog('[mg] URL 重写失败，返回原始链接', e.message)
    return rawUrl
  }
}

// 咪咕多数歌曲只有 128k/无损，直接改写 24bit/母带 路径会 404，故按档位探测可用性后再返回
const MG_QUALITY_CHAIN = {
  master: ['master', 'flac', '320k', '128k'],
  atmos: ['atmos', 'flac', '320k', '128k'],
  hires: ['hires', 'flac', '320k', '128k'],
  flac24bit: ['flac24bit', 'flac', '320k', '128k'],
  flac: ['flac', '320k', '128k'],
  '320k': ['320k', '128k'],
  '128k': ['128k'],
}

const probePlayable = async (url) => {
  try {
    const res = await httpFetch(url, {
      method: 'HEAD',
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' },
    })
    return res.statusCode >= 200 && res.statusCode < 400
  } catch (e) {
    // 探测本身失败时放行，宁可交回请求档位也不额外降级
    return true
  }
}

const resolveMiguUrl = async (rawUrl, quality) => {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl
  const chain = MG_QUALITY_CHAIN[quality] || [quality]
  let lastUrl = rawUrl
  for (let i = 0; i < chain.length; i++) {
    const url = rewriteMiguUrl(rawUrl, chain[i])
    if (!url) continue
    if (url === lastUrl && i > 0) continue          // 与上一档位结果相同，跳过重复探测
    lastUrl = url
    if (url === rawUrl) return url                  // 非咪咕 CDN，无法改写，直接返回
    if (i === chain.length - 1) return url          // 兜底档位（128k）不再探测
    if (await probePlayable(url)) return url
    DEBUGLog('[mg] 档位不可用，降级重试:', chain[i], '->', chain[i + 1])
  }
  return lastUrl
}

// ==================== QQ音乐 后端接口列表（按优先级排列） ====================

const TX_BACKENDS = [

  // === 主接口: 云记（海堂） music/resolve-url（取自云记音源，主备双线路） ===
  {
    name: '云记QQ(海堂)',
    fetch: async (songmid, quality, musicInfo) => {
      const mid = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
      if (!mid) throw new Error('云记QQ: 缺少歌曲ID')
      const level = HTS_TX_LEVEL[quality]
      if (!level) throw new Error('云记QQ: 不支持音质 ' + quality)
      return await htsResolveUrl('tx', mid, level)
    },
  },

  // === 备用接口: baimusic QQ（原主接口，降级为备用） ===
  {
    name: 'baimusic QQ',
    fetch: async (songmid, quality, musicInfo) => {
      const mid = String(musicInfo?.songmid ?? '')
      if (!mid) throw new Error('baimusic QQ: 缺少歌曲ID')
      const q = quality === 'hires' ? 'flac24bit' : quality
      const plain = JSON.stringify({ mid: mid, quality: q })
      const enc = _magicAesEncrypt(plain)
      const sig = _hmacSha256Hex(_HMAC_KEY, _utf8Encode(enc))
      const res = await httpFetch('http://106.55.0.102/baimusic/qqhoturl.php', {
        method: 'POST', timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 15; V2453A Build/AP3A.240905.015.A2_V000L1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.5 Mobile Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/octet-stream',
          'X-Sig': sig,
        },
        body: enc,
      })
      const d = res.body
      if (!d || typeof d !== 'object' || !d.d) {
        throw new Error('baimusic QQ: 响应缺少d字段' + (d?.error ? ': ' + d.error : ''))
      }
      const dec = JSON.parse(_rc4Decrypt(d.d))
      if (!dec.url) throw new Error('baimusic QQ: ' + (dec.error || '获取URL失败'))
      return dec.url
    },
  },
]

// ==================== 网易云音乐 后端接口列表（按优先级排列） ====================

const WY_BACKENDS = [

  // === 前端1: ikun音源API（c.wwwweb.top，取自ikun音源v26） ===
  { name: 'ikun网易云', fetch: async (songmid, quality, musicInfo) => {
      const songId = musicInfo?.hash ?? songmid
      const res = await httpFetch('https://c.wwwweb.top/music/url', {
        method: 'POST', timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'lx-music-request/2.9.0',
          'X-Api-Key': '',
        },
        body: { source: 'wy', musicId: songId, quality: quality },
        follow_max: 5,
      })
      const d = res.body
      if (!d || isNaN(Number(d.code))) throw new Error('ikun网易云: 未知错误')
      if (d.code === 200 && d.url) return d.url
      if (d.code === 403) throw new Error('ikun网易云: 鉴权失败')
      if (d.code === 429) throw new Error('ikun网易云: 请求过速')
      throw new Error('ikun网易云: ' + (d.message || '获取URL失败'))
    },
  },
]

// ==================== 酷我音乐(kw) 后端接口列表（按优先级排列） ====================

const KW_BACKENDS = [

  // === 后端1: 酷我流媒体直链（175.27.166.236:8928，返回二进制音频流，取自酷我流媒体音源） ===
  // 注：该服务器atmos/atmos_plus/master返回200，其他音质返回400，但URL本身即为可播放地址，无需验证
  {
    name: '酷我流媒体',
    fetch: async (songmid, quality, musicInfo) => {
      const level = KW_STREAM_LEVEL_MAP[quality] || 'master'
      const songIdTmp = musicInfo?.songmid || musicInfo?.id || musicInfo?.hash || musicInfo?.songId || musicInfo?.musicId || songmid
      if (!songIdTmp) throw new Error('酷我流媒体: 找不到歌曲ID')
      const songId = String(songIdTmp).trim()
      // 该URL返回二进制音频流，URL本身即为可播放地址，直接返回无需验证
      return 'http://175.27.166.236:8928/kwstream?id=' + encodeURIComponent(songId) + '&level=' + level + '&stream=1'
    },
  },

  // === 后端2: Hello World KW 主API（musicserver.haitangw.cc，取自Hello World 260822） ===
  {
    name: 'HelloWorld KW 主API',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.rid || musicInfo?.id || songmid
      if (!hash) throw new Error('HelloWorld KW 主API: 找不到歌曲ID')
      const levelMap = { atmos: 'atmos', atmos_plus: 'atmos_plus', master: 'master' }
      const level = levelMap[quality]
      if (!level) throw new Error('HelloWorld KW 主API: 不支持音质')
      const res = await httpFetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: { source: 'kw', rid: hash, level: level },
      })
      const d = res.body
      if (d?.data?.url) return d.data.url
      throw new Error('HelloWorld KW 主API: 无数据')
    },
  },

  // === 后端3: Hello World KW 备用API（c.wwwweb.top，取自Hello World 260822，与WY同源） ===
  {
    name: 'HelloWorld KW 备用API',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.rid || musicInfo?.id || songmid
      if (!hash) throw new Error('HelloWorld KW 备用API: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac', flac24bit: 'flac24bit', hires: 'hires' }
      const q = qMap[quality]
      if (!q) throw new Error('HelloWorld KW 备用API: 不支持音质')
      const res = await httpFetch('https://c.wwwweb.top/music/url', {
        method: 'POST', timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'lx-music-desktop/2.10.1',
          'X-Api-Key': '',
        },
        body: { source: 'kw', musicId: hash, quality: q },
        follow_max: 5,
      })
      const d = res.body
      if (!d || isNaN(Number(d.code))) throw new Error('HelloWorld KW 备用API: 未知错误')
      if (d.code === 200 && d.url) return d.url
      if (d.code === 403) throw new Error('HelloWorld KW 备用API: 鉴权失败')
      if (d.code === 429) throw new Error('HelloWorld KW 备用API: 请求过速')
      throw new Error('HelloWorld KW 备用API: ' + (d.message || '获取URL失败'))
    },
  },
]

// ==================== 酷狗音乐(kg) 后端接口列表（按优先级排列） ====================

const KG_BACKENDS = [

  // === 后端1: 海堂KG（musicserver.haitangw.cc，取自Hello World 260822，POST请求） ===
  {
    name: '海堂KG',
    fetch: async (songmid, quality, musicInfo) => {
      const hash = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!hash) throw new Error('海堂KG: 找不到歌曲ID')
      const levelMap = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', hires: 'hires', atmos: 'atmos', master: 'clear' }
      const level = levelMap[quality]
      if (!level) throw new Error('海堂KG: 不支持音质')
      const res = await httpFetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: { source: 'kg', rid: hash, level: level },
      })
      const d = res.body
      if (d?.data?.url) return d.data.url
      throw new Error('海堂KG: 无数据')
    },
  },

  // === 后端2: 白姬KG（103.79.184.97，取自Hello World 260822） ===
  {
    name: '白姬KG',
    fetch: async (songmid, quality, musicInfo) => {
      const id = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!id) throw new Error('白姬KG: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac' }
      const q = qMap[quality]
      if (!q) throw new Error('白姬KG: 不支持音质')
      const url = 'http://103.79.184.97/api/music/url?source=kg&songId={id}&quality={quality}&key=MOLAN-BAIJI'
        .replace('{id}', encodeURIComponent(id))
        .replace('{quality}', encodeURIComponent(q))
      const res = await httpFetch(url, {
        method: 'GET', timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'X-Card-Key': 'MOLAN-BAIJI' },
      })
      const d = res.body
      if (d && d.url) return d.url
      if (d && d.data && d.data.url) return d.data.url
      throw new Error('白姬KG: 无数据')
    },
  },

  // === 后端3: 星海KG（yy.zddyr.top，取自Hello World 260822） ===
  {
    name: '星海KG',
    fetch: async (songmid, quality, musicInfo) => {
      const id = musicInfo?.hash || musicInfo?.songmid || musicInfo?.id || songmid
      if (!id) throw new Error('星海KG: 找不到歌曲ID')
      const qMap = { '128k': '128k', '320k': '320k', flac: 'flac', hires: 'hires', atmos: 'atmos', master: 'master' }
      const q = qMap[quality]
      if (!q) throw new Error('星海KG: 不支持音质')
      const url = 'https://yy.zddyr.top/lx/api/?source=kg&quality={quality}&mainHash={id}'
        .replace('{id}', encodeURIComponent(id))
        .replace('{quality}', encodeURIComponent(q))
      const res = await httpFetch(url, {
        method: 'GET', timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      const d = res.body
      if (d?.url) return d.url
      throw new Error('星海KG: ' + (d?.msg || '无数据'))
    },
  },
]

// ==================== 咪咕音乐(mg) 后端接口列表（按优先级排列） ====================

const MG_BACKENDS = [

  // === 主接口: 云记（海堂）音乐接口 + 音质路径改写（取自云记音源） ===
  {
    name: '云记咪咕(海堂)',
    fetch: async (songmid, quality, musicInfo) => {
      const rid = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
      if (!rid) throw new Error('云记咪咕: 缺少歌曲ID')
      // 云记固定以 standard 解析，再按面板音质改写 CDN 路径
      const rawUrl = await htsResolveUrl('mg', rid, 'standard')
      return await resolveMiguUrl(rawUrl, quality)
    },
  },

  // === 备用1: 星海音乐源主后端（yy.zddyr.top，原主接口，降级为备用） ===
  {
    name: '星海主后端',
    fetch: async (songmid, quality) => {
      const res = await httpFetch('https://yy.zddyr.top/lx/api/?source=migu&songmid=' + songmid + '&quality=' + quality, {
        method: 'GET', timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      const d = res.body
      if (d && d.code === 200 && d.url) {
        // 星海咪咕同样只回 128k 链接，沿用云记的路径改写把音质提上去
        return await resolveMiguUrl(d.url, quality)
      }
      throw new Error('星海主后端: ' + (d?.msg || '无数据'))
    },
  },
]

// ==================== 汽水音乐(qs) 后端接口列表（取自星海音乐源） ====================

const createXinghaiQsBackend = (name, host) => ({
  name: name,
  fetch: async (songmid, quality, musicInfo) => {
    const id = String(musicInfo?.songmid || musicInfo?.id || songmid || '')
    if (!id) throw new Error(name + ': 缺少歌曲ID')
    const params = {
      source: 'qs',
      name: musicInfo?.name || '',
      singer: musicInfo?.singer || '',
      songmid: id,
      interval: musicInfo?.interval || '',
      albumName: musicInfo?.albumName || musicInfo?.album || '',
      quality: quality || '',
    }
    const query = Object.keys(params)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&')
    const res = await httpFetch('https://' + host + '/lx/api/?' + query, {
      method: 'GET', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'X-Client': 'XingHaiMusicSource' },
    })
    const d = res.body
    if (!d || Number(d.code) !== 200) {
      throw new Error(name + ': ' + ((d && d.msg) || '接口无数据'))
    }
    const data = d.data || {}
    let streamUrl = data.url || ''
    // 汽水为抖音加密流，需把 key 拼到链接上
    if (streamUrl && data.key && !/[?&]key=/.test(streamUrl)) {
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(data.key)
    }
    if (!streamUrl) streamUrl = data.source_url || ''
    if (!streamUrl) throw new Error(name + ': 未返回流媒体链接')
    return streamUrl
  },
})

const QS_BACKENDS = [
  createXinghaiQsBackend('星海汽水主线路', 'yy.zddyr.top'),
  createXinghaiQsBackend('星海汽水备用线路', 'zrcdy.dpdns.org'),
]

// ==================== URL 缓存 + 限流（仿照云记） ====================

const URL_CACHE = new Map()      // key -> { url, expire }
const INFLIGHT = new Map()       // key -> Promise，同一首歌并发请求合并
const requestTimeList = []       // 滑动窗口内的请求时间戳

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 滑动窗口限流：窗口已满时先排队等待，等待超过上限才抛错（云记策略为直接抛错，这里加了短排队提升体验）
const acquireRateSlot = async () => {
  const deadline = Date.now() + RATE_LIMIT_MAX_WAIT
  for (;;) {
    const now = Date.now()
    while (requestTimeList.length > 0 && now - requestTimeList[0] >= RATE_LIMIT_WINDOW) {
      requestTimeList.shift()
    }
    if (requestTimeList.length < RATE_LIMIT_MAX) {
      requestTimeList.push(now)
      return
    }
    const wait = RATE_LIMIT_WINDOW - (now - requestTimeList[0]) + 10
    if (Date.now() + wait > deadline) {
      throw new Error('请求过于频繁，限制' + RATE_LIMIT_MAX + '次/' + (RATE_LIMIT_WINDOW / 1000) + '秒，请稍后重试')
    }
    DEBUGLog('[限流] 窗口已满，等待', wait, 'ms')
    await sleep(wait)
  }
}

const pruneCache = () => {
  const now = Date.now()
  for (const [key, val] of URL_CACHE) {
    if (val.expire <= now) URL_CACHE.delete(key)
  }
  while (URL_CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = URL_CACHE.keys().next()
    if (oldest.done) break
    URL_CACHE.delete(oldest.value)
  }
}

const withUrlCache = async (cacheKey, loader) => {
  const now = Date.now()
  const cached = URL_CACHE.get(cacheKey)
  if (cached) {
    if (cached.expire > now) {
      DEBUGLog('[缓存命中]', cacheKey, '剩余', Math.round((cached.expire - now) / 1000) + 's')
      return cached.url
    }
    URL_CACHE.delete(cacheKey)
  }

  const pending = INFLIGHT.get(cacheKey)
  if (pending) {
    DEBUGLog('[合并请求]', cacheKey)
    return pending
  }

  const task = (async () => {
    await acquireRateSlot()          // 仅缓存未命中时占用限流额度
    const url = await loader()
    URL_CACHE.set(cacheKey, { url: url, expire: Date.now() + CACHE_TTL })
    if (URL_CACHE.size > CACHE_MAX_ENTRIES) pruneCache()
    return url
  })()

  INFLIGHT.set(cacheKey, task)
  try {
    return await task
  } finally {
    INFLIGHT.delete(cacheKey)
  }
}

// ==================== 获取音乐URL（缓存 + 限流 + 多后端轮询） ====================

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  const songId = musicInfo?.hash ?? musicInfo?.songmid ?? musicInfo?.id
  if (!songId) throw new Error('无法获取歌曲ID')

  let backends = {
    tx: TX_BACKENDS,
    wy: WY_BACKENDS,
    kw: KW_BACKENDS,
    kg: KG_BACKENDS,
    mg: MG_BACKENDS,
    qs: QS_BACKENDS,
  }[source]

  if (!backends) throw new Error('未知音源: ' + source)

  // 酷我音乐：高音质（atmos/atmos_plus/master）走流媒体直链，普通音质走星海等其他后端
  if (source === 'kw') {
    const highQuality = ['atmos', 'atmos_plus', 'master']
    if (highQuality.includes(quality)) {
      // 高音质只走酷我流媒体（索引0），不做降级
      backends = [backends[0]]
    } else {
      // 普通音质跳过酷我流媒体（索引0），走星海等其他后端
      backends = backends.filter((_, i) => i !== 0)
    }
  }

  const cacheKey = source + '-' + songId + '-' + quality

  return withUrlCache(cacheKey, async () => {
    const errors = []

    for (const backend of backends) {
      try {
        console.log('[' + source + '] 尝试后端: ' + backend.name + ' ID: ' + songId + ' 音质: ' + quality)
        const url = await backend.fetch(songId, quality, musicInfo)
        if (url) {
          console.log('[' + source + '] ' + backend.name + ' 成功')
          return url
        }
      } catch (e) {
        errors.push(backend.name + ': ' + e.message)
        console.log('[' + source + '] ' + backend.name + ' 失败: ' + e.message)
      }
    }

    throw new Error('所有后端均失败（共' + backends.length + '个）\n' + errors.join('\n'))
  })
}

// ==================== 注册请求事件 ====================

on(EVENT_NAMES.request, ({ action, source, info }) => {
  switch (action) {
    case 'musicUrl':
      return handleGetMusicUrl(source, info.musicInfo, info.type)
        .then((data) => Promise.resolve(data))
        .catch((err) => Promise.reject(err))
    default:
      return Promise.reject('action not support: ' + action)
  }
})

// ==================== 初始化音源 ====================

const musicSources = {}
MUSIC_SOURCE.forEach((item) => {
  const nameMap = {
    tx: 'QQ音乐',
    wy: '网易云音乐',
    kw: '酷我音乐',
    kg: '酷狗音乐',
    mg: '咪咕音乐',
    qs: '汽水音乐',
  }
  musicSources[item] = {
    name: nameMap[item] || item,
    type: 'music',
    actions: ['musicUrl'],
    qualitys: MUSIC_QUALITY[item],
  }
})

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: musicSources,
})

console.log('[墨澜聚合音源 v2.4.0] 已加载完成')
console.log('[QQ音乐] 后端数: ' + TX_BACKENDS.length + '（主: 云记）' + ' Cookie: ' + (HAS_TX_COOKIE ? '已配置' : '未配置'))
console.log('[网易云音乐] 后端数: ' + WY_BACKENDS.length + ' Cookie: ' + (HAS_WY_COOKIE ? '已配置' : '未配置'))
console.log('[酷我音乐] 后端数: ' + KW_BACKENDS.length)
console.log('[酷狗音乐] 后端数: ' + KG_BACKENDS.length)
console.log('[咪咕音乐] 后端数: ' + MG_BACKENDS.length + '（主: 云记）')
console.log('[汽水音乐] 后端数: ' + QS_BACKENDS.length)
console.log('[缓存/限流] 缓存 ' + (CACHE_TTL / 60000) + ' 分钟 | 限流 ' + RATE_LIMIT_MAX + ' 次/' + (RATE_LIMIT_WINDOW / 1000) + ' 秒')
