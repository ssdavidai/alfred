/** Single compact worker line with status indicator, mini bar, and LLM/error counts. */

import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { MiniBar } from './MiniBar.js';
import type { WorkerInfo, WorkerFeed } from '../data/types.js';
import { STATUS_INDICATOR, STATUS_COLOR, TOOL_COLORS } from '../data/constants.js';

interface Props {
  worker: WorkerInfo;
  feed: WorkerFeed;
  selected: boolean;
  width: number;
}

export function WorkerLine({ worker, feed, selected, width }: Props): React.ReactElement {
  const health = feed.health;
  const isWorking = health === 'working';
  const isStopped = worker.status === 'stopped';
  const isFailing = health === 'failing';

  const color = STATUS_COLOR[health] ?? 'dim';
  const indicator = STATUS_INDICATOR[health] ?? '\u25cf';
  const toolColor = TOOL_COLORS[worker.name];

  const step = feed.currentStep || (isStopped ? 'Stopped' : 'Idle');

  // Parse stage number for MiniBar
  const stageMatch = feed.currentStep.match(/Stage (\d+)/);
  const stageNum = stageMatch ? parseInt(stageMatch[1]!, 10) : 0;
  const totalStages = 4;

  // Right side: MiniBar + ⚡ LLM count + ⚠ errors
  const llmCount = feed.llmCalls;
  const errCount = feed.errors + feed.warnings;
  // Reserve: minibar(12) + llm(5) + err(4) + spacing
  const rightInfoWidth = (stageNum > 0 ? 14 : 0) + 8 + 6;

  // Compute available space for step text
  const nameWidth = 12;
  const leftOverhead = 3 + nameWidth; // " ● name     "
  const padding = 2; // paddingX=1
  const maxStepLen = Math.max(10, width - leftOverhead - rightInfoWidth - padding);

  let displayStep = step;
  if (displayStep.length > maxStepLen) {
    displayStep = displayStep.slice(0, maxStepLen - 1) + '\u2026';
  }

  const dim = isStopped && !isFailing;

  return (
    <Box paddingX={1}>
      {isWorking ? (
        <Box width={2}>
          <Spinner type="dots" />
        </Box>
      ) : (
        <Text color={isFailing ? 'red' : (color !== 'dim' ? color : undefined)} dimColor={color === 'dim' || dim}>
          {indicator}{' '}
        </Text>
      )}
      <Text bold inverse={selected} dimColor={dim} color={toolColor}>
        {worker.name.padEnd(nameWidth)}
      </Text>
      <Text dimColor={!isWorking || dim}>{displayStep}</Text>
      <Box flexGrow={1} />
      {stageNum > 0 && (
        <Box marginRight={1}>
          <MiniBar current={stageNum} total={totalStages} width={8} color={toolColor} />
        </Box>
      )}
      <Text color={llmCount > 0 ? '#00d4aa' : undefined} dimColor={llmCount === 0}>
        {'\u26a1'}{llmCount.toString().padStart(2)}
      </Text>
      <Text>  </Text>
      <Text color={errCount > 0 ? '#ef4444' : undefined} dimColor={errCount === 0}>
        {errCount > 0 ? '\u26a0' : '\u26a0'}{errCount.toString().padStart(1)}
      </Text>
    </Box>
  );
}
