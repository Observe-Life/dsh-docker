/** 登录页插件（rc.5 适配版 v3）：
 *  - 注册官方匿名路由 /login：GET 出登录页，POST 校验账号密码并签发官方协议浏览器 Cookie。
 *  - 未登录访问首页由连接插件的小补丁跳转到 /login（补丁只改 4 行，不动准入逻辑）。 */
import z from '@deepseek-ai/schemastery'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Stable plugin name. */
export const name = 'host-authentication-login'
/** Services used: web server routes + persistent cookie signing secret. */
export const inject = ['webServer', 'credentials']

const LOGIN_PATH = '/login'
const COOKIE_PREFIX = 'dsh-auth-'
const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32

const LOGIN_PAGE_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #f3f5f9; color: #1c2333;
}
.card {
  width: 340px; max-width: 92vw; background: #fff; border-radius: 14px;
  padding: 36px 30px; box-shadow: 0 10px 40px rgba(30, 40, 70, .12);
}
h1 { font-size: 19px; font-weight: 600; text-align: center; margin-bottom: 6px; }
p.sub { font-size: 12.5px; color: #8a93a6; text-align: center; margin-bottom: 26px; }
label { display: block; font-size: 12.5px; color: #5b6472; margin: 14px 0 6px; }
input {
  width: 100%; padding: 11px 12px; font-size: 14px; border: 1px solid #d5dbe6;
  border-radius: 8px; outline: none; transition: border-color .15s;
}
input:focus { border-color: #4c6fff; }
button {
  width: 100%; margin-top: 24px; padding: 11px; font-size: 14.5px; font-weight: 600;
  color: #fff; background: #4c6fff; border: 0; border-radius: 8px; cursor: pointer;
}
button:hover { background: #3d5ef2; }
p.err { font-size: 12.5px; color: #d84040; text-align: center; margin-top: 14px; }
`

function loginPage(wrong) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness 登录</title>
<style>${LOGIN_PAGE_STYLE}</style>
</head>
<body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p class="sub">请登录以继续访问智能体面板</p>
  <form method="post" action="${LOGIN_PATH}">
    <label for="user">账号</label>
    <input id="user" name="user" autocomplete="username" required autofocus>
    <label for="pass">密码</label>
    <input id="pass" name="pass" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
  </form>
  ${wrong ? '<p class="err">账号或密码不正确，请重试</p>' : ''}
</div>
</body>
</html>`
}

/** 恒定时间字符串比较（评审建议 1）。 */
function timingSafeStringEqual(actual, expected) {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

/** 读取请求体，上限 64KB（评审建议 3），超限返回 undefined。 */
async function readBody(request, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) return undefined
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Validate config schema. */
export const Config = z.object({
  authUser: z.string(),
  authPass: z.string(),
})

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function requestAudience(headers, secure) {
  const host = headers instanceof Headers ? headers.get('host') ?? undefined
    : typeof headers.host === 'string' ? headers.host : undefined
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the official browser-session signing secret without modifying it. */
async function readSigningSecret(credentials) {
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current === undefined) {
      throw new Error('host-authentication-login: browser-session credential record missing')
    }
    return undefined
  })
  if (record === undefined || record.kind !== 'grant' || typeof record.payload !== 'object'
    || record.payload === null || record.payload.version !== 1
    || typeof record.payload.secret !== 'string') {
    throw new Error('host-authentication-login: browser-session credential record unsupported')
  }
  const secret = Buffer.from(record.payload.secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  return secret.byteLength === SECRET_BYTES ? secret : undefined
}

/**
 * Mount the /login routes on the Web server.
 * @param ctx - plugin scope.
 * @param config - login account and password.
 */
export async function apply(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    let active = true
    webCtx.effect(() => () => { active = false }, 'host-authentication-login: deactivate')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: LOGIN_PATH, auth: 'anonymous',
      handler: async (req, res) => {
        if (!active) { res.writeHead(401); res.end('unauthorized'); return }
        const secure = webCtx.webServer.protocol === 'https:'
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (body === undefined) {
            res.writeHead(413, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
            res.end('payload too large\n')
            return
          }
          const params = new URLSearchParams(body)
          const user = params.get('user') ?? ''
          const pass = params.get('pass') ?? ''
          const userOk = timingSafeStringEqual(user, config.authUser)
          const passOk = timingSafeStringEqual(pass, config.authPass)
          if (!userOk || !passOk) {
            res.writeHead(401, {
              'cache-control': 'no-store',
              'content-type': 'text/html; charset=utf-8',
            })
            res.end(loginPage(true))
            return
          }
          let secret
          try {
            secret = await readSigningSecret(ctx.credentials)
          } catch (error) {
            console.error('[host-authentication-login] 签名密钥读取失败:', error)
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('signing secret unavailable\n')
            return
          }
          if (secret === undefined) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('signing secret unavailable\n')
            return
          }
          const authority = requestAudience(req.headers, secure)
          if (authority === undefined) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('missing authority\n')
            return
          }
          const issuedAt = Date.now()
          const expiresAt = issuedAt + 30 * DAY_MILLISECONDS
          const payloadBody = encodeBase64Url(Buffer.from(JSON.stringify({
            version: 1,
            authority,
            issuedAt,
            expiresAt,
          }), 'utf8'))
          const signature = createHmac('sha256', secret).update(payloadBody).digest()
          const value = `v1.${payloadBody}.${encodeBase64Url(signature)}`
          const maxAgeSeconds = Math.floor((expiresAt - issuedAt) / 1000)
          const attributes = `${cookieName(authority)}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
          res.writeHead(303, {
            'cache-control': 'no-store',
            'location': './',
            'referrer-policy': 'no-referrer',
            'set-cookie': secure ? `${attributes}; Secure` : attributes,
          })
          res.end()
          return
        }
        // GET：出登录页（已登录用户极少会手动访问 /login，直接出页无害）。
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
        })
        res.end(loginPage(false))
      },
    }), 'host-authentication-login: /login route')
  })
}
