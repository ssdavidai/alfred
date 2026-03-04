import React from "react";
import { Box, Text } from "ink";
import { StatusBadge, HealthBadge } from "./StatusBadge.js";
import type { Instance } from "../data/types.js";

interface Props {
  instance: Instance;
  selected: boolean;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

export function InstanceRow({ instance, selected }: Props) {
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined} bold={selected}>
        {selected ? "> " : "  "}
      </Text>
      <Text bold={selected}>{pad(instance.customer_name, 20)}</Text>
      <Text> </Text>
      <Box width={14}>
        <StatusBadge status={instance.status} />
      </Box>
      <Text> </Text>
      <Text>{pad(instance.tailscale_hostname ?? "--", 35)}</Text>
      <Text> </Text>
      <Text>{pad(instance.ip_address ?? "--", 16)}</Text>
      <Text> </Text>
      <Text>{pad(instance.server_type, 8)}</Text>
      <Text> </Text>
      <Text>{pad(instance.location, 6)}</Text>
      <Text> </Text>
      <Box width={12}>
        <HealthBadge status={instance.last_health_status} />
      </Box>
    </Box>
  );
}
