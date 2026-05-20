/** Inline confirmation — renders as a line replacing the footer. */

import React from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPrompt({ message, onConfirm, onCancel }: Props): React.ReactElement {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box paddingX={1}>
      <Text color="yellow" bold>{message}</Text>
      <Text>  </Text>
      <Text dimColor>(y/n)</Text>
    </Box>
  );
}
