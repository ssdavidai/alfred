import React from "react";
import { Box, Text, useInput } from "ink";
import { useInstances } from "../hooks/useInstances.js";
import { InstanceRow } from "./InstanceRow.js";

interface Props {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onEnter: () => void;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

export function Dashboard({ selectedIndex, onSelect, onEnter }: Props) {
  const { instances, refresh } = useInstances();

  useInput((input, key) => {
    if (key.upArrow && selectedIndex > 0) {
      onSelect(selectedIndex - 1);
    } else if (key.downArrow && selectedIndex < instances.length - 1) {
      onSelect(selectedIndex + 1);
    } else if (key.return) {
      onEnter();
    } else if (input === "r") {
      refresh();
    }
  });

  if (instances.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No instances. Press n to create one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold dimColor>
          {"  "}
          {pad("Name", 20)} {pad("Status", 14)} {pad("Tailscale", 35)}{" "}
          {pad("IP", 16)} {pad("Type", 8)} {pad("Loc", 6)}{" "}
          {pad("Health", 12)}
        </Text>
      </Box>
      {instances.map((inst, i) => (
        <InstanceRow key={inst.id} instance={inst} selected={i === selectedIndex} />
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          {instances.length} instance{instances.length !== 1 ? "s" : ""}
        </Text>
      </Box>
    </Box>
  );
}
