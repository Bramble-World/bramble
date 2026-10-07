/**
 * The shell every sweep runs inside: log the outcome, close up, exit.
 *
 * Sweeps are one-shot processes now rather than scheduled functions, so each one
 * has to end deliberately. Both the Postgres pool and the Redis client hold open
 * sockets that keep the event loop alive, so a sweep that merely returns hangs
 * until the platform kills it — and a cron job killed on timeout is a failed
 * cron job, however well the work went.
 *
 * The exit code is the whole contract with the scheduler: zero ran, non-zero did
 * not, and a non-zero one is what makes a broken sweep visible instead of
 * quietly stopping.
 */
export async function runSweep(
  name: string,
  work: () => Promise<Record<string, number>>
): Promise<void> {
  const startedAt = Date.now();

  try {
    const result = await work();
    // Counts and durations only. A sweep touches storylines and imports, and
    // nothing it reports is derived from their content.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: name,
        ...result,
        durationMs: Date.now() - startedAt,
      })
    );
    process.exit(0);
  } catch (error) {
    // The message, not the error. A generation failure can carry a prompt in a
    // `cause` chain, and the prompt is somebody's conversation.
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        event: `${name}_failed`,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    process.exit(1);
  }
}
