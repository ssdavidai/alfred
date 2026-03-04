import React from "react";
import { Box, Text } from "ink";
import { KEYBINDING_HINTS } from "../data/constants.js";
import type { Screen } from "../data/types.js";

export function Footer({ screen }: { screen: Screen }) {
  const hint = KEYBINDING_HINTS[screen] ?? "";
  return (
    <Box marginTop={1}>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
