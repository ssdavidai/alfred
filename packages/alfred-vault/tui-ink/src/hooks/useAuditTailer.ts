/** Tail audit log → MutationEntry[]. */

import { useState, useEffect, useRef, useCallback } from 'react';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'fs';
import { join } from 'path';
import type { MutationEntry } from '../data/types.js';
import { parseAuditLine } from '../data/parsers.js';
import { MAX_MUTATIONS } from '../data/constants.js';

export function useAuditTailer(
  dataDir: string,
  intervalMs: number = 2000,
): MutationEntry[] {
  const [mutations, setMutations] = useState<MutationEntry[]>([]);
  const posRef = useRef(0);
  const partialRef = useRef('');
  const mutationsRef = useRef<MutationEntry[]>([]);

  useEffect(() => {
    posRef.current = 0;
    partialRef.current = '';
    mutationsRef.current = [];
    setMutations([]);
  }, [dataDir]);

  const poll = useCallback(() => {
    const auditPath = join(dataDir, 'vault_audit.log');
    if (!existsSync(auditPath)) return;

    let fd: number;
    try {
      fd = openSync(auditPath, 'r');
    } catch {
      return;
    }

    try {
      const stat = fstatSync(fd);
      const size = stat.size;

      if (size < posRef.current) {
        posRef.current = 0;
        partialRef.current = '';
        mutationsRef.current = [];
      }

      if (size <= posRef.current) return;

      const bytesToRead = size - posRef.current;
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, posRef.current);
      posRef.current += bytesRead;

      const chunk = partialRef.current + buf.toString('utf-8', 0, bytesRead);
      const parts = chunk.split('\n');
      partialRef.current = parts.pop() ?? '';

      let changed = false;
      for (const line of parts) {
        const entry = parseAuditLine(line);
        if (entry) {
          mutationsRef.current = [entry, ...mutationsRef.current].slice(0, MAX_MUTATIONS);
          changed = true;
        }
      }

      if (changed) {
        setMutations([...mutationsRef.current]);
      }
    } finally {
      closeSync(fd);
    }
  }, [dataDir]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs]);

  return mutations;
}
