/** Container for the 4 WorkerLines with selection tracking. */

import React from 'react';
import { Box } from 'ink';
import { WorkerLine } from './WorkerLine.js';
import { useStore } from '../store.js';
import { TOOLS } from '../data/constants.js';
import type { WorkerInfo, WorkerFeed } from '../data/types.js';

interface Props {
  selected: number;
  width: number;
}

const EMPTY_WORKER: WorkerInfo = { name: '', status: 'pending', pid: null, restarts: 0, exitCode: null };
const EMPTY_FEED: WorkerFeed = {
  entries: [], currentStep: '', currentFile: '', health: 'pending',
  llmCalls: 0, stdoutChars: 0, tokens: 0, errors: 0, warnings: 0,
};

export function WorkerSection({ selected, width }: Props): React.ReactElement {
  const { workers, feeds } = useStore();

  return (
    <Box flexDirection="column">
      {TOOLS.map((tool, i) => {
        const worker = workers.find(w => w.name === tool) ?? { ...EMPTY_WORKER, name: tool };
        const feed = feeds[tool] ?? EMPTY_FEED;
        return (
          <WorkerLine
            key={tool}
            worker={worker}
            feed={feed}
            selected={i === selected}
            width={width}
          />
        );
      })}
    </Box>
  );
}
