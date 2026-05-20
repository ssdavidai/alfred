/** Entry point: parse env vars, render <App />. */

import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

const dataDir = process.env['ALFRED_DATA_DIR'] ?? './data';
const version = process.env['ALFRED_VERSION'] ?? '0.0.0';

const element = <App dataDir={dataDir} version={version} />;

async function main() {
  // Try fullscreen-ink for alternate screen buffer
  try {
    const { withFullScreen } = await import('fullscreen-ink');
    const { start, waitUntilExit } = withFullScreen(element, {
      exitOnCtrlC: true,
      patchConsole: true,
    });
    await start();
    await waitUntilExit();
    return;
  } catch {
    // fullscreen-ink not available or errored, fall back
  }

  const { waitUntilExit } = render(element, {
    exitOnCtrlC: true,
    patchConsole: true,
  });

  await waitUntilExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
