import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { Command, FromWorker, ToWorker } from '../src/sim/model';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('worker command diagnostics and rewind', () => {
  it('exports the recorded reason and checks it on rewind without duplicating input', async () => {
    const messages: FromWorker[] = [];
    const worker = { onmessage: (_event: { data: ToWorker }) => {}, postMessage: (m: FromWorker) => messages.push(structuredClone(m)) };
    vi.stubGlobal('self', worker);
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    const original = Sim.prototype.command;
    vi.spyOn(Sim.prototype, 'command').mockImplementation(function (this: Sim, cmd: Command, by?: string) {
      const r = original.call(this, cmd, by);
      if (cmd.c !== 'bookmark' || by) return r;
      const reasonCode = this.replaying ? 'CHANGED' : 'ORIGINAL';
      if (!this.replaying) {
        const input = this.inputLog.at(-1);
        if (input && 'cmd' in input) input.reasonCode = reasonCode;
      }
      return { ...r, reasonCode };
    });
    await import('../src/sim/worker');
    const send = (data: ToWorker) => worker.onmessage({ data });
    send({ type: 'init', config: { dayType: 'weekday', dateLabel: 'worker reason', startTime: 14400, seed: 19 } });
    await vi.waitFor(() => expect(messages.some(m => m.type === 'ready')).toBe(true));
    send({ type: 'cmd', id: 1, cmd: { c: 'bookmark', label: 'reason' } });
    send({ type: 'diagnostics' });
    const exported = messages.filter(m => m.type === 'diagnostics').at(-1);
    if (!exported || exported.type !== 'diagnostics') throw new Error('diagnostics missing');
    const before = JSON.parse(exported.json);
    expect(before.inputs).toHaveLength(1);
    expect(before.inputs[0]).toMatchObject({ cmd: { c: 'bookmark' }, reasonCode: 'ORIGINAL' });

    send({ type: 'jump', to: 14401 });
    send({ type: 'rewind', to: 14400, replay: true });
    send({ type: 'jump', to: 14401 });
    send({ type: 'diagnostics' });
    const afterMessage = messages.filter(m => m.type === 'diagnostics').at(-1);
    if (!afterMessage || afterMessage.type !== 'diagnostics') throw new Error('replay diagnostics missing');
    const after = JSON.parse(afterMessage.json);
    expect(after.inputs).toHaveLength(1);
    expect(after.inputs[0]).toMatchObject({ cmd: { c: 'bookmark' }, reasonCode: 'ORIGINAL' });
    expect(messages.some(m => m.type === 'events' && m.events.some(e => e.cat === '回放' && e.text.includes('ORIGINAL') && e.text.includes('CHANGED')))).toBe(true);
  });
});
