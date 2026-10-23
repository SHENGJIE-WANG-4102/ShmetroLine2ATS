/** Resolve once, before importing simulation state. Window and worker both use their own URL. */
export function resolveGroupId(input: { search?: string; argv?: readonly string[]; env?: Record<string, string | undefined> } = {}): string {
  const query = new URLSearchParams(input.search ?? '').get('line');
  if (query) return query;
  const args = input.argv ?? [];
  const inline = args.find(arg => arg.startsWith('--line='));
  if (inline) return inline.slice('--line='.length) || '2';
  const index = args.indexOf('--line');
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return input.env?.ATS_LINE || '2';
}

export function startupGroupId(): string {
  const host = globalThis as typeof globalThis & {
    process?: { argv?: string[]; env?: Record<string, string | undefined> };
  };
  return resolveGroupId({
    search: host.location?.search,
    argv: host.process?.argv,
    env: host.process?.env,
  });
}
