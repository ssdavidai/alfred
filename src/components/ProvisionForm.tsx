import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { LogViewer } from "./LogViewer.js";
import { useProvision } from "../hooks/useProvision.js";
import { DEFAULTS } from "../data/constants.js";
import type { InstanceConfig } from "../data/types.js";

interface Props {
  onDone: () => void;
  onCancel: () => void;
}

type FormStep =
  | "customer_name"
  | "server_type"
  | "location"
  | "tailscale_authkey"
  | "openrouter_api_key"
  | "confirm"
  | "provisioning";

const STEPS: FormStep[] = [
  "customer_name",
  "server_type",
  "location",
  "tailscale_authkey",
  "openrouter_api_key",
  "confirm",
];

const STEP_LABELS: Record<string, string> = {
  customer_name: "Customer name",
  server_type: "Server type",
  location: "Location",
  tailscale_authkey: "Tailscale auth key",
  openrouter_api_key: "OpenRouter API key (optional, Enter to skip)",
  confirm: "Confirm and provision",
};

export function ProvisionForm({ onDone, onCancel }: Props) {
  const [step, setStep] = useState<FormStep>("customer_name");
  const [input, setInput] = useState("");
  const [config, setConfig] = useState<Partial<InstanceConfig>>({
    server_type: process.env.DEFAULT_SERVER_TYPE ?? DEFAULTS.serverType,
    location: process.env.DEFAULT_LOCATION ?? DEFAULTS.location,
    tailscale_authkey: process.env.TAILSCALE_AUTHKEY,
    openrouter_api_key: process.env.OPENROUTER_API_KEY,
  });
  const { state, isRunning, start } = useProvision();

  useInput((ch, key) => {
    if (key.escape) {
      if (step === "provisioning") return;
      onCancel();
      return;
    }

    if (step === "provisioning") {
      if (state && !isRunning && key.return) {
        onDone();
      }
      return;
    }

    if (step === "confirm") {
      if (ch === "y" || ch === "Y") {
        setStep("provisioning");
        start(config as InstanceConfig);
      } else if (ch === "n" || ch === "N") {
        onCancel();
      }
      return;
    }

    if (key.return) {
      const value = input.trim();
      const stepIndex = STEPS.indexOf(step);

      switch (step) {
        case "customer_name":
          if (!value) return;
          setConfig((c) => ({ ...c, customer_name: value }));
          break;
        case "server_type":
          setConfig((c) => ({ ...c, server_type: value || c.server_type }));
          break;
        case "location":
          setConfig((c) => ({ ...c, location: value || c.location }));
          break;
        case "tailscale_authkey":
          if (!value && !config.tailscale_authkey) return;
          if (value) setConfig((c) => ({ ...c, tailscale_authkey: value }));
          break;
        case "openrouter_api_key":
          if (value) setConfig((c) => ({ ...c, openrouter_api_key: value }));
          break;
      }

      setInput("");
      if (stepIndex < STEPS.length - 1) {
        setStep(STEPS[stepIndex + 1]);
      }
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  if (step === "provisioning") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          {isRunning ? (
            <Text>
              <Spinner type="dots" />{" "}
              Provisioning {config.customer_name}... ({state?.step ?? "starting"})
            </Text>
          ) : state?.error ? (
            <Text color="red">
              Provisioning failed: {state.error}
            </Text>
          ) : (
            <Text color="green">
              Provisioning complete! Press Enter to continue.
            </Text>
          )}
        </Box>
        <LogViewer lines={state?.logs ?? []} />
      </Box>
    );
  }

  if (step === "confirm") {
    return (
      <Box flexDirection="column">
        <Text bold>Provision new instance:</Text>
        <Text>  Customer: {config.customer_name}</Text>
        <Text>  Server: {config.server_type} in {config.location}</Text>
        <Text>  Tailscale key: {config.tailscale_authkey?.slice(0, 10)}...</Text>
        <Text>  OpenRouter key: {config.openrouter_api_key ? "set" : "none (user configures later)"}</Text>
        <Text dimColor>  OpenClaw token: auto-generated per instance</Text>
        <Box marginTop={1}>
          <Text>
            Press <Text bold>y</Text> to confirm, <Text bold>n</Text> to cancel
          </Text>
        </Box>
      </Box>
    );
  }

  const label = STEP_LABELS[step];
  const defaultVal =
    step === "server_type"
      ? config.server_type
      : step === "location"
        ? config.location
        : step === "tailscale_authkey" && config.tailscale_authkey
          ? "(from env)"
          : step === "openrouter_api_key" && config.openrouter_api_key
            ? "(from env)"
            : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>New Instance ({STEPS.indexOf(step) + 1}/{STEPS.length - 1})</Text>
      <Box marginTop={1}>
        <Text>
          {label}
          {defaultVal ? ` [${defaultVal}]` : ""}: {input}
          <Text color="cyan">_</Text>
        </Text>
      </Box>
    </Box>
  );
}
