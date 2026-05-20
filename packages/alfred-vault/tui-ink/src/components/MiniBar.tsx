/** Inline progress bar using block characters. */

import React from 'react';
import { Text } from 'ink';

interface Props {
  current: number;
  total: number;
  width?: number;
  color?: string;
  showLabel?: boolean;
}

export function MiniBar({ current, total, width = 8, color, showLabel = true }: Props): React.ReactElement {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.min(1, Math.max(0, current / safeTotal));
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  return (
    <Text>
      <Text color={color}>{'\u2588'.repeat(filled)}</Text>
      <Text dimColor>{'\u2591'.repeat(empty)}</Text>
      {showLabel && <Text dimColor> {current}/{total}</Text>}
    </Text>
  );
}
