import { describe, expect, it, vi } from 'vitest';

/** the sim worker must tell the UI when it throws, not freeze silently */
describe('worker crash reporting', () => {
  it('posts a crash message for an exception in start-up and ignores later input until a restart', async () => {
    const posted: { type: string; where?: string; message?: string }[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.self = g;
    g.postMessage = (m: { type: string }) => { posted.push(m); };
    g.addEventListener = () => undefined;
    await import('../src/sim/worker');
    const send = (data: unknown) => (g.onmessage as (e: { data: unknown }) => void)({ data });

    send({ type: 'init', config: null }); // reading config.startTime throws inside the async start
    await vi.waitFor(() => expect(posted.some(m => m.type === 'crash')).toBe(true));
    const crash = posted.find(m => m.type === 'crash')!;
    expect(crash.where).toBe('start');
    expect(crash.message).toBeTruthy();

    const before = posted.length;
    send({ type: 'speed', speed: 5 }); // frozen: dropped, no reply and no second crash
    send({ type: 'diagnostics' }); // still answered without a sim: nothing to export, but no throw
    expect(posted.length).toBe(before);
    expect(posted.filter(m => m.type === 'crash')).toHaveLength(1);
  });
});
