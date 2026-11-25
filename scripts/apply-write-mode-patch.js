#!/usr/bin/env node
// 写入权限补丁：DSH write 工具新建文件 0600 → 0644（暂存目录 0700 保持不变）。
// 三态：已应用→跳过；锚点在→应用；锚点漂移/状态矛盾→中止（退出 1）。
// 沿用中文技能补丁的结构：函数式替换防 $ 展开、.tmp+rename 原子写回、DSH_NM_BASE 测试环境变量。
import fs from 'node:fs'
import path from 'node:path'

const DSH_NM_BASE = process.env.DSH_NM_BASE || '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules'
const pkg = path.join(DSH_NM_BASE, '@deepseek-ai/dsh-fs-local')

const targets = [
  { file: path.join(pkg, 'lib/index.js'), from: 'handle = await open(tempPath, "wx", 384);', to: 'handle = await open(tempPath, "wx", 420);' },
  { file: path.join(pkg, 'lib/index.js'), from: 'await handle.chmod(384);', to: 'await handle.chmod(420);' },
  { file: path.join(pkg, 'src/fsio.ts'), from: "handle = await open(tempPath, 'wx', 0o600)", to: "handle = await open(tempPath, 'wx', 0o644)" },
  { file: path.join(pkg, 'src/fsio.ts'), from: 'await handle.chmod(0o600)', to: 'await handle.chmod(0o644)' },
  { file: path.join(pkg, 'lib/index.js'), from: 'staging directory and file with `0o700` and `0o600`', to: 'staging directory with `0o700` and the staged file with `0o644`' },
  { file: path.join(pkg, 'src/fsio.ts'), from: 'staging directory and file with `0o700` and `0o600`', to: 'staging directory with `0o700` and the staged file with `0o644`' }
]

let applied = 0
let pending = 0
let missing = 0
const pendingTargets = []
for (const t of targets) {
  let text
  try { text = fs.readFileSync(t.file, 'utf8') } catch { missing++; continue }
  if (text.includes(t.to)) { applied++; continue }
  if (text.includes(t.from)) { pending++; pendingTargets.push(t); continue }
  missing++
}

if (missing > 0) {
  console.error(`!! 锚点漂移（missing=${missing}），中止。dsh 升级后请核对源码再更新本补丁。`)
  process.exit(1)
}
if (pending === 0) {
  console.log('补丁已应用过，跳过。')
  process.exit(0)
}

const files = [...new Set(pendingTargets.map(t => t.file))]
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8')
  for (const t of pendingTargets.filter(x => x.file === file)) {
    text = text.split(t.from).join(t.to)
  }
  const tmp = file + '.patch-tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

console.log(`补丁已应用：${files.length} 个文件、${pending} 处替换。`)
