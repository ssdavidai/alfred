// Node ESM loader hook so the test runner can import `.sql` files as
// strings, matching the production esbuild loader config in `build.mjs`.
//
// Why this file exists:
//   `src/db/state.ts` does `import m001 from "./migrations/001_init.sql"`
//   etc. The production bundle works because `build.mjs` registers a
//   `".sql": "text"` loader with esbuild. The test runner (tsx via
//   `node --import tsx/esm --test ...`) has no such loader, so `.sql`
//   imports crash with `ERR_UNKNOWN_FILE_EXTENSION`.
//
//   Anything that transitively imports `state.ts` (vault routes,
//   admin routes, auth, signals, etc.) was therefore unloadable in
//   tests — and that's most of `tests/*.test.ts`.
//
// Strategy:
//   Use Node's built-in `module.register()` ESM hook to intercept any
//   resolution ending in `.sql` and return the file contents as a
//   default-exported string module. This runs BEFORE tsx's own hook
//   (we register it from the same `--import` chain), so .sql imports
//   short-circuit before tsx's TypeScript transformer sees them.
//
//   The same shape works for `.njk`/`.md`/`.yaml` if a future test
//   imports a module that transitively pulls in a template, but for
//   now only `.sql` is needed.

import { register } from "node:module";

register("./sql-loader-hooks.mjs", import.meta.url);
