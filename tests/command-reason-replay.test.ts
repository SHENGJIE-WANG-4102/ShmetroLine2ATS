import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../src/sim/engine';
import { exportDiagnostics, parseDiagnostics, replayDiagnostics, stringifyDiagnostics } from '../src/sim/diagnostics';
import type { CmdResult } from '../src/sim/interlocking';

const make = () => new Sim({ dayType: 'weekday', dateLabel: 'reason replay', startTime: 14400, seed: 19 });
const command = { c: 'bookmark', label: 'reason test' } as const;
const mockResult = (result: CmdResult) => vi.spyOn(
  Sim.prototype as unknown as { execCommand: () => CmdResult }, 'execCommand',
).mockReturnValue(result);

afterEach(() => vi.restoreAllMocks());

describe('command reason codes in diagnostics', () => {
  it('records the result and reproduces it through export and replay', () => {
    mockResult({ ok: false, msg: '不可达', reasonCode: 'UNREACHABLE' });
    const sim = make();
    expect(sim.command(command)).toMatchObject({ ok: false, msg: '不可达', reasonCode: 'UNREACHABLE' });
    expect(sim.inputLog[0]).toMatchObject({ cmd: command, reasonCode: 'UNREACHABLE' });
    const replay = replayDiagnostics(parseDiagnostics(stringifyDiagnostics(exportDiagnostics(sim))));
    expect(replay.inputLog[0]).toMatchObject({ cmd: command, reasonCode: 'UNREACHABLE' });
    expect(replay.events.some(e => e.cat === '回放')).toBe(false);
    expect(replay.events.some(e => e.cat === '调度' && e.text.includes('不可达'))).toBe(true);
  });

  it('reports a changed reason without throwing, and accepts old entries without a code', () => {
    const mocked = mockResult({ ok: true, msg: '已满足', reasonCode: 'ALREADY_SATISFIED' });
    const sim = make();
    sim.command(command);
    const bundle = exportDiagnostics(sim);
    mocked.mockReturnValue({ ok: false, msg: '不可达', reasonCode: 'UNREACHABLE' });
    const replay = replayDiagnostics(bundle);
    expect(replay.events.some(e => e.cat === '回放' && e.text.includes('ALREADY_SATISFIED') && e.text.includes('UNREACHABLE'))).toBe(true);
    const input = bundle.inputs[0];
    if ('cmd' in input) delete input.reasonCode;
    expect(replayDiagnostics(bundle).events.some(e => e.cat === '回放')).toBe(false);
  });

  it('leaves ordinary and non-human command inputs unchanged', () => {
    const sim = make();
    sim.command(command);
    sim.command(command, '自动调度');
    expect(sim.inputLog).toHaveLength(1);
    expect(sim.inputLog[0]).not.toHaveProperty('reasonCode');
  });
});
