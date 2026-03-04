import React, { useState, useCallback } from "react";
import { Box, useInput, useApp as useInkApp } from "ink";
import { AppContext } from "./store.js";
import { Header } from "./components/Header.js";
import { Footer } from "./components/Footer.js";
import { Dashboard } from "./components/Dashboard.js";
import { ProvisionForm } from "./components/ProvisionForm.js";
import { DetailView } from "./components/DetailView.js";
import { DevicesView } from "./components/DevicesView.js";
import { LogViewer } from "./components/LogViewer.js";
import { startHealthMonitor, stopHealthMonitor } from "./monitoring/health.js";
import { listInstances } from "./db/queries.js";
import { getEvents } from "./db/queries.js";
import { DEFAULTS } from "./data/constants.js";
import type { Instance, Screen } from "./data/types.js";
import { spawnSync } from "child_process";

function sshSpawn(instance: Instance, remoteCmd?: string) {
  if (!instance.ip_address || !instance.ssh_key_path) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.unref();
  try {
    const args = [
      "-i", instance.ssh_key_path,
      "-o", "StrictHostKeyChecking=accept-new",
      "-t",
      `deploy@${instance.ip_address}`,
    ];
    if (remoteCmd) args.push(remoteCmd);
    spawnSync("ssh", args, { stdio: "inherit" });
  } catch {
    // User exited
  } finally {
    process.stdin.ref();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  }
}

export function App() {
  const { exit } = useInkApp();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );

  // Start health monitor on mount
  React.useEffect(() => {
    startHealthMonitor();
    return () => stopHealthMonitor();
  }, []);

  const handleEnterDetail = useCallback(() => {
    const instances = listInstances();
    if (instances[selectedIndex]) {
      setSelectedInstance(instances[selectedIndex]);
      setScreen("detail");
    }
  }, [selectedIndex]);

  const handleSSH = useCallback(() => {
    if (!selectedInstance) return;
    sshSpawn(selectedInstance);
  }, [selectedInstance]);

  const handleOpenClaw = useCallback(() => {
    if (!selectedInstance) return;
    sshSpawn(selectedInstance, `cd ${DEFAULTS.dockerComposeDir} && docker compose exec -it openclaw node openclaw.mjs tui`);
  }, [selectedInstance]);

  const handleAlfredTUI = useCallback(() => {
    if (!selectedInstance) return;
    sshSpawn(selectedInstance, `cd ${DEFAULTS.dockerComposeDir} && docker compose exec -it alfred alfred --config /app/data/config.yaml tui`);
  }, [selectedInstance]);

  const handleAlfredLogs = useCallback(() => {
    if (!selectedInstance) return;
    sshSpawn(selectedInstance, `cd ${DEFAULTS.dockerComposeDir} && docker compose logs --tail 100 -f alfred`);
  }, [selectedInstance]);

  // Global keybindings
  useInput((input, key) => {
    if (screen === "dashboard") {
      if (input === "q") {
        stopHealthMonitor();
        exit();
      } else if (input === "n") {
        setScreen("provision");
      }
    }
  });

  const contextValue = {
    screen,
    selectedIndex,
    selectedInstance,
    setScreen,
    setSelectedIndex,
    setSelectedInstance,
  };

  return (
    <AppContext.Provider value={contextValue}>
      <Box flexDirection="column" padding={1}>
        <Header screen={screen} />

        {screen === "dashboard" && (
          <Dashboard
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onEnter={handleEnterDetail}
          />
        )}

        {screen === "provision" && (
          <ProvisionForm
            onDone={() => setScreen("dashboard")}
            onCancel={() => setScreen("dashboard")}
          />
        )}

        {screen === "detail" && selectedInstance && (
          <DetailView
            instance={selectedInstance}
            onBack={() => {
              setSelectedInstance(null);
              setScreen("dashboard");
            }}
            onSSH={handleSSH}
            onOpenClaw={handleOpenClaw}
            onAlfredTUI={handleAlfredTUI}
            onAlfredLogs={handleAlfredLogs}
            onDevices={() => setScreen("devices")}
          />
        )}

        {screen === "devices" && selectedInstance && (
          <DevicesView
            instance={selectedInstance}
            onBack={() => setScreen("detail")}
          />
        )}

        {screen === "logs" && selectedInstance && (
          <Box flexDirection="column">
            <LogViewer
              lines={getEvents(selectedInstance.id, 50).map(
                (e) => `${e.created_at} [${e.event_type}] ${e.message}`
              )}
              title={`Logs: ${selectedInstance.customer_name}`}
            />
          </Box>
        )}

        <Footer screen={screen} />
      </Box>
    </AppContext.Provider>
  );
}
