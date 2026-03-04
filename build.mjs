import * as esbuild from "esbuild";
import { builtinModules } from "module";
import { readFile } from "fs/promises";

const watch = process.argv.includes("--watch");

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node:sqlite",
];

// Plugin to load hook handler JS files as text strings (for deployment to tenants)
const hookTextLoader = {
  name: "hook-text-loader",
  setup(build) {
    build.onLoad({ filter: /\/hooks\/[^/]+\/handler\.js$/ }, async (args) => ({
      contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))};`,
      loader: "js",
    }));
  },
};

// Plugin to stub out optional packages that aren't installed
const optionalExternals = {
  name: "optional-externals",
  setup(build) {
    const optionals = ["react-devtools-core", "yoga-wasm-web"];
    for (const pkg of optionals) {
      build.onResolve({ filter: new RegExp(`^${pkg}$`) }, () => ({
        path: pkg,
        namespace: "optional-stub",
      }));
    }
    build.onLoad({ filter: /.*/, namespace: "optional-stub" }, () => ({
      contents: "export default undefined;",
    }));
  },
};

const buildOptions = {
  entryPoints: ["src/index.tsx"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.mjs",
  banner: { js: "#!/usr/bin/env node\nimport{createRequire}from'module';const require=createRequire(import.meta.url);" },
  external: [
    ...nodeBuiltins,
    "ssh2",  // native addon
  ],
  plugins: [hookTextLoader, optionalExternals],
  loader: {
    ".sql": "text",
    ".njk": "text",
    ".md": "text",
  },
  sourcemap: true,
  minify: false,
};

// Standalone API build — no React, no ssh2, no sqlite, no ink
const apiBuildOptions = {
  entryPoints: ["src/api/standalone.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/api.mjs",
  banner: { js: "#!/usr/bin/env node" },
  external: nodeBuiltins,
  loader: {},
  sourcemap: true,
  minify: false,
};

if (watch) {
  const [ctx, apiCtx] = await Promise.all([
    esbuild.context(buildOptions),
    esbuild.context(apiBuildOptions),
  ]);
  await Promise.all([ctx.watch(), apiCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(buildOptions),
    esbuild.build(apiBuildOptions),
  ]);
  console.log("Build complete.");
}
