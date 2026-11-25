// 构建期中文技能名补丁：把 3 处技能名格式正则从「小写字母/数字/中横线」
// 放宽为「Unicode 字母与数字（含中文与全角数字）＋中横线」，使中文技能名可被发现、注入、加载，
// 消息里 /中文名 手势与网页端角标同步生效。输入框补全无字符过滤，无需改动。
// 每个候选锚点必须恰好命中一处，命中 0 处或多处即中止（exit 1），杜绝静默错补；
// 已应用目标版本时幂等跳过；文件含上一版替换结果时按锚点升级。写回原子替换。
// 替换一律用函数形式（replace 的第二个参数传函数），杜绝替换串里 $ 特殊序列被展开的隐患。
const fs = require('fs');

// 目标根路径：构建期默认写死安装路径；仅测试时可经环境变量指向副本区
const BASE = process.env.DSH_NM_BASE || '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

// String.raw 保留正则文本里的反斜杠，避免 JS 字符串转义吞掉 \S \w \p 等
// anchors：按序候选锚点（v0=官方原文，v1=本补丁的上一版结果），replacement=当前版结果
const edits = [
  {
    // 服务端总校验：注册/加载/按名调用的唯一正则源头，文件扫描等引用方运行时共享
    file: `${BASE}/dsh-skill/lib/index.js`,
    anchors: [
      String.raw`const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;`,
      String.raw`const SKILL_NAME = /^[\p{L}0-9]+(?:-[\p{L}0-9]+)*$/u;`,
    ],
    replacement: String.raw`const SKILL_NAME = /^[\p{L}\p{Nd}0-9]+(?:-[\p{L}\p{Nd}0-9]+)*$/u;`,
  },
  {
    // 服务端 /手势：用户消息里 /技能名 的候选识别
    file: `${BASE}/dsh-tool-skill/lib/index.js`,
    anchors: [
      String.raw`const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;`,
      String.raw`const SKILL_GESTURE = /(^|\s)\/([\p{L}0-9]+(?:-[\p{L}0-9]+)*)(?=\s|$)/gu;`,
    ],
    replacement: String.raw`const SKILL_GESTURE = /(^|\s)\/([\p{L}\p{Nd}0-9]+(?:-[\p{L}\p{Nd}0-9]+)*)(?=\s|$)/gu;`,
  },
  {
    // 网页端角标：聊天记录里 /技能名 的投影识别（有已加载名单白名单兜底，放宽不误伤普通文本）
    file: `${BASE}/dsh-client-ui-skill/lib/client.js`,
    anchors: [
      String.raw`const tokens=/(?<!\S)\/([\w-]+)(?!\S)/gu`,
      String.raw`const tokens=/(?<!\S)\/([\p{L}0-9]+(?:-[\p{L}0-9]+)*)(?!\S)/gu`,
    ],
    replacement: String.raw`const tokens=/(?<!\S)\/([\p{L}\p{Nd}0-9]+(?:-[\p{L}\p{Nd}0-9]+)*)(?!\S)/gu`,
  },
];

let applied = 0, upgraded = 0, skipped = 0;
for (const e of edits) {
  let s;
  try { s = fs.readFileSync(e.file, 'utf8'); }
  catch (err) { console.error(`[apply-chinese-skill-patch] 读取失败 ${e.file}: ${err.message}，构建中止`); process.exit(1); }
  if (s.includes(e.replacement)) {
    // 已含目标版本时还要确认候选锚点都已消失：若锚点仍在（如人工编辑把目标文本粘到了别处），
    // 说明文件状态矛盾，静默跳过会留下未修补行——按本脚本「杜绝静默错补」的约定直接中止。
    const stale = e.anchors.map((anchor) => s.split(anchor).length - 1)
    if (stale.some(c => c !== 0)) {
      const detail = e.anchors.map((a, i) => `锚${i}命中${stale[i]}处`).join('，');
      console.error(`[apply-chinese-skill-patch] ${e.file} 已含目标版本但候选锚点仍在（${detail}），状态矛盾，构建中止`);
      process.exit(1);
    }
    skipped++;
    console.log(`[apply-chinese-skill-patch] 已应用，跳过：${e.file}`);
    continue;
  }
  let found = undefined;
  const counts = e.anchors.map((anchor) => s.split(anchor).length - 1);
  for (let i = 0; i < e.anchors.length; i++) {
    if (counts[i] === 1) { found = e.anchors[i]; break; }
  }
  if (found === undefined) {
    const detail = e.anchors.map((a, i) => `锚${i}命中${counts[i]}处`).join('，');
    console.error(`[apply-chinese-skill-patch] ${e.file} 无可用锚点（${detail}，每个候选必须恰好 1 处），构建中止`);
    process.exit(1);
  }
  const wasUpgraded = found !== e.anchors[0];
  s = s.replace(found, () => e.replacement);
  fs.writeFileSync(e.file + '.tmp', s);
  fs.renameSync(e.file + '.tmp', e.file);
  if (wasUpgraded) upgraded++; else applied++;
  console.log(`[apply-chinese-skill-patch] 已替换${wasUpgraded ? '（由上一版升级）' : ''}：${e.file}`);
}
console.log(`[apply-chinese-skill-patch] 中文技能名补丁完成：新应用 ${applied} 处，升级 ${upgraded} 处，已应用跳过 ${skipped} 处`);
