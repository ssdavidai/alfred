import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { exec as sshExec } from "../infra/ssh.js";
import { DEFAULTS } from "../data/constants.js";
import type { Instance, OpenClawDevice } from "../data/types.js";

interface Props {
  instance: Instance;
  onBack: () => void;
}

const DOCKER_EXEC = `cd ${DEFAULTS.dockerComposeDir} && docker compose exec -T openclaw node openclaw.mjs devices`;

export function DevicesView({ instance, onBack }: Props) {
  const [pending, setPending] = useState<OpenClawDevice[]>([]);
  const [paired, setPaired] = useState<OpenClawDevice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const total = pending.length + paired.length;

  const ssh = useCallback(
    async (command: string) => {
      if (!instance.ip_address || !instance.ssh_key_path) {
        throw new Error("Instance not reachable");
      }
      return sshExec(instance.ip_address, instance.ssh_key_path, command);
    },
    [instance.ip_address, instance.ssh_key_path]
  );

  const listDevices = useCallback(async () => {
    const res = await ssh(`${DOCKER_EXEC} list --json`);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `Exit code ${res.code}`);
    const data = JSON.parse(res.stdout);
    return {
      pending: (data.pending ?? []) as OpenClawDevice[],
      paired: (data.paired ?? []) as OpenClawDevice[],
    };
  }, [ssh]);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listDevices();
      setPending(data.pending);
      setPaired(data.paired);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [listDevices]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const runAction = useCallback(
    async (action: string, id: string, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const res = await ssh(`${DOCKER_EXEC} ${action} ${id}`);
        if (res.code !== 0) {
          setError(res.stderr.trim() || res.stdout.trim() || `Exit code ${res.code}`);
          return;
        }
        await fetchDevices();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [ssh, fetchDevices]
  );

  const selectedDevice = (): OpenClawDevice | null => {
    if (selectedIndex < pending.length) return pending[selectedIndex];
    const pairedIdx = selectedIndex - pending.length;
    if (pairedIdx < paired.length) return paired[pairedIdx];
    return null;
  };

  const isPending = selectedIndex < pending.length;

  useInput((input, key) => {
    if (busy) return;

    if (confirmRemove) {
      if (input === "y") {
        setConfirmRemove(false);
        const dev = selectedDevice();
        if (dev) runAction("remove", dev.deviceId, "Removing...");
      } else {
        setConfirmRemove(false);
      }
      return;
    }

    if (key.escape) {
      onBack();
    } else if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(total - 1, i + 1));
    } else if (input === "a" && isPending) {
      const dev = selectedDevice();
      if (dev?.requestId) runAction("approve", dev.requestId, "Approving...");
    } else if (input === "r" && isPending) {
      const dev = selectedDevice();
      if (dev?.requestId) runAction("reject", dev.requestId, "Rejecting...");
    } else if (input === "x" && !isPending) {
      const dev = selectedDevice();
      if (dev) setConfirmRemove(true);
    } else if (input === "R") {
      fetchDevices();
    }
  });

  if (loading && pending.length === 0 && paired.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>Loading devices...</Text>
      </Box>
    );
  }

  const renderDevice = (dev: OpenClawDevice, index: number) => {
    const isSelected = index === selectedIndex;
    const inPending = index < pending.length;
    const name = dev.displayName || dev.deviceId.slice(0, 16);
    const cursor = isSelected ? "> " : "  ";
    return (
      <Text key={dev.deviceId} color={inPending ? "yellow" : undefined}>
        {cursor}
        {name.padEnd(20)}
        {dev.platform.padEnd(10)}
        {dev.clientMode.padEnd(10)}
        {dev.roles.join(",") || "-"}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {busy && (
        <Box marginBottom={1}>
          <Text color="yellow">{busy}</Text>
        </Box>
      )}

      {confirmRemove && (
        <Box marginBottom={1}>
          <Text color="red">
            Remove device "{selectedDevice()?.displayName || selectedDevice()?.deviceId}"? (y/n)
          </Text>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>
          Pending Requests ({pending.length})
        </Text>
        {pending.length === 0 && <Text dimColor>  None</Text>}
        {pending.map((dev, i) => renderDevice(dev, i))}
      </Box>

      <Box flexDirection="column">
        <Text bold dimColor>
          Paired Devices ({paired.length})
        </Text>
        {paired.length === 0 && <Text dimColor>  None</Text>}
        {paired.map((dev, i) => renderDevice(dev, i + pending.length))}
      </Box>
    </Box>
  );
}
