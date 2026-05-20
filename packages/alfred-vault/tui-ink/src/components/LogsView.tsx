/** Filtered log viewer — replaces screens/Logs.tsx. */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { FeedLine } from './FeedLine.js';
import { useStore } from '../store.js';
import { TOOLS } from '../data/constants.js';
import type { FeedEntry } from '../data/types.js';

const SEVERITIES = ['all', 'info', 'success', 'warning', 'error'] as const;

interface Props {
  height: number;
  width: number;
}

export function LogsView({ height, width }: Props): React.ReactElement {
  const { feeds } = useStore();
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [scrollOffset, setScrollOffset] = useState(0);

  useInput((input, key) => {
    if (input === '0') setToolFilter('all');
    else if (input === '1') setToolFilter(TOOLS[0]!);
    else if (input === '2') setToolFilter(TOOLS[1]!);
    else if (input === '3') setToolFilter(TOOLS[2]!);
    else if (input === '4') setToolFilter(TOOLS[3]!);

    if (input === 'f') {
      setSevFilter(prev => {
        const idx = SEVERITIES.indexOf(prev as typeof SEVERITIES[number]);
        return SEVERITIES[(idx + 1) % SEVERITIES.length]!;
      });
    }

    if (key.upArrow) setScrollOffset(prev => Math.max(0, prev - 1));
    if (key.downArrow) setScrollOffset(prev => prev + 1);
    if (key.pageUp) setScrollOffset(prev => Math.max(0, prev - 10));
    if (key.pageDown) setScrollOffset(prev => prev + 10);
    if (input === 'g') setScrollOffset(0);
  });

  const allEntries = useMemo(() => {
    const merged: FeedEntry[] = [];
    for (const tool of TOOLS) {
      const feed = feeds[tool];
      if (!feed) continue;
      merged.push(...feed.entries);
    }
    merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return merged;
  }, [feeds]);

  const filtered = useMemo(() => {
    return allEntries.filter(e => {
      if (toolFilter !== 'all' && e.tool !== toolFilter) return false;
      if (sevFilter !== 'all' && e.severity !== sevFilter) return false;
      return true;
    });
  }, [allEntries, toolFilter, sevFilter]);

  // Header takes 2 lines (filter bar + rule)
  const feedHeight = Math.max(1, height - 2);
  const visible = filtered.slice(scrollOffset, scrollOffset + feedHeight);

  // Clamp scroll
  if (scrollOffset > 0 && scrollOffset >= filtered.length) {
    setScrollOffset(Math.max(0, filtered.length - 1));
  }

  const toolLabel = toolFilter === 'all' ? 'all (1-4)' : `${toolFilter} (${TOOLS.indexOf(toolFilter) + 1})`;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Filter bar */}
      <Box paddingX={1}>
        <Text bold>Logs</Text>
        <Text dimColor>  tool: </Text>
        <Text>{toolLabel}</Text>
        <Text dimColor>  severity: </Text>
        <Text>{sevFilter} (f)</Text>
        <Box flexGrow={1} />
        <Text dimColor>{filtered.length} entries</Text>
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text dimColor>{'\u2500'.repeat(Math.max(10, width - 2))}</Text>
      </Box>

      {/* Log entries */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((entry, i) => (
          <FeedLine
            key={`${entry.timestamp}-${entry.tool}-${scrollOffset + i}`}
            entry={entry}
            showTool
            width={width}
          />
        ))}
        {visible.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor>No log entries match the current filter.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
