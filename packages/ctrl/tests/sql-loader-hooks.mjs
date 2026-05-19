// ESM loader hooks for `.sql` (and friends) → text import.
//
// Mirrors esbuild's `loader: { ".sql": "text" }` config in `build.mjs`,
// but for the test runner. See `tests/sql-loader.mjs` for context.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".sql", ".njk", ".md", ".yaml"]);

function isTextAsset(url) {
  const lower = url.toLowerCase();
  for (const ext of TEXT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export async function load(url, context, nextLoad) {
  if (isTextAsset(url)) {
    const filePath = fileURLToPath(url);
    const raw = await readFile(filePath, "utf8");
    // Export the file contents as the default export, matching esbuild's
    // "text" loader semantics.
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(raw)};`,
    };
  }
  return nextLoad(url, context);
}
