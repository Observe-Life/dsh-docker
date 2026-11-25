/** 登录插件路由行为测试（红=现状缺陷；绿=修复后全过）。
 *  用 mock 的 webServer/credentials 驱动插件 apply()，抓到 /login 的 handler 逐场景断言。
 *  测试密钥为脚本内生成的假密钥，签发与验证闭环使用，不接触真实凭据库。 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

// 插件路径：构建期默认 /opt/dsh-login/plugin/index.js（镜像内位置）；本机运行用 PLUGIN_PATH 环境变量指定
const PLUGIN = process.env.PLUGIN_PATH || '/opt/dsh-login/plugin/index.js'
const mod = await import('file://' + PLUGIN)

const SECRET = Buffer.alloc(32); SECRET.write('dsh-login-test-secret', 'utf8') // 测试专用 32 字节密钥
const DAY = 24 * 60 * 60 * 1000
const HOST = '192.168.31.115:3080'
const AUTHORITY = `https://${HOST}`

function b64url(buf) { return Buffer.from(buf).toString('base64url') }
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
function signCookie(issuedAt, expiresAt) {
  const payload = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt }), 'utf8'))
  const sig = createHmac('sha256', SECRET).update(payload).digest()
  return `v1.${payload}.${b64url(sig)}`
}
const validCookie = `${cookieName}=${signCookie(Date.now(), Date.now() + 30 * DAY)}`
const tamperedCookie = validCookie.slice(0, -4) + 'AAAA'
const expiredCookie = `${cookieName}=${signCookie(Date.now() - 40 * DAY, Date.now() - 10 * DAY)}`

// ---- 驱动插件 apply，抓取 /login 路由 handler ----
const captured = []
let credCalls = 0
const cred = {
  modifyRecord: async (_key, fn) => {
    credCalls++
    const rec = { kind: 'grant', payload: { version: 1, secret: Buffer.from(SECRET).toString('base64url') } }
    const out = await fn(rec)
    return out === undefined ? rec : out
  },
}
const webCtx = { effect: (fn) => fn(), webServer: { protocol: 'https:', register: (r) => captured.push(r) } }
await mod.apply({ inject: (_s, fn) => fn(webCtx), credentials: cred }, { authUser: 'u1', authPass: 'p1' })
const handler = captured[0].handler
assert.ok(handler, '未抓到 /login 路由')

// ---- 请求/响应模拟 ----
function makeRes() {
  const r = { code: undefined, headers: {}, body: '' }
  r.writeHead = (code, headers) => { r.code = code; Object.assign(r.headers, headers) }
  r.end = (b) => { r.body = b ?? '' }
  return r
}
async function run(method, headers, body) {
  const chunks = body ? [Buffer.from(body)] : []
  const req = { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  const res = makeRes()
  await handler(req, res)
  return res
}

let passed = 0, failed = 0
const fails = []
function check(label, fn) {
  try { fn(); passed++; console.log('  ✓ ' + label) }
  catch (e) { failed++; fails.push(`${label}: ${e.message}`); console.log('  ✗ ' + label) }
}

console.log('[GET /login 行为]')
{
  const callsBefore = credCalls
  const r = await run('GET', { host: HOST })
  check('无 Cookie：200 出登录页', () => assert.equal(r.code, 200))
  check('无 Cookie 不触碰凭据库（早退契约锁定）', () => assert.equal(credCalls, callsBefore))
}
{
  const callsBefore = credCalls
  const r = await run('GET', { host: HOST, cookie: 'sessionid=abc123; theme=dark' })
  check('有 Cookie 但无本插件前缀：200 出登录页', () => assert.equal(r.code, 200))
  check('无前缀 Cookie 不触碰凭据库（早退契约另一半）', () => assert.equal(credCalls, callsBefore))
}
{
  const r = await run('GET', { host: HOST, cookie: validCookie })
  check('有效 Cookie：302 弹回主页（修复点①）', () => {
    assert.equal(r.code, 302)
    assert.equal(r.headers.location, '/')
  })
}
{
  const r = await run('GET', { host: HOST, cookie: tamperedCookie })
  check('篡改签名的 Cookie：200 出登录页（不放行）', () => assert.equal(r.code, 200))
}
{
  const r = await run('GET', { host: HOST, cookie: expiredCookie })
  check('过期 Cookie：200 出登录页（不放行）', () => assert.equal(r.code, 200))
}
{
  // 密钥不可用（凭据库异常）时必须降级出登录页，不得 500 或放行
  const badCred = { modifyRecord: async () => { throw new Error('credential store unavailable') } }
  const captured2 = []
  const webCtx2 = { effect: (fn) => fn(), webServer: { protocol: 'https:', register: (r) => captured2.push(r) } }
  await mod.apply({ inject: (_s, fn) => fn(webCtx2), credentials: badCred }, { authUser: 'u1', authPass: 'p1' })
  const chunks = []
  const req = { method: 'GET', headers: { host: HOST, cookie: validCookie }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  const res = makeRes()
  await captured2[0].handler(req, res)
  check('签名密钥不可用：降级 200 出登录页（不 500 不放行）', () => assert.equal(res.code, 200))
}
{
  // Host 与签发 authority 不一致（跨域复制来的 Cookie）不得 302 放行
  const otherAuthority = 'https://other-host.example:9999'
  const otherName = 'dsh-auth-' + b64url(createHash('sha256').update(otherAuthority).digest())
  const payload = b64url(Buffer.from(JSON.stringify({ version: 1, authority: otherAuthority, issuedAt: Date.now(), expiresAt: Date.now() + 30 * DAY }), 'utf8'))
  const foreignCookie = `${otherName}=v1.${payload}.${b64url(createHmac('sha256', SECRET).update(payload).digest())}`
  const r = await run('GET', { host: HOST, cookie: foreignCookie })
  check('跨域 Cookie（authority 不一致）：200 出登录页（不放行）', () => assert.equal(r.code, 200))
}
{
  const r = await run('GET', { host: HOST })
  check('登录页含无痕跳转脚本（修复点②：location.replace）', () =>
    assert.ok(r.body.includes('location.replace'), '登录页应改为后台提交+原地替换跳转'))
}

console.log('[POST /login 行为]')
{
  const r = await run('POST', { host: HOST }, 'user=u1&pass=p1')
  check('正确凭据：303 回主页并签发 Cookie', () => {
    assert.equal(r.code, 303)
    assert.ok((r.headers['set-cookie'] ?? '').includes('v1.'))
  })
}
{
  // 编码契约（评审阻断项回归）：浏览器 fetch+URLSearchParams 发的是 urlencoded——服务器必须解析成功；
  // 若误用 FormData，fetch 会发 multipart，服务器解析不到凭据字段而 401。此用例锁定两种形状的分歧。
  const multipartLike = '--dshTestBoundary\r\nContent-Disposition: form-data; name="user"\r\n\r\nu1\r\n'
    + '--dshTestBoundary\r\nContent-Disposition: form-data; name="pass"\r\n\r\np1\r\n'
    + '--dshTestBoundary--\r\n'
  const rMultipart = await run('POST', { host: HOST, 'content-type': 'multipart/form-data; boundary=dshTestBoundary' }, multipartLike)
  check('multipart 形状凭据（标准 wire 形状）：401 拒绝（编码契约锁定）', () => assert.equal(rMultipart.code, 401))
  const urlencoded = new URLSearchParams({ user: 'u1', pass: 'p1' }).toString()
  const rUrl = await run('POST', { host: HOST }, urlencoded)
  check('urlencoded 形状（fetch+URLSearchParams 实际形状）：303 签发', () => assert.equal(rUrl.code, 303))
}
{
  // Cookie 名为本域、签名有效，但载荷里的 authority 是别的域：必须拒绝（防跨域重放）
  const foreignPayload = b64url(Buffer.from(JSON.stringify({ version: 1, authority: 'https://other-host.example:9999', issuedAt: Date.now(), expiresAt: Date.now() + 30 * DAY }), 'utf8'))
  const forgedCookie = `${cookieName}=v1.${foreignPayload}.${b64url(createHmac('sha256', SECRET).update(foreignPayload).digest())}`
  const r = await run('GET', { host: HOST, cookie: forgedCookie })
  check('签名有效但 authority 不匹配：200 出登录页（不放行）', () => assert.equal(r.code, 200))
}
{
  const r = await run('POST', { host: HOST }, 'user=u1&pass=wrong')
  check('错误凭据：401 出错误提示页', () => {
    assert.equal(r.code, 401)
    assert.ok(r.body.includes('不正确'))
  })
}

console.log(`\n结果：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
