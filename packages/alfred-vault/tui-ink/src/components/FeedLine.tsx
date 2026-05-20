/** Single activity line with severity gutter. */

import React from 'react';
import { Box, Text } from 'ink';
import type { FeedEntry } from '../data/types.js';
import { SEVERITY_ICONS, SEVERITY_STYLES, SEVERITY_GUTTER, TOOL_COLORS } from '../data/constants.js';

interface Props {
  entry: FeedEntry;
  showTool?: boolean;
  width?: number;
}

export function FeedLine({ entry, showTool = true, width }: Props): React.ReactElement {
  const time = entry.timestamp.length >= 16 ? entry.timestamp.slice(11, 16) : entry.timestamp;
  const icon = SEVERITY_ICONS[entry.severity] ?? ' ';
  const sevColor = SEVERITY_STYLES[entry.severity];
  const gutter = SEVERITY_GUTTER[entry.severity] ?? '\u2502';
  const toolColor = TOOL_COLORS[entry.tool];

  // Truncate message to fit width if provided
  let msg = entry.message;
  if (width && width > 0) {
    const overhead = 9 + (showTool ? 12 : 0); // gutter(2) + time(5) + spaces + tool + icon
    const maxMsg = width - overhead;
    if (maxMsg > 0 && msg.length > maxMsg) {
      msg = msg.slice(0, maxMsg - 1) + '\u2026';
    }
  }

  const isDim = sevColor === '#6b7280'; // info severity

  return (
    <Box paddingX={1}>
      <Text color={sevColor}>{gutter}</Text>
      <Text> </Text>
      <Text dimColor>{time}</Text>
      <Text>  </Text>
      {showTool && (
        <>
          <Text color={toolColor}>{entry.tool.padEnd(10)}</Text>
          <Text> </Text>
        </>
      )}
      <Text color={sevColor} dimColor={isDim}>{icon}</Text>
      <Text> </Text>
      <Text color={isDim ? undefined : sevColor} dimColor={isDim}>{msg}</Text>
    </Box>
  );
}
