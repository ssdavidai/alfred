import React from "react";
import { Text } from "ink";
import { STATUS_COLORS, HEALTH_COLORS } from "../data/constants.js";
import type { InstanceStatus, HealthStatus } from "../data/types.js";

export function StatusBadge({ status }: { status: InstanceStatus }) {
  const color = STATUS_COLORS[status] ?? "white";
  return <Text color={color}>{status}</Text>;
}

export function HealthBadge({ status }: { status: HealthStatus | null }) {
  if (!status) return <Text color="gray">--</Text>;
  const color = HEALTH_COLORS[status] ?? "white";
  return <Text color={color}>{status}</Text>;
}
