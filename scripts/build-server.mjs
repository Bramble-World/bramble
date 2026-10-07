import { cp, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Bundles everything in the image that is not the Next.js app.
 *
 * The worker, the two sweeps and the migrator all run from the same container as
 * the web process — one image, three ways to start it — and that image has no dev
 * dependencies in it. Without a bundle each of those entrypoints would need
 * `tsx`, `typescript` and the whole dependency tree present at runtime, which is
 * a build toolchain shipped to production so that four files can be read.
 *
 * ESM output, because `import.meta.dirname` is how the migrator finds its SQL and
 * there is no honest equivalent in a CommonJS bundle. Node needs to be told, so a
 * `dist/package.json` declaring `type: module` goes out with it.
 */

const OUT = 'dist';

/** Entry → output. The output paths are the contract with porter.yaml. */
const ENTRIES = {
  'src/worker/main.ts': `${OUT}/worker/import-worker.js`,
  'src/sweeps/arc-sweep.ts': `${OUT}/sweeps/arc-sweep.js`,
  'src/sweeps/import-sweep.ts': `${OUT}/sweeps/import-sweep.js`,
  'src/db/migrate.ts': `${OUT}/db/migrate.js`,
};

await Promise.all(
  Object.entries(ENTRIES).map(([entry, outfile]) =>
    build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      // Matches .nvmrc and the image's base. Lower and esbuild downlevels syntax
      // Node already has; higher and it emits syntax Node does not.
      target: 'node22',
      format: 'esm',
      /**
       * Gives the bundle a working `require`.
       *
       * Half this dependency tree is still CommonJS, and esbuild's ESM output
       * replaces their `require()` calls with a shim that throws — so the bundle
       * builds cleanly and then dies on `Dynamic require of "fs"` the first time
       * dotenv loads. The shim checks for a real `require` before throwing, so
       * defining one from `import.meta.url` is all it needs.
       */
      banner: {
        js: [
          "import { createRequire as __createRequire } from 'node:module';",
          'const require = __createRequire(import.meta.url);',
        ].join('\n'),
      },
      sourcemap: true,
      // Bundled in, deliberately. Resolving `@/...` at runtime would need the
      // tsconfig and a loader hook in the image; esbuild reads `paths` from
      // tsconfig.json itself and the alias disappears into the output.
      tsconfig: 'tsconfig.json',
      // A bundle minified is a stack trace that names no function. These run
      // unattended, so legibility when one fails is worth more than the bytes.
      minify: false,
      logLevel: 'info',
    })
  )
);

// `type: module`, so Node reads the `.js` files above as ESM. The repo's own
// package.json deliberately does not say this — Next owns that decision for the
// app — so it is declared here, next to the output it describes.
await writeFile(`${OUT}/package.json`, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// The migrator reads these at runtime, so they travel with it rather than being
// bundled. They are SQL files; there is nothing to compile.
await mkdir(`${OUT}/db`, { recursive: true });
await cp('src/db/drizzle', `${OUT}/db/drizzle`, { recursive: true });
