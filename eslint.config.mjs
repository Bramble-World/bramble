import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Turn off stylistic rules that would fight Prettier. Must stay last.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Drizzle-generated migrations:
    'src/db/drizzle/**',
    // Trigger.dev CLI scratch space. Bundled vendor code, regenerated on every
    // `trigger.dev dev` run, and it drowns the report — nearly 500 errors that
    // are not ours and cannot be fixed.
    '.trigger/**',
  ]),
]);

export default eslintConfig;
