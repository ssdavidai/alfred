import React from "react";
import { Text } from "ink";

const BLOCKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

interface Props {
  label: string;
  data: number[];
  max?: number;
  width?: number;
  color?: string;
  warnAbove?: number;
}

export function Sparkline({
  label,
  data,
  max: maxOverride,
  width = 48,
  color = "green",
  warnAbove,
}: Props) {
  if (data.length === 0) return null;

  // Downsample if more data points than width
  const sampled =
    data.length <= width
      ? data
      : Array.from({ length: width }, (_, i) => {
          const start = Math.floor((i * data.length) / width);
          const end = Math.floor(((i + 1) * data.length) / width);
          const slice = data.slice(start, Math.max(end, start + 1));
          return slice.reduce((a, b) => a + b, 0) / slice.length;
        });

  const max = maxOverride ?? Math.max(...sampled, 1);
  const current = sampled[sampled.length - 1];
  const warn = warnAbove !== undefined && current > warnAbove;

  const bars = sampled
    .map((v) => {
      const idx = Math.round((Math.min(v, max) / max) * (BLOCKS.length - 1));
      return BLOCKS[idx];
    })
    .join("");

  return (
    <Text>
      <Text bold>{label}</Text>
      <Text color={warn ? "red" : color}>{bars}</Text>
      <Text color={warn ? "red" : undefined}>
        {" "}
        {Math.round(current)}%
      </Text>
    </Text>
  );
}
