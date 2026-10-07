import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The worker's control flow: what it does on shutdown, and what it does when a
 * run never comes back.
 *
 * Both dependencies are faked, deliberately. The question here is not whether an
 * import extracts — `import-runner.integration.test.ts` answers that against a
 * real database — but whether the loop keeps its promises about *when* it stops.
 * Those promises are about ordering, and ordering tested against a real 200ms
 * extraction is a race: a shutdown test that happens to run after the import
 * finished passes while proving nothing.
 */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>();
  return { env: { ...actual.env, IMPORT_WORKER_CONCURRENCY: 1 } };
});
vi.mock('@/lib/services/imports/imports.writer', () => ({
  claimNextImport: vi.fn(),
  RUN_RECLAIM_AFTER_MS: 900_000,
}));
vi.mock('@/lib/services/imports/import-runner', () => ({
  runImport: vi.fn(),
  abandonImport: vi.fn(),
}));
vi.mock('@/index', () => ({ db: {} }));

const { main } = await import('./import-worker');
const writer = vi.mocked(await import('@/lib/services/imports/imports.writer'));
const runner = vi.mocked(await import('@/lib/services/imports/import-runner'));

/** A promise with its resolver exposed, so a test can decide when a run ends. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls rather than sleeps, so the test is as fast as the loop rather than as slow as a guess. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Resolves when `promise` settles, or to the sentinel if it is still pending. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

const claim = { id: 'import_1', userId: 'user_1', attempts: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  // One import to take, then nothing — so an undrained lane idles rather than
  // spinning through a thousand fake claims.
  writer.claimNextImport.mockResolvedValueOnce(claim).mockResolvedValue(null);
});

afterEach(() => {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('shutting down', () => {
  /**
   * The contract with the platform. An import is a model call that has already
   * been paid for, so killing one mid-flight wastes the spend and leaves a row
   * for another worker to reclaim fifteen minutes later.
   */
  it('lets an in-flight import finish before exiting', async () => {
    const run = deferred<{ status: string }>();
    runner.runImport.mockReturnValue(run.promise as never);

    const worker = main();
    await until(() => runner.runImport.mock.calls.length === 1, 'the import to be claimed');

    process.emit('SIGTERM');

    // The whole assertion. The worker has been told to stop and must still be
    // waiting, because the import it claimed has not come back yet.
    expect(await settledWithin(worker, 50)).toBe('pending');

    run.resolve({ status: 'ready' });
    await expect(worker).resolves.toBe(0);
  });

  /** Nothing new is taken after the signal, or a drain never ends under load. */
  it('claims nothing after the signal', async () => {
    runner.runImport.mockResolvedValue({ status: 'ready' } as never);

    const worker = main();
    await until(() => runner.runImport.mock.calls.length === 1, 'the first import to run');
    process.emit('SIGTERM');
    await worker;

    const claimsAfterSignal = writer.claimNextImport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));

    expect(writer.claimNextImport.mock.calls.length).toBe(claimsAfterSignal);
    expect(runner.runImport).toHaveBeenCalledTimes(1);
  });

  it('exits zero, because being asked to stop is not a failure', async () => {
    runner.runImport.mockResolvedValue({ status: 'ready' } as never);

    const worker = main();
    await until(() => runner.runImport.mock.calls.length === 1, 'the first import to run');
    process.emit('SIGTERM');

    await expect(worker).resolves.toBe(0);
  });
});

describe('an import that never comes back', () => {
  /**
   * The timeout cannot cancel the run — an in-flight model call has no abort path
   * from here — so the lane cannot simply be freed: the abandoned promise is
   * still out there, and letting another worker claim the row would be the
   * duplicate extraction the whole claim mechanism exists to prevent.
   *
   * Ending the process is what is left. The platform restarts it, and the restart
   * is the only thing that actually stops the orphaned work.
   */
  it('records the import and ends the process with a failure code', async () => {
    vi.useFakeTimers();
    try {
      runner.runImport.mockReturnValue(new Promise(() => {}) as never);
      runner.abandonImport.mockResolvedValue({ status: 'retrying' } as never);

      const worker = main();
      await vi.waitFor(() => expect(runner.runImport).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(900_000);

      // Handed back for another attempt rather than left `running` until the
      // reclaim window passes, which would be fifteen minutes of spinner.
      expect(runner.abandonImport).toHaveBeenCalledWith(claim.id, claim.attempts);
      // Non-zero, so the restart is visible as a restart rather than a clean exit.
      await expect(worker).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
