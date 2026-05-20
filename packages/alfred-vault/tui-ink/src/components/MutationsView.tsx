/** Mutation list with record type badges and time-grouped counts. */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../store.js';
import { TOOL_COLORS, RECORD_TYPE_COLORS } from '../data/constants.js';

const OP_SYMBOL: Record<string, string> = { create: '+', modify: '~', delete: '-' };
const OP_COLOR: Record<string, string> = { create: '#00ff88', modify: '#fbbf24', delete: '#ef4444' };

function parseRecordInfo(path: string): { recordType: string; name: string } {
  // path like "person/Alice Johnson.md" or "project/X.md"
  const parts = path.split('/');
  if (parts.length >= 2) {
    const recordType = parts[parts.length - 2]!;
    const name = parts[parts.length - 1]!.replace(/\.md$/, '');
    return { recordType, name };
  }
  return { recordType: '', name: path.replace(/\.md$/, '') };
}

function countByAge(mutations: { timestamp: string }[]): { recent5m: number; recent30m: number; older: number } {
  const now = Date.now();
  let recent5m = 0;
  let recent30m = 0;
  let older = 0;
  for (const m of mutations) {
    const ts = new Date(m.timestamp).getTime();
    const ageMs = now - ts;
    if (ageMs <= 5 * 60_000) recent5m++;
    else if (ageMs <= 30 * 60_000) recent30m++;
    else older++;
  }
  return { recent5m, recent30m, older };
}

interface Props {
  height: number;
  width: number;
}

export function MutationsView({ height, width }: Props): React.ReactElement {
  const { mutations } = useStore();
  const [scrollOffset, setScrollOffset] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setScrollOffset(prev => Math.max(0, prev - 1));
    if (key.downArrow) setScrollOffset(prev => Math.min(Math.max(0, mutations.length - 1), prev + 1));
    if (key.pageUp) setScrollOffset(prev => Math.max(0, prev - 10));
    if (key.pageDown) setScrollOffset(prev => Math.min(Math.max(0, mutations.length - 1), prev + 10));
  });

  const ageCounts = countByAge(mutations);

  // Header takes 2 lines (title + rule)
  const feedHeight = Math.max(1, height - 2);
  const visible = mutations.slice(scrollOffset, scrollOffset + feedHeight);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Title with time-grouped counts */}
      <Box paddingX={1}>
        <Text bold>Mutations</Text>
        <Text dimColor> {'\u2014'} {mutations.length} total</Text>
        <Box flexGrow={1} />
        <Text dimColor>5m: </Text><Text>{ageCounts.recent5m}</Text>
        <Text dimColor>  30m: </Text><Text>{ageCounts.recent30m}</Text>
        <Text dimColor>  older: </Text><Text>{ageCounts.older}</Text>
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text dimColor>{'\u2500'.repeat(Math.max(10, width - 2))}</Text>
      </Box>

      {/* Rows */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((m, i) => {
          const time = m.timestamp.length >= 16 ? m.timestamp.slice(11, 16) : m.timestamp;
          const sym = OP_SYMBOL[m.op] ?? '?';
          const col = OP_COLOR[m.op] ?? 'white';
          const { recordType, name } = parseRecordInfo(m.path);
          const typeColor = RECORD_TYPE_COLORS[recordType];
          const toolColor = TOOL_COLORS[m.tool];

          return (
            <Box key={`${m.timestamp}-${scrollOffset + i}`} paddingX={1}>
              <Text dimColor>{time}</Text>
              <Text>  </Text>
              <Text color={toolColor}>{m.tool.padEnd(10)}</Text>
              <Text> </Text>
              <Text color={col}>{sym}</Text>
              <Text> </Text>
              {recordType && (
                <>
                  <Text color={typeColor} dimColor={!typeColor}>{recordType.padEnd(12)}</Text>
                  <Text> </Text>
                </>
              )}
              <Text>{name}</Text>
            </Box>
          );
        })}
        {visible.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor>No vault mutations recorded yet.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
