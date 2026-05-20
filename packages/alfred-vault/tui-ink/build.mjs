import esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
import module from 'module';

const watch = process.argv.includes('--watch');

// Plugin to stub out optional devtools import
const stubPlugin = {
  name: 'stub-optional',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }));
  },
};

// Node.js builtins must stay external in ESM format
const nodeBuiltins = module.builtinModules.flatMap(m => [m, `node:${m}`]);

const buildOptions = {
  entryPoints: ['src/index.tsx'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  external: nodeBuiltins,
  minify: !watch,
  banner: { js: '#!/usr/bin/env node\nimport{createRequire}from"module";const require=createRequire(import.meta.url);' },
  plugins: [stubPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);

  // Copy to Python package bundled directory
  const destDir = '../src/alfred/_bundled/tui_js';
  mkdirSync(destDir, { recursive: true });
  cpSync('dist/index.js', `${destDir}/index.js`);

  const { statSync } = await import('fs');
  const size = statSync('dist/index.js').size;
  console.log(`Built and copied to _bundled/tui_js/index.js (${(size / 1024).toFixed(0)} KB)`);
}
