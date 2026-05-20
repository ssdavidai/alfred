/** Expanded view for a single worker with pipeline, stats grid, sparklines. */

import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { FeedLine } from './FeedLine.js';
import { PipelineStage } from './PipelineStage.js';
import { Sparkline } from './Sparkline.js';
import type { Stage } from './PipelineStage.js';
import { useStore } from '../store.js';
import { TOOL_COLORS, TOOL_STAGES } from '../data/constants.js';
import type { WorkerInfo, WorkerFeed } from '../data/types.js';

interface Props {
  tool: string;
  height: number;
  width: number;
}

const EMPTY_WORKER: WorkerInfo = { name: '', status: 'pending', pid: null, restarts: 0, exitCode: null };
const EMPTY_FEED: WorkerFeed = {
  entries: [], currentStep: '', currentFile: '', health: 'pending',
  llmCalls: 0, stdoutChars: 0, tokens: 0, errors: 0, warnings: 0,
};

function formatCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function deriveStages(tool: string, currentStep: string): Stage[] {
  const stageLabels = TOOL_STAGES[tool] ?? ['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4'];
  const stageMatch = currentStep.match(/Stage (\d+)/);
  const stageNum = stageMatch ? parseInt(stageMatch[1]!, 10) : 0;

  return stageLabels.map((label, i) => {
    const num = i + 1;
    if (stageNum === 0) return { label, status: 'pending' as const };
    if (num < stageNum) return { label, status: 'done' as const };
    if (num === stageNum) return { label, status: 'active' as const };
    return { label, status: 'pending' as const };
  });
}

export function WorkerDetail({ tool, height, width }: Props): React.ReactElement {
  const { workers, feeds, timeSeries } = useStore();

  const worker = workers.find(w => w.name === tool) ?? { ...EMPTY_WORKER, name: tool };
  const feed = feeds[tool] ?? EMPTY_FEED;
  const toolColor = TOOL_COLORS[tool];

  const health = feed.health;
  const isWorking = health === 'working';
  const step = feed.currentStep || 'Idle';

  const stages = deriveStages(tool, step);
  const toolActivity = timeSeries.perToolActivity[tool] ?? [];

  // Stats
  const tokenDisplay = formatCount(feed.tokens);

  // Header(1) + pipeline(1) + separator(1) + stats grid(3) + separator(1) + feed
  const headerLines = 7;
  const feedHeight = Math.max(1, height - headerLines);

  const sepChar = '\u2504'; // ┄
  const sepLine = sepChar.repeat(Math.max(10, width - 2));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Line 1: spinner/icon + TOOL NAME + step + pid */}
      <Box paddingX={1}>
        {isWorking ? (
          <Box width={2}>
            <Spinner type="dots" />
          </Box>
        ) : (
          <Text color={health === 'failing' ? '#ef4444' : toolColor}>
            {health === 'failing' ? '\u2715 ' : '\u25cf '}
          </Text>
        )}
        <Text bold color={toolColor}>{tool.toUpperCase()}</Text>
        <Text dimColor> {'\u2014'} </Text>
        <Text>{step}</Text>
        <Box flexGrow={1} />
        {worker.pid && <Text dimColor>pid {worker.pid}</Text>}
      </Box>

      {/* Line 2: Pipeline stages */}
      <Box paddingX={3}>
        <PipelineStage stages={stages} />
      </Box>

      {/* Dotted separator */}
      <Box paddingX={1}>
        <Text dimColor>{sepLine}</Text>
      </Box>

      {/* Stats grid — 2 columns with sparklines */}
      <Box paddingX={3}>
        <Box width={Math.floor((width - 6) / 2)}>
          <Text>LLM Calls   </Text>
          <Text bold>{feed.llmCalls.toString().padEnd(4)}</Text>
          <Sparkline data={timeSeries.llmCallRate} width={8} color="#00d4aa" />
        </Box>
        <Box>
          <Text>Tokens   </Text>
          <Text bold>{tokenDisplay.padEnd(6)}</Text>
          <Sparkline data={toolActivity} width={8} color={toolColor} />
        </Box>
      </Box>
      <Box paddingX={3}>
        <Box width={Math.floor((width - 6) / 2)}>
          <Text>Restarts    </Text>
          <Text bold>{worker.restarts.toString()}</Text>
        </Box>
        <Box>
          <Text>Errors   </Text>
          <Text bold color={feed.errors > 0 ? '#ef4444' : undefined}>{feed.errors.toString()}</Text>
        </Box>
      </Box>
      <Box paddingX={3}>
        <Box width={Math.floor((width - 6) / 2)}>
          <Text>Processed   </Text>
          <Text bold>{feed.entries.length.toString()}</Text>
        </Box>
        <Box>
          <Text>Warnings </Text>
          <Text bold color={feed.warnings > 0 ? '#fbbf24' : undefined}>{feed.warnings.toString()}</Text>
        </Box>
      </Box>

      {/* Dotted separator */}
      <Box paddingX={1}>
        <Text dimColor>{sepLine}</Text>
      </Box>

      {/* Filtered feed for this tool only */}
      <Box flexDirection="column" flexGrow={1}>
        {feed.entries.slice(0, feedHeight).map((entry, i) => (
          <FeedLine
            key={`${entry.timestamp}-${i}`}
            entry={entry}
            showTool={false}
            width={width}
          />
        ))}
        {feed.entries.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor>No activity for {tool} yet.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
