import { main } from './import-worker';

/**
 * The worker's entrypoint, and nothing else.
 *
 * Split from the loop so importing the loop does not start one. Bundled to
 * `dist/worker/import-worker.js`, which is what the platform runs.
 */
main().then(
  (exitCode) => process.exit(exitCode),
  (error) => {
    // Startup only — a lane handles its own failures. Reaching here means the
    // process could not get as far as a loop, so there is no import to name and
    // nothing a transcript could have reached.
    console.error('worker failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
