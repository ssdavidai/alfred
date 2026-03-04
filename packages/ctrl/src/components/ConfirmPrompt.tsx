import React from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPrompt({ message, onConfirm, onCancel }: Props) {
  useInput((input) => {
    if (input === "y" || input === "Y") {
      onConfirm();
    } else if (input === "n" || input === "N" || input === "q") {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        {message}
      </Text>
      <Text>
        Press <Text bold>y</Text> to confirm, <Text bold>n</Text> to cancel
      </Text>
    </Box>
  );
}
