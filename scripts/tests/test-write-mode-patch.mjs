#!/usr/bin/env node
// 写入权限补丁回归测试（构建期最后一道行为把关）：
// ① umask 077 下新建文件断言 0o644（umask 无关性正是原缺陷的签名）；
// ② 覆盖已有 0600 文件断言仍 0600（保留原权限不变量）；
// ③ finally 恢复 umask 并清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_NM_BASE = process.env.DSH_NM_BASE || '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules'
const mod = await import(`file://${path.join(DSH_NM_BASE, '@deepseek-ai/dsh-fs-local/lib/index.js')}`)

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`) } else { fail++; console.error(`FAIL ${name}`) }
}

const oldUmask = process.umask(0o077)
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmode-'))
const inst = Object.create(mod.LocalFileSystem.prototype)
inst.config = { diffBasisMaxBytes: 1024 }
inst.internals = {}
inst.withLock = async (k, fn) => await fn({ aborted: false, throwIfAborted() { } })

try {
  const newPath = path.join(tmpdir, 'new.txt')
  await inst.writeText({ targetKey: newPath, displayPath: 'new.txt' }, 'x\n', undefined)
  check('umask 077 下新建文件应为 0644', (fs.statSync(newPath).mode & 0o777) === 0o644)

  const oldPath = path.join(tmpdir, 'old.txt')
  fs.writeFileSync(oldPath, 'x\n')
  fs.chmodSync(oldPath, 0o600)
  await inst.writeText({ targetKey: oldPath, displayPath: 'old.txt' }, 'y\n', undefined)
  check('覆盖已有 0600 文件应保持 0600', (fs.statSync(oldPath).mode & 0o777) === 0o600)

  const dirs = fs.readdirSync(tmpdir).filter(d => d.endsWith('.tmpdir'))
  check('写成功后无暂存目录残留', dirs.length === 0)
} finally {
  process.umask(oldUmask)
  fs.rmSync(tmpdir, { recursive: true, force: true })
}

console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
