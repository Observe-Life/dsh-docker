// 构建期登录跳转补丁：把未登录访问首页的 401 分支改为 302 跳转 /login。
// 锚点必须恰好命中一处，命中 0 处或多处即中止（exit 1），杜绝静默错补。
const fs = require('fs');
const p = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = 'if (this.isAuthenticated(req, secure)) return true;\n\t\tthis.writeUnauthorized(req, res);\n\t\treturn false;';
const count = s.split(anchor).length - 1;
if (count !== 1) {
  console.error(`[apply-login-patch] 锚点命中 ${count} 处（必须恰好 1 处），构建中止`);
  process.exit(1);
}
const replacement = 'if (this.isAuthenticated(req, secure)) return true;\n\t\tres.writeHead(302, { "cache-control": "no-store", location: "/login" });\n\t\tres.end();\n\t\treturn false;';
s = s.replace(anchor, replacement);
fs.writeFileSync(p + '.tmp', s);
fs.renameSync(p + '.tmp', p);
console.log('[apply-login-patch] 登录跳转补丁已应用并原子写回');
