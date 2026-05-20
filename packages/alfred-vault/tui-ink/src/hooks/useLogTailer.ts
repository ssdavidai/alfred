/** Tail all tool logs → per-tool WorkerFeed + merged FeedEntry[]. */

import { useState, useEffect, useRef, useCallback } from 'react';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'fs';
import { join } from 'path';
import type { FeedEntry, WorkerFeed, ToolHealth } from '../data/types.js';
import { parseLogLine, parseKV } from '../data/parsers.js';
import { INTERPRETERS, updateHealth } from '../data/interpreters.js';
import { MAX_FEED_ENTRIES } from '../data/constants.js';

function emptyFeed(): WorkerFeed {
  return {
    entries: [],
    currentStep: '',
    currentFile: '',
    health: 'idle',
    llmCalls: 0,
    stdoutChars: 0,
    tokens: 0,
    errors: 0,
    warnings: 0,
  };
}

function emptyHealth(): ToolHealth {
  return { errorCount: 0, warningCount: 0, llmCalls: 0, stdoutChars: 0, tokens: 0 };
}

interface TailerState {
  pos: number;
  partial: string;
}

export function useLogTailer(
  dataDir: string,
  tools: string[],
  intervalMs: number = 500,
): Record<string, WorkerFeed> {
  const [feeds, setFeeds] = useState<Record<string, WorkerFeed>>(() => {
    const init: Record<string, WorkerFeed> = {};
    for (const t of tools) init[t] = emptyFeed();
    return init;
  });

  const tailerStateRef = useRef<Record<string, TailerState>>({});
  const healthRef = useRef<Record<string, ToolHealth>>({});
  const feedsRef = useRef<Record<string, WorkerFeed>>({});
  const isFirstPollRef = useRef<Record<string, boolean>>({});

  // Initialize refs
  useEffect(() => {
    const ts: Record<string, TailerState> = {};
    const hs: Record<string, ToolHealth> = {};
    const fs: Record<string, WorkerFeed> = {};
    const fp: Record<string, boolean> = {};
    for (const t of tools) {
      ts[t] = { pos: 0, partial: '' };
      hs[t] = emptyHealth();
      fs[t] = emptyFeed();
      fp[t] = true;
    }
    tailerStateRef.current = ts;
    healthRef.current = hs;
    feedsRef.current = fs;
    isFirstPollRef.current = fp;
  }, [dataDir, tools.join(',')]);

  const poll = useCallback(() => {
    let changed = false;

    for (const tool of tools) {
      const logPath = join(dataDir, `${tool}.log`);
      if (!existsSync(logPath)) continue;

      const state = tailerStateRef.current[tool];
      if (!state) continue;

      let fd: number;
      try {
        fd = openSync(logPath, 'r');
      } catch {
        continue;
      }

      try {
        const stat = fstatSync(fd);
        const size = stat.size;

        if (size < state.pos) {
          state.pos = 0;
          state.partial = '';
        }
        if (size <= state.pos) continue;

        const bytesToRead = size - state.pos;
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, state.pos);
        state.pos += bytesRead;

        const chunk = state.partial + buf.toString('utf-8', 0, bytesRead);
        const parts = chunk.split('\n');
        state.partial = parts.pop() ?? '';

        const newLines = parts.filter(l => l.length > 0);
        if (newLines.length === 0) continue;

        const feed = feedsRef.current[tool] ?? emptyFeed();
        const health = healthRef.current[tool] ?? emptyHealth();
        const interpreter = INTERPRETERS[tool];
        const isFirstPoll = isFirstPollRef.current[tool] ?? false;

        for (const line of newLines) {
          const entry = parseLogLine(line, tool);
          if (!entry) continue;

          updateHealth(health, entry);

          if (!interpreter) continue;
          const kv = parseKV(entry.detail);
          const result = interpreter(entry.event, entry.detail, kv);
          if (!result) continue;

          const [severity, message, step, file] = result;

          // On first poll (backfill), only track step/health but skip feed entries
          if (!isFirstPoll) {
            const fe: FeedEntry = { timestamp: entry.timestamp, severity, message, tool };
            feed.entries = [fe, ...feed.entries].slice(0, MAX_FEED_ENTRIES);
          }

          if (step) feed.currentStep = step;
          if (file) feed.currentFile = file;

          if (severity === 'error') feed.errors++;
          else if (severity === 'warning') feed.warnings++;
        }

        // Sync LLM counters
        feed.llmCalls = health.llmCalls;
        feed.stdoutChars = health.stdoutChars;
        feed.tokens = health.tokens;

        // Compute health
        if (feed.errors >= 5) feed.health = 'failing';
        else if (feed.errors > 0) feed.health = 'degraded';
        else if (feed.currentStep && !['Idle', 'Watching inbox...', 'Watching vault'].includes(feed.currentStep)) {
          feed.health = 'working';
        } else {
          feed.health = 'idle';
        }

        feedsRef.current[tool] = feed;
        healthRef.current[tool] = health;
        if (isFirstPoll) isFirstPollRef.current[tool] = false;
        changed = true;
      } finally {
        closeSync(fd);
      }
    }

    if (changed) {
      setFeeds({ ...feedsRef.current });
    }
  }, [dataDir, tools.join(',')]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);

  return feeds;
}
