import { afterEach, describe, expect, it } from 'vitest';
import {
  createDenoLocalOcrBackend,
  DEFAULT_PROBE_FAILURE_CACHE_TTL_MS,
} from '../ogeLocalOcrRuntime.ts';

// The runtime module only touches Deno APIs inside functions, so importing it
// under Node (vitest) is safe.  A fake Deno.Command counts spawns and returns
// canned outputs, which pins the caching policy without the real binaries.

interface FakeResult {
  code: number;
  stdout: string;
  stderr: string;
}

function installFakeDeno(
  handler: (cmd: string, args: string[]) => FakeResult,
): { calls: Array<{ cmd: string; args: string[] }>; restore: () => void } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const encoder = new TextEncoder();
  class FakeCommand {
    private cmd: string;
    private args: string[];
    constructor(cmd: string, opts: { args: string[] }) {
      this.cmd = cmd;
      this.args = opts.args;
      calls.push({ cmd, args: [...opts.args] });
    }
    spawn(): { kill: () => void; output: () => Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> } {
      const result = handler(this.cmd, this.args);
      return {
        kill: () => {},
        output: async () => ({
          code: result.code,
          stdout: encoder.encode(result.stdout),
          stderr: encoder.encode(result.stderr),
        }),
      };
    }
  }
  const prev = (globalThis as Record<string, unknown>).Deno;
  (globalThis as Record<string, unknown>).Deno = { Command: FakeCommand };
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete (globalThis as Record<string, unknown>).Deno;
      else (globalThis as Record<string, unknown>).Deno = prev;
    },
  };
}

function successHandler(cmd: string, args: string[]): FakeResult {
  if (cmd === 'pdftoppm') return { code: 0, stdout: '', stderr: 'pdftoppm version 22.02.0\n' };
  if (cmd === 'tesseract' && args[0] === '--version') {
    return { code: 0, stdout: 'tesseract 5.5.0\n', stderr: '' };
  }
  if (cmd === 'tesseract' && args[0] === '--list-langs') {
    return { code: 0, stdout: 'List of available languages in "/share/":\neng\nosd\n', stderr: '' };
  }
  return { code: 1, stdout: '', stderr: 'unexpected' };
}

function pdftoppmMissingHandler(cmd: string, _args: string[]): FakeResult {
  if (cmd === 'pdftoppm') return { code: 1, stdout: '', stderr: 'not found' };
  return { code: 0, stdout: '', stderr: '' };
}

let restoreFake: (() => void) | null = null;

afterEach(() => {
  restoreFake?.();
  restoreFake = null;
});

describe('ogeLocalOcrRuntime probe caching', () => {
  it('caches a successful probe (no respawn)', async () => {
    const fake = installFakeDeno(successHandler);
    restoreFake = fake.restore;
    const backend = createDenoLocalOcrBackend();

    const first = await backend.probe();
    const second = await backend.probe();

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    // One pdftoppm -v, one tesseract --version, one --list-langs, then cached.
    expect(fake.calls).toHaveLength(3);
  });

  it('caches a failed probe within the TTL (no respawn)', async () => {
    expect(DEFAULT_PROBE_FAILURE_CACHE_TTL_MS).toBe(5 * 60_000);
    const fake = installFakeDeno(pdftoppmMissingHandler);
    restoreFake = fake.restore;
    let currentMs = 1_000_000;
    const backend = createDenoLocalOcrBackend({ now: () => currentMs });

    const first = await backend.probe();
    expect(first.ok).toBe(false);
    expect(fake.calls).toHaveLength(1);

    // Still within the TTL: the cached failure is replayed, no new spawn.
    currentMs += 60_000;
    const second = await backend.probe();
    expect(second).toBe(first);
    expect(fake.calls).toHaveLength(1);
  });

  it('re-probes after the failure-cache TTL expires (transient failures self-heal)', async () => {
    const fake = installFakeDeno(pdftoppmMissingHandler);
    restoreFake = fake.restore;
    let currentMs = 2_000_000;
    const backend = createDenoLocalOcrBackend({ now: () => currentMs });

    const first = await backend.probe();
    expect(first.ok).toBe(false);
    expect(fake.calls).toHaveLength(1);

    currentMs += DEFAULT_PROBE_FAILURE_CACHE_TTL_MS + 1;
    const second = await backend.probe();
    expect(second.ok).toBe(false);
    expect(second).not.toBe(first);
    expect(fake.calls).toHaveLength(2);
  });
});
