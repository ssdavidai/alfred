/** Single dim line with context-sensitive keybindings. */

import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  view: string;
}

export function Footer({ view }: Props): React.ReactElement {
  let hints: string;

  switch (view) {
    case 'detail':
      hints = '\u2191\u2193 scroll  esc back  r restart  ? actions  q quit';
      break;
    case 'logs':
      hints = '\u2191\u2193 scroll  0-4 tool  f severity  g top  esc back  q quit';
      break;
    case 'mutations':
      hints = '\u2191\u2193 scroll  esc back  q quit';
      break;
    default: // dashboard
      hints = '\u2191\u2193 select  \u23ce detail  l logs  m mutations  ? actions  q quit';
      break;
  }

  return (
    <Box paddingX={1}>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
