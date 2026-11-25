/** 中文技能名支持——行为测试（对运行环境编译产物断言）。
 *  红 = 现状不支持中文；绿 = 打补丁后全过。
 *  ASCII 样例的期望在红绿两阶段一致，守护「放宽不改变英文行为」的回归边界。 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const LIB = process.env.DSH_NM_BASE || '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
let passed = 0, failed = 0
const fails = []
function check(label, fn) {
  try { fn(); passed++ ; console.log('  ✓ ' + label) }
  catch (e) { failed++; fails.push(`${label}: ${e.message}`); console.log('  ✗ ' + label) }
}

// ---------- 1) 服务端总校验（dsh-skill 导出的 isSkillName） ----------
console.log('[1] dsh-skill isSkillName 行为')
const skill = await import('file://' + LIB + '/dsh-skill/lib/index.js')
check('中文名「标准开发流程」应通过', () => assert.equal(skill.isSkillName('标准开发流程'), true))
check('中英混合「CI失败范式」应通过', () => assert.equal(skill.isSkillName('CI失败范式'), true))
check('纯中文名「代码提交前评审」应通过', () => assert.equal(skill.isSkillName('代码提交前评审'), true))
check('全角数字名「技能３版」应通过', () => assert.equal(skill.isSkillName('技能３版'), true))
// 英文零回归：逐个断言全部 6 个内置技能名（评审建议）
for (const name of ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'official-plugins', 'personalized-pages']) {
  check(`内置英文名回归：${name} 仍通过`, () => assert.equal(skill.isSkillName(name), true))
}
check('边界回归：连续中横线仍拒绝', () => assert.equal(skill.isSkillName('a--b'), false))
check('边界回归：首中横线仍拒绝', () => assert.equal(skill.isSkillName('-abc'), false))
check('边界回归：尾中横线仍拒绝', () => assert.equal(skill.isSkillName('abc-'), false))
check('边界回归：emoji 与序号字符仍拒绝', () => assert.equal(skill.isSkillName('技能🚀版'), false))

// ---------- 2) 服务端 /手势（从 dsh-tool-skill 编译产物提取正则测行为） ----------
console.log('[2] dsh-tool-skill 手势正则行为')
const toolSrc = readFileSync(LIB + '/dsh-tool-skill/lib/index.js', 'utf8')
const g = toolSrc.match(/const SKILL_GESTURE = \/(.+?)(?<!\\)\/([a-z]+);/)
assert.ok(g, '提取 SKILL_GESTURE 失败——文件结构变了，需人工核对')
const gesture = new RegExp(g[1], g[2])
// 带全局标志的正则用 matchAll 取捕获组（与模块源码同法）
check('手势提取中文名「/标准开发流程」', () =>
  assert.equal('试试 /标准开发流程 直达'.matchAll(gesture).next().value?.[2], '标准开发流程'))
check('手势提取全角数字名「/技能３版」', () =>
  assert.equal('试试 /技能３版 直达'.matchAll(gesture).next().value?.[2], '技能３版'))
check('手势英文回归：/tdd-development 仍提取', () =>
  assert.equal('试试 /tdd-development'.matchAll(gesture).next().value?.[2], 'tdd-development'))
check('路径不误伤回归：/usr/bin 不产生候选', () =>
  assert.equal('/usr/bin 路径'.matchAll(gesture).next().value, undefined))
check('分数不误伤回归：5/8 不产生候选（原版同）', () =>
  assert.equal('5/8'.matchAll(gesture).next().value, undefined))

// ---------- 3) 网页端角标（从 dsh-client-ui-skill 编译产物提取正则测行为） ----------
console.log('[3] dsh-client-ui-skill 角标 tokens 正则行为')
const clientSrc = readFileSync(LIB + '/dsh-client-ui-skill/lib/client.js', 'utf8')
const c = clientSrc.match(/const tokens=\/(.+?)(?<!\\)\/([a-z]+);/)
assert.ok(c, '提取 tokens 正则失败——文件结构变了，需人工核对')
const tokens = new RegExp(c[1], c[2])
check('角标匹配中文「/标准开发流程」', () =>
  assert.equal('试试 /标准开发流程 直达'.matchAll(tokens).next().value?.[1], '标准开发流程'))
check('角标英文回归：/tdd-development 仍匹配', () =>
  assert.equal('试试 /tdd-development'.matchAll(tokens).next().value?.[1], 'tdd-development'))
check('角标路径不误伤回归：/usr/bin 不匹配', () =>
  assert.equal('/usr/bin 路径'.matchAll(tokens).next().value, undefined))

// ---------- 汇总 ----------
console.log(`\n结果：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
