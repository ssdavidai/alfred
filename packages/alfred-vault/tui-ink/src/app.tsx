/** Root component: screen state machine + input handling. */

import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { StoreContext } from './store.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { WorkerSection } from './components/WorkerSection.js';
import { ActivityStream } from './components/ActivityStream.js';
import { WorkerDetail } from './components/WorkerDetail.js';
import { LogsView } from './components/LogsView.js';
import { MutationsView } from './components/MutationsView.js';
import { ActionsOverlay } from './components/ActionsOverlay.js';
import { ConfirmPrompt } from './components/ConfirmPrompt.js';
import { useLogTailer } from './hooks/useLogTailer.js';
import { useAuditTailer } from './hooks/useAuditTailer.js';
import { useStatePoller } from './hooks/useStatePoller.js';
import { useWorkerStatus } from './hooks/useWorkerStatus.js';
import { useUptime } from './hooks/useUptime.js';
import { useTimeSeries } from './hooks/useTimeSeries.js';
import { TOOLS } from './data/constants.js';

type ViewState =
  | { screen: 'dashboard' }
  | { screen: 'detail'; tool: string }
  | { screen: 'logs' }
  | { screen: 'mutations' };

interface Props {
  dataDir: string;
  version: string;
}

function useScreenSize(): { width: number; height: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });

  React.useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({ width: stdout.columns, height: stdout.rows });
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return size;
}

export function App({ dataDir, version }: Props): React.ReactElement {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  const [view, setView] = useState<ViewState>({ screen: 'dashboard' });
  const [showActions, setShowActions] = useState(false);
  const [showQuit, setShowQuit] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState(0);

  // Confirm prompt state for actions
  const [confirmMessage, setConfirmMessage] = useState('');
  const confirmActionRef = useRef<(() => void) | null>(null);

  // All data hooks (always active)
  const feeds = useLogTailer(dataDir, TOOLS);
  const mutations = useAuditTailer(dataDir);
  const stats = useStatePoller(dataDir);
  const { workers, startedAt } = useWorkerStatus(dataDir);
  const uptime = useUptime(startedAt);
  const timeSeries = useTimeSeries(feeds, mutations);

  const handleConfirm = useCallback((message: string, action: () => void) => {
    setConfirmMessage(message);
    confirmActionRef.current = action;
    setShowActions(false);
  }, []);

  useInput((input, key) => {
    // Confirm prompt active — handle only y/n
    if (confirmMessage) return;
    // Quit confirm and actions have their own useInput
    if (showQuit || showActions) return;

    if (input === 'q') { setShowQuit(true); return; }
    if (input === '?') { setShowActions(true); return; }

    if (key.escape) {
      if (view.screen !== 'dashboard') {
        setView({ screen: 'dashboard' });
      }
      return;
    }

    if (view.screen === 'dashboard') {
      if (key.upArrow) setSelectedWorker(i => Math.max(0, i - 1));
      else if (key.downArrow) setSelectedWorker(i => Math.min(TOOLS.length - 1, i + 1));
      else if (key.return) setView({ screen: 'detail', tool: TOOLS[selectedWorker]! });
      else if (input === 'l') setView({ screen: 'logs' });
      else if (input === 'm') setView({ screen: 'mutations' });
    }
  });

  const storeValue = { feeds, mutations, stats, workers, uptime, version, timeSeries };

  // Layout: header(1) + rule(1) + content + footer(1) = height
  // Dashboard: header(1) + rule(1) + workers(4) + rule(1) + stream(N) + footer(1) → stream = height - 8
  // Detail/logs/mutations: header(1) + rule(1) + content(N) + footer(1) → content = height - 3
  const contentHeight = height - 3; // header + rule + footer
  const streamHeight = height - 8;  // dashboard: header + rule + 4 workers + rule + footer

  return (
    <StoreContext.Provider value={storeValue}>
      <Box flexDirection="column" width={width} height={height}>
        <Header />

        {/* Top separator */}
        <Box paddingX={1}>
          <Text dimColor>{'\u2500'.repeat(Math.max(10, width - 2))}</Text>
        </Box>

        {/* Dashboard view */}
        {view.screen === 'dashboard' && (
          <>
            <WorkerSection selected={selectedWorker} width={width} />
            <Box paddingX={1}>
              <Text dimColor>{'\u2500'.repeat(Math.max(10, width - 2))}</Text>
            </Box>
            <ActivityStream height={streamHeight} width={width} />
          </>
        )}

        {/* Detail view */}
        {view.screen === 'detail' && (
          <WorkerDetail tool={view.tool} height={contentHeight} width={width} />
        )}

        {/* Logs view */}
        {view.screen === 'logs' && (
          <LogsView height={contentHeight} width={width} />
        )}

        {/* Mutations view */}
        {view.screen === 'mutations' && (
          <MutationsView height={contentHeight} width={width} />
        )}

        {/* Footer or confirm prompt */}
        {showQuit ? (
          <ConfirmPrompt
            message="Quit Alfred TUI?"
            onConfirm={() => exit()}
            onCancel={() => setShowQuit(false)}
          />
        ) : confirmMessage ? (
          <ConfirmPrompt
            message={confirmMessage}
            onConfirm={() => {
              const action = confirmActionRef.current;
              setConfirmMessage('');
              confirmActionRef.current = null;
              if (action) action();
            }}
            onCancel={() => {
              setConfirmMessage('');
              confirmActionRef.current = null;
            }}
          />
        ) : (
          <Footer view={view.screen} />
        )}
      </Box>

      {/* Actions overlay */}
      {showActions && (
        <ActionsOverlay
          onClose={() => setShowActions(false)}
          onQuit={() => {
            setShowActions(false);
            setShowQuit(true);
          }}
          onConfirm={handleConfirm}
        />
      )}
    </StoreContext.Provider>
  );
}
