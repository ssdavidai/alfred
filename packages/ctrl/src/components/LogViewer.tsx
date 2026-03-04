import React from "react";
import { Box, Text } from "ink";

interface Props {
  lines: string[];
  title?: string;
}

export function LogViewer({ lines, title }: Props) {
  const visible = lines.slice(-20);
  return (
    <Box flexDirection="column">
      {title && (
        <Text bold dimColor>
          {title}
        </Text>
      )}
      {visible.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
      {lines.length === 0 && <Text dimColor>No logs</Text>}
    </Box>
  );
}
