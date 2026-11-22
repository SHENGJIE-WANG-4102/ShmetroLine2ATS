import { describe, expect, it } from 'vitest';
import { checkText } from '../scripts/check-rules';

/** Each rule catches a planted violation and lets the allowed form through. */
describe('check-rules', () => {
  const ids = (file: string, text: string) => checkText(file, text).map(hit => hit.rule.id);

  it('catches each rule', () => {
    expect(ids('src/sim/x.ts', "import { A } from '../data/lines/line2/line2';")).toEqual(['line-import']);
    expect(ids('src/ui/x.ts', "if (LINE_ID === '11') run();")).toEqual(['line-id']);
    expect(ids('src/sim/x.ts', 'const debug = process.env.DEBUG;')).toEqual(['process-env']);
    expect(ids('docs/x.md', '这段由 Opus 写')).toEqual(['model-name']);
    expect(ids('src/sim/x.ts', "const ahead = dir === 'DN' ? s.chain > ch : s.chain < ch;")).toEqual(['direction']);
    expect(ids('src/sim/x.ts', "if (!found) throw new Error('no train');")).toEqual(['runtime-throw']);
    expect(ids('tests/x.test.ts', "it.only('case', () => {});")).toEqual(['skip-only']);
  });

  it('lets allowed forms through', () => {
    expect(ids('docs/x.md', '见 CLAUDE.md 和 claude/nifty-faraday 分支')).toEqual([]);
    expect(ids('src/sim/x.ts', 'const ahead = (chainAhead(dir, ch, s.chain) ?? 0) > 0;')).toEqual([]);
    expect(ids('src/sim/x.ts', 'const near = tr.dir === 1 ? tr.off >= b.offset : tr.off <= b.offset;')).toEqual([]);
    expect(ids('src/sim/topology.ts', "throw new Error('main link not found');")).toEqual([]);
    expect(ids('scripts/x.ts', 'const debug = process.env.DEBUG;')).toEqual([]);
  });
});
