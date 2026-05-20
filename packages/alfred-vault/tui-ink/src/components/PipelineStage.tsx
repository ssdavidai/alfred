/** Horizontal pipeline stage visualization. */

import React from 'react';
import { Text } from 'ink';

export interface Stage {
  label: string;
  status: 'done' | 'active' | 'pending';
}

interface Props {
  stages: Stage[];
}

const STAGE_ICON: Record<string, string> = {
  done: '\u2713',    // ✓
  active: '\u25d0',  // ◐
  pending: '\u25cb',  // ○
};

const STAGE_COLOR: Record<string, string> = {
  done: '#00ff88',
  active: '#00d4aa',
  pending: '',
};

export function PipelineStage({ stages }: Props): React.ReactElement {
  return (
    <Text>
      {stages.map((s, i) => {
        const icon = STAGE_ICON[s.status] ?? '\u25cb';
        const color = STAGE_COLOR[s.status];
        const arrow = i < stages.length - 1 ? ' \u2192 ' : '';
        const dim = s.status === 'pending';

        return (
          <Text key={i}>
            <Text color={color || undefined} dimColor={dim}>{icon} {s.label}</Text>
            {arrow && <Text dimColor>{arrow}</Text>}
          </Text>
        );
      })}
    </Text>
  );
}
