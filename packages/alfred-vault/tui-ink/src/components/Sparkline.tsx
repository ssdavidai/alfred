/** Unicode sparkline using block characters. */

import React from 'react';
import { Text } from 'ink';

const BLOCKS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'; // ▁▂▃▄▅▆▇█

interface Props {
  data: number[];
  width?: number;
  color?: string;
}

export function Sparkline({ data, width = 10, color }: Props): React.ReactElement {
  if (data.length === 0) {
    return <Text dimColor>{BLOCKS[0]!.repeat(width)}</Text>;
  }

  const max = Math.max(...data, 1);
  const samples = data.slice(-width);
  const pad = width - samples.length;

  const chars = samples.map(v => {
    const idx = Math.round((v / max) * 7);
    return BLOCKS[Math.min(7, Math.max(0, idx))]!;
  }).join('');

  const padStr = pad > 0 ? BLOCKS[0]!.repeat(pad) : '';

  return (
    <Text>
      {padStr.length > 0 && <Text dimColor>{padStr}</Text>}
      <Text color={color}>{chars}</Text>
    </Text>
  );
}
