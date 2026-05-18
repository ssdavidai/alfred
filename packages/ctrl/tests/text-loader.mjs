// Node ESM loader hook for the test runner.
//
// The ctrl source imports `.sql` / `.njk` / `.md` / `.yaml` files as text
// strings — esbuild handles this in the production build (build.mjs `loader`
// config), but the test runner uses tsx, which does not. This loader teaches
// the test runner to resolve those imports to a default-exported string,
// matching the esbuild `text` loader behaviour.
//
// Registered via `--import ./tests/text-loader.mjs` in the `test` script.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TEXT_EXT = /\.(sql|njk|md|yaml)$/;

export async function load(url, context, nextLoad) {
  if (TEXT_EXT.test(url)) {
    const content = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(content)};`,
    };
  }
  return nextLoad(url, context);
}
