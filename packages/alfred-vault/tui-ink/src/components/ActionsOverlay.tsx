/** Borderless actions overlay panel. */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { execSync } from 'child_process';

interface Props {
  onClose: () => void;
  onQuit: () => void;
  onConfirm: (message: string, action: () => void) => void;
}

interface Action {
  key: string;
  label: string;
  command?: string;
  confirm?: string;
}

const ACTIONS: Action[] = [
  { key: 'r', label: 'Restart worker', confirm: 'Restart requires running alfred up again. Continue?' },
  { key: 't', label: 'Trigger curator', command: 'alfred curator' },
  { key: 'w', label: 'Force sweep', command: 'alfred janitor scan' },
  { key: 'e', label: 'Force extraction', command: 'alfred distiller run' },
  { key: 'x', label: 'Refresh stats' },
];

export function ActionsOverlay({ onClose, onQuit, onConfirm }: Props): React.ReactElement {
  const [status, setStatus] = useState('');

  function runCommand(cmd: string, label: string) {
    setStatus(`Running: ${cmd}...`);
    try {
      execSync(cmd, { timeout: 5000, stdio: 'pipe' });
      setStatus(`Done: ${label}`);
    } catch {
      setStatus(`Failed: ${label}`);
    }
    setTimeout(() => setStatus(''), 3000);
  }

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (input === 'q') { onQuit(); return; }

    const action = ACTIONS.find(a => a.key === input);
    if (!action) return;

    if (action.confirm) {
      onConfirm(action.confirm, () => {
        if (action.command) runCommand(action.command, action.label);
      });
      return;
    }

    if (action.command) {
      runCommand(action.command, action.label);
    }
  });

  return (
    <Box
      flexDirection="column"
      position="absolute"
      marginLeft={50}
      marginTop={3}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>Actions</Text>
      <Text> </Text>
      {ACTIONS.map(a => (
        <Box key={a.key}>
          <Text bold color="cyan">{a.key}</Text>
          <Text>  {a.label}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Box>
        <Text bold color="red">q</Text>
        <Text>  Quit Alfred</Text>
      </Box>
      <Box>
        <Text dimColor>Esc  Close</Text>
      </Box>
      {status ? (
        <>
          <Text> </Text>
          <Text dimColor>{status}</Text>
        </>
      ) : null}
    </Box>
  );
}
