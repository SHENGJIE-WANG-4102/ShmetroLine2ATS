/**
 * Machine-checkable rules from AGENTS.md. Run before handing work in: `npm run check:rules`.
 * Prints every hit not on the allow-list and exits 1 when there is one. The allow-lists only
 * shrink: an entry names a file and a piece of the offending line, never a line number.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface Rule {
  id: string;
  /** the AGENTS.md rule, quoted in the report */
  rule: string;
  /** repo-relative path prefixes the rule applies to, and file extensions */
  paths: string[];
  ext: RegExp;
  /** does this line break the rule */
  hit: (line: string) => boolean;
  /** [file, a piece of the line]: existing hits allowed for now; '' allows the whole file */
  allow?: [string, string][];
}

const matches = (pattern: RegExp) => (line: string) => pattern.test(line);
const MODEL = /\b(?:Claude|Opus|Sonnet|Haiku|Fable|DeepSeek|Gemini|GPT-?\d)\b/i;
/** "Claude" is also the name of the instruction file and of folders and branches */
const NOT_A_MODEL = /CLAUDE(?:\.local)?\.md|\.claude\b|\bclaude[/-][\w./-]+/gi;

export const RULES: Rule[] = [
  {
    id: 'line-import', rule: 'src/sim、src/ui 不许直接 import 某条线的目录（从 src/data/current.ts 取）',
    paths: ['src/sim/', 'src/ui/'], ext: /\.ts$/, hit: matches(/from\s+'[^']*\/lines\//),
  },
  {
    id: 'line-id', rule: '不许写 if (LINE_ID === …)；线路之间的差别写成数据或能力',
    paths: ['src/sim/', 'src/ui/'], ext: /\.ts$/, hit: matches(/\bLINE_ID\b|\bLINE\.id\s*[!=]==|[!=]==\s*LINE\.id\b/),
  },
  {
    id: 'process-env', rule: '产品代码（src/）里不许留调试用的环境变量开关',
    paths: ['src/'], ext: /\.ts$/, hit: matches(/\bprocess\??\.env\b/),
    // ATS_LINE picks the line group at start-up (AGENTS.md 多线路), not a debug switch
    allow: [['src/data/startup.ts', 'env: host.process?.env']],
  },
  {
    id: 'model-name', rule: '代码、注释、文档、测试里不写任何 AI 模型名称',
    paths: ['src/', 'scripts/', 'tests/', 'docs/', 'README', 'AGENTS.md'], ext: /\.(ts|js|mjs|py|md)$/,
    hit: line => MODEL.test(line.replace(NOT_A_MODEL, '')),
  },
  {
    id: 'direction', rule: "新代码不许拿序号或里程比方向（dir === 'DN' ? a < b : a > b），走 topology.ts 的方向辅助函数",
    paths: ['src/'], ext: /\.ts$/, // (a link's own `dir === 1 ? off > … : off < …` compares offsets along one link and is fine)
    hit: matches(/(?:===|!==)\s*'(?:DN|UP)'\s*\?[^:;?]*[<>]=?[^:;?]*:[^;?]*[<>]/),
    allow: [['src/sim/topologyOrder.ts', "return direction === 'DN' ? to > from : to < from;"]],
  },
  {
    id: 'runtime-throw', rule: '运行中不许 throw（建图、读入数据时的检查列在白名单里）',
    paths: ['src/sim/'], ext: /\.ts$/, hit: matches(/\bthrow\s+new\b/),
    allow: [
      ['src/sim/topology.ts', ''],
      ['src/sim/topologyOrder.ts', 'station order has a loop'],
      ['src/sim/diagnostics.ts', 'Unsupported diagnostics bundle'],
      ['src/sim/diagnostics.ts', 'Invalid command timeline'],
      ['src/sim/diagnostics.ts', 'Diagnostics infrastructure differs'],
      ['src/sim/warmupCache.ts', 'Invalid warm-up graph history'],
      // D207: still open, to become a data self-check
      ['src/sim/timetable.ts', '缺少过夜泊位'],
      ['src/sim/timetable.ts', '无可用的过夜出车任务'],
    ],
  },
  {
    id: 'skip-only', rule: '测试里不许留 it.skip / it.only',
    paths: ['tests/', 'src/'], ext: /\.ts$/, hit: matches(/\b(?:it|test|describe)\.(?:skip|only)\b/),
  },
];

export interface Hit { rule: Rule; file: string; line: number; text: string }

const applies = (rule: Rule, file: string) => rule.paths.some(p => file.startsWith(p)) && rule.ext.test(file);

/** Hits of the rules in one file's text, allow-listed ones left out. */
export function checkText(file: string, text: string, rules: readonly Rule[] = RULES): Hit[] {
  const lines = text.split(/\r?\n/);
  return rules.filter(rule => applies(rule, file)).flatMap(rule => lines.flatMap((line, i) =>
    rule.hit(line) && !rule.allow?.some(([f, piece]) => f === file && line.includes(piece))
      ? [{ rule, file, line: i + 1, text: line.trim() }] : []));
}

/** the checker and its test spell out the patterns they look for */
const SELF = new Set(['scripts/check-rules.ts', 'tests/check-rules.test.ts']);

function main(): void {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(file => file && !SELF.has(file) && RULES.some(rule => applies(rule, file)));
  const hits = files.flatMap(file => checkText(file, readFileSync(file, { encoding: 'utf8' })));
  for (const hit of hits) console.log(`${hit.file}:${hit.line} [${hit.rule.id}] ${hit.rule.rule}\n    ${hit.text.slice(0, 160)}`);
  console.log(hits.length ? `${hits.length} hit(s)` : 'check-rules: clean');
  process.exitCode = hits.length ? 1 : 0;
}

if (process.argv[1]?.endsWith('check-rules.ts')) main();
