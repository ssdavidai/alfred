import React from "react";
import { Box, Text } from "ink";
import type { Screen } from "../data/types.js";

export function Header({ screen }: { screen: Screen }) {
  const title = {
    dashboard: "Dashboard",
    provision: "New Instance",
    detail: "Instance Detail",
    logs: "Logs",
    devices: "Devices",
  }[screen];

  return (
    <Box marginBottom={1}>
      <Text bold color="cyan">
        alfred-ctrl
      </Text>
      <Text> | </Text>
      <Text>{title}</Text>
    </Box>
  );
}
