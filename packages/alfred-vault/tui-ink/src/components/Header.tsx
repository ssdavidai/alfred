/** Header bar: name, health blocks, stats, sparkline. */

import React from 'react';
import { Box, Text } from 'ink';
import { Sparkline } from './Sparkline.js';
import { useStore } from '../store.js';
import { TOOLS, TOOL_COLORS, HEALTH_BLOCK } from '../data/constants.js';
import { TIME_SERIES_INTERVAL_MS } from '../data/constants.js';

export function Header(): React.ReactElement {
  const { workers, feeds, uptime, version, timeSeries } = useStore();

  const running = workers.filter(w => w.status === 'running').length;
  const total = workers.length || 4;

  // Count warnings and errors across all feeds
  let totalWarnings = 0;
  let totalErrors = 0;
  for (const tool of TOOLS) {
    const feed = feeds[tool];
    if (feed) {
      totalWarnings += feed.warnings;
      totalErrors += feed.errors;
    }
  }

  // Compute events/min from activityRate
  const samples = timeSeries.activityRate;
  const recentSum = samples.reduce((a, b) => a + b, 0);
  const intervalMin = TIME_SERIES_INTERVAL_MS / 60000;
  const eventsPerMin = samples.length > 0 ? Math.round(recentSum / (samples.length * intervalMin)) : 0;

  return (
    <Box paddingX={1}>
      <Text bold> alfred</Text>
      <Text dimColor> v{version}</Text>
      <Text>  </Text>

      {/* Health blocks — one per tool */}
      {TOOLS.map(tool => {
        const feed = feeds[tool];
        const health = feed?.health ?? 'pending';
        const block = HEALTH_BLOCK[health] ?? '\u2591';
        const color = TOOL_COLORS[tool];
        return <Text key={tool} color={color}>{block}</Text>;
      })}

      <Text> </Text>
      <Text>{running}/{total}</Text>
      <Text>   </Text>
      <Text color={totalWarnings > 0 ? '#fbbf24' : undefined} dimColor={totalWarnings === 0}>
        {'\u26a0'} {totalWarnings}
      </Text>
      <Text>  </Text>
      <Text color={totalErrors > 0 ? '#ef4444' : undefined} dimColor={totalErrors === 0}>
        {'\u2715'} {totalErrors}
      </Text>
      <Text>  </Text>
      <Text dimColor>{'\u23f1'} {uptime}</Text>

      <Box flexGrow={1} />

      <Sparkline data={timeSeries.activityRate} width={10} color="#00d4aa" />
      <Text dimColor> {eventsPerMin}/min</Text>
    </Box>
  );
}
