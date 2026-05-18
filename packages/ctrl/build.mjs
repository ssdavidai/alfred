// ============================================================================
// ctrl build — alfred-black.
//
// alfred-black keeps ONLY the tenant API server (`src/api/`). The Ink TUI and
// the Commander CLI (`src/index.tsx`, `src/infra`, `src/components`, …) were
// pruned with the SaaS provisioning layer. This build produces a single
// artefact: `dist/api.mjs`, the standalone API bundle the alfred-ctrl-api
// Docker image runs.
//
// node builtins (incl. `node:sqlite`) are marked external — Node 22 provides
// them. Everything else (js-yaml, nunjucks, …) is bundled in, so the runtime
// image needs no node_modules.
//
// `.sql` / `.njk` / `.md` / `.yaml` files are loaded as text strings — that's
// how schema.sql, the templates, and the skill markdown reach the bundle.
// ============================================================================

import * as esbuild from "esbuild";
import { builtinModules } from "module";

const watch = process.argv.includes("--watch");

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
];

// Standalone API build — the only artefact.
const apiBuildOptions = {
  entryPoints: ["src/api/standalone.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/api.mjs",
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
  external: nodeBuiltins,
  loader: {
    ".sql": "text",
    ".njk": "text",
    ".md": "text",
    ".yaml": "text",
  },
  sourcemap: true,
  minify: false,
};

if (watch) {
  const apiCtx = await esbuild.context(apiBuildOptions);
  await apiCtx.watch();
  console.log("Watching for changes (dist/api.mjs)...");
} else {
  await esbuild.build(apiBuildOptions);
  console.log("Build complete — dist/api.mjs");
}
