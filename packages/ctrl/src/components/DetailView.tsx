import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { StatusBadge, HealthBadge } from "./StatusBadge.js";
import { ConfirmPrompt } from "./ConfirmPrompt.js";
import { Sparkline } from "./Sparkline.js";
import { getEvents, getLatestHealthChecks, getHealthHistory } from "../db/queries.js";
import { destroy, updateImages } from "../infra/provisioner.js";
import type { Instance, ContainerStatus } from "../data/types.js";

interface Props {
  instance: Instance;
  onBack: () => void;
  onSSH: () => void;
  onOpenClaw: () => void;
  onAlfredTUI: () => void;
  onAlfredLogs: () => void;
  onDevices: () => void;
}

export function DetailView({ instance, onBack, onSSH, onOpenClaw, onAlfredTUI, onAlfredLogs, onDevices }: Props) {
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const events = getEvents(instance.id, 10);
  const healthChecks = getLatestHealthChecks(instance.id, 1);
  const history = getHealthHistory(instance.id, 24);

  const diskData = history
    .map((h) => h.disk_percent)
    .filter((v): v is number => v !== null);
  const memData = history
    .map((h) => h.memory_percent)
    .filter((v): v is number => v !== null);
  const statusData = history.map((h) =>
    h.status === "ok" ? 100 : h.status === "degraded" ? 50 : 0
  );

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      if (confirmDestroy) {
        setConfirmDestroy(false);
      } else {
        onBack();
      }
    } else if (input === "s") {
      onSSH();
    } else if (input === "o") {
      onOpenClaw();
    } else if (input === "a") {
      onAlfredTUI();
    } else if (input === "l") {
      onAlfredLogs();
    } else if (input === "t") {
      const host = instance.tailscale_hostname;
      if (host) {
        setActionLog((prev) => [...prev, `Temporal UI: https://${host}:8233`]);
      } else {
        setActionLog((prev) => [...prev, "Temporal UI: tailscale hostname not available"]);
      }
    } else if (input === "p") {
      onDevices();
    } else if (input === "d") {
      setConfirmDestroy(true);
    } else if (input === "u") {
      setBusy(true);
      updateImages(instance.id, undefined, (msg) =>
        setActionLog((prev) => [...prev, msg])
      )
        .catch((e) => setActionLog((prev) => [...prev, `Error: ${e}`]))
        .finally(() => setBusy(false));
    }
  });

  if (confirmDestroy) {
    return (
      <ConfirmPrompt
        message={`Destroy instance "${instance.customer_name}"? This will delete the server, volume, and all data.`}
        onConfirm={async () => {
          setConfirmDestroy(false);
          setBusy(true);
          try {
            await destroy(instance.id, (msg) =>
              setActionLog((prev) => [...prev, msg])
            );
          } catch (e) {
            setActionLog((prev) => [...prev, `Error: ${e}`]);
          }
          setBusy(false);
        }}
        onCancel={() => setConfirmDestroy(false)}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>{instance.customer_name}</Text>
        <Text> </Text>
        <StatusBadge status={instance.status} />
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Server ID: </Text>
          {instance.server_id ?? "--"}
        </Text>
        <Text>
          <Text bold>IP: </Text>
          {instance.ip_address ?? "--"}
        </Text>
        <Text>
          <Text bold>Tailscale: </Text>
          {instance.tailscale_hostname ?? "--"}
        </Text>
        <Text>
          <Text bold>Tailscale IP: </Text>
          {instance.tailscale_ip ?? "--"}
        </Text>
        <Text>
          <Text bold>Gateway URL: </Text>
          {instance.tailscale_hostname && instance.gateway_token
            ? `https://${instance.tailscale_hostname}/?token=${instance.gateway_token}`
            : "--"}
        </Text>
        <Text>
          <Text bold>Temporal UI: </Text>
          {instance.tailscale_hostname
            ? `https://${instance.tailscale_hostname}:8233`
            : "--"}
        </Text>
        <Text>
          <Text bold>Type: </Text>
          {instance.server_type}
        </Text>
        <Text>
          <Text bold>Location: </Text>
          {instance.location}
        </Text>
        <Text>
          <Text bold>Image SHA: </Text>
          {instance.current_image_sha ?? "--"}
        </Text>
        <Text>
          <Text bold>Created: </Text>
          {instance.created_at}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>
          Health
        </Text>
        <Text>
          <Text bold>Status: </Text>
          <HealthBadge status={instance.last_health_status} />
          <Text>  </Text>
          <Text bold>Last check: </Text>
          {instance.last_health_check ?? "never"}
        </Text>
        {healthChecks[0] && (
          <>
            <Text>
              <Text bold>Disk: </Text>
              {healthChecks[0].disk_percent ?? "--"}%
            </Text>
            <Text>
              <Text bold>Memory: </Text>
              {healthChecks[0].memory_percent ?? "--"}%
            </Text>
          </>
        )}
      </Box>

      {healthChecks[0]?.response_json && (() => {
        let containers: ContainerStatus[] = [];
        try {
          const parsed = JSON.parse(healthChecks[0].response_json);
          containers = parsed.containers ?? [];
        } catch { /* ignore */ }
        if (containers.length === 0) return null;
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold dimColor>Containers</Text>
            {containers.map((c) => {
              const name = c.Service || c.Name;
              const state = c.State;
              const health = c.Health;
              const exitCode = c.ExitCode;
              let color: string = "white";
              let detail = "";
              if (state === "running") {
                color = health === "healthy" ? "green" : health === "starting" ? "yellow" : "green";
                detail = health && health !== "" ? health : "";
              } else if (state === "exited") {
                color = exitCode === 0 ? "gray" : "red";
                detail = `exit(${exitCode})`;
              } else if (state === "restarting") {
                color = "red";
                detail = "restarting";
              }
              return (
                <Text key={name}>
                  <Text>{(name ?? "").padEnd(14)}</Text>
                  <Text color={color}>{(state ?? "").padEnd(12)}</Text>
                  <Text color={color}>{detail}</Text>
                </Text>
              );
            })}
          </Box>
        );
      })()}

      {history.length > 1 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold dimColor>
            Last 24h ({history.length} checks)
          </Text>
          <Sparkline label="Uptime " data={statusData} max={100} color="green" />
          <Sparkline label="Disk   " data={diskData} max={100} color="yellow" warnAbove={80} />
          <Sparkline label="Memory " data={memData} max={100} color="cyan" warnAbove={90} />
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>
          Recent Events
        </Text>
        {events.slice(0, 5).map((e) => (
          <Text key={e.id} wrap="truncate">
            <Text dimColor>{e.created_at}</Text> [{e.event_type}] {e.message}
          </Text>
        ))}
        {events.length === 0 && <Text dimColor>No events</Text>}
      </Box>

      {actionLog.length > 0 && (
        <Box flexDirection="column">
          <Text bold dimColor>
            Action Log
          </Text>
          {actionLog.slice(-5).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
