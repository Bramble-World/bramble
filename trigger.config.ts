import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  // Replace with Bramble's own project ref from the Trigger.dev dashboard,
  // or set TRIGGER_PROJECT_REF in the environment.
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_bramble_replace_me',
  runtime: 'node',
  logLevel: 'log',
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
    },
  },
  dirs: ['./src/trigger'],
});
