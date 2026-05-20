/** Merged chronological activity feed — the main content area. */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { FeedLine } from './FeedLine.js';
import { useStore } from '../store.js';
import { TOOLS } from '../data/constants.js';
import type { FeedEntry, MutationEntry } from '../data/types.js';

interface Props {
  height: number;
  width: number;
}

/** Convert mutation entries to feed entries for unified timeline. */
function mutationToFeed(m: MutationEntry): FeedEntry {
  const opSymbol = m.op === 'create' ? '+' : m.op === 'delete' ? '-' : '~';
  const opSev = m.op === 'create' ? 'success' : m.op === 'delete' ? 'error' : 'warning';
  return {
    timestamp: m.timestamp,
    severity: opSev as FeedEntry['severity'],
    message: `${opSymbol} ${m.path}`,
    tool: m.tool,
  };
}

export function ActivityStream({ height, width }: Props): React.ReactElement {
  const { feeds, mutations } = useStore();

  const merged = useMemo(() => {
    const all: FeedEntry[] = [];

    // Collect feed entries from all tools
    for (const tool of TOOLS) {
      const feed = feeds[tool];
      if (!feed) continue;
      all.push(...feed.entries);
    }

    // Add mutations as feed entries
    for (const m of mutations) {
      all.push(mutationToFeed(m));
    }

    // Sort by timestamp descending (newest first)
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return all;
  }, [feeds, mutations]);

  const visible = merged.slice(0, Math.max(1, height));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((entry, i) => (
        <FeedLine
          key={`${entry.timestamp}-${entry.tool}-${i}`}
          entry={entry}
          showTool
          width={width}
        />
      ))}
      {visible.length === 0 && (
        <Box paddingX={1}>
          <Text dimColor>Waiting for activity...</Text>
        </Box>
      )}
    </Box>
  );
}
