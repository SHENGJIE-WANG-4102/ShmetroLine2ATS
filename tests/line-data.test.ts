import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINE_2 } from '../src/data/lines/line2';
import { LINE_GROUPS, getGroup, getLine, scopedId, visibleLineGroups } from '../src/data/registry';
import { resolveGroupId } from '../src/data/startup';

const read = (file: string) => new TextDecoder().decode(readFileSync(file));
const normalize = (path: string) => path.replace(/\\/g, '/');

describe('line data boundary', () => {
  it('selects a group at startup and keeps entity references scoped', () => {
    expect(resolveGroupId()).toBe('2');
    expect(resolveGroupId({ env: { ATS_LINE: 'test' } })).toBe('test');
    expect(resolveGroupId({ argv: ['--line=test'] })).toBe('test');
    expect(resolveGroupId({ argv: ['--line', 'test'] })).toBe('test');
    expect(resolveGroupId({ search: '?line=test', env: { ATS_LINE: '2' } })).toBe('test');
    expect(getGroup('2').lineIds).toEqual(['2']);
    expect(getLine('2', getGroup('2'))).toBe(LINE_2);
    expect(scopedId('2', 'trip', '1')).not.toEqual(scopedId('test', 'trip', '1'));
    expect(visibleLineGroups().map(g => g.id)).toEqual(['2']);
    expect(visibleLineGroups(true).map(g => g.id)).toContain('test');
    expect(() => getGroup('missing')).toThrow('未知线路组');
  });

  it('keeps station literals inside line data in every production dependency', () => {
    const lines = LINE_GROUPS.flatMap(g => g.lines);
    const codes = new Set(lines.flatMap(line => [...line.core.STATIONS.map(s => s.id), ...line.core.LAYOUT.depots.map(d => d.id)]));
    const names = lines.flatMap(line => [...line.core.STATIONS.flatMap(s => [s.name, s.formerName, s.dmiName].filter((n): n is string => !!n)),
      ...line.core.LAYOUT.depots.flatMap(d => [d.name, d.short])]);
    const queue = ['src/main.ts', 'src/sim/worker.ts'], seen = new Set<string>(), violations: string[] = [];
    // Walk the actual application graph: unrelated, unconnected prototypes are not application code.
    while (queue.length) {
      const file = normalize(queue.pop()!);
      if (seen.has(file) || file.startsWith('src/data/lines/')) continue;
      seen.add(file);
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const value = node.text;
          const code = value.split(/[^A-Z0-9]+/).find(token => codes.has(token));
          const name = names.find(n => value.includes(n));
          if (code || name) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${code ?? name}`);
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = node.moduleSpecifier.text.split('?')[0];
          if (target.startsWith('.')) {
            const base = normalize(join(file.slice(0, file.lastIndexOf('/')), target));
            const resolved = [base, `${base}.ts`, `${base}/index.ts`].find(p => p.endsWith('.ts') && existsSync(p));
            if (resolved) queue.push(resolved);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(seen.size).toBeGreaterThan(65);
    expect(violations).toEqual([]);
  });
});
