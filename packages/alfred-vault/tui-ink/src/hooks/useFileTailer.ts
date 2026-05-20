/** Generic file tailer — tracks position, reads new bytes on interval,
 *  handles file truncation (reset position if file shrinks). */

import { useState, useEffect, useRef } from 'react';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'fs';

export function useFileTailer(filePath: string, intervalMs: number): string[] {
  const [lines, setLines] = useState<string[]>([]);
  const posRef = useRef(0);
  const partialRef = useRef('');

  useEffect(() => {
    posRef.current = 0;
    partialRef.current = '';
    setLines([]);
  }, [filePath]);

  useEffect(() => {
    const poll = () => {
      if (!existsSync(filePath)) return;

      let fd: number;
      try {
        fd = openSync(filePath, 'r');
      } catch {
        return;
      }

      try {
        const stat = fstatSync(fd);
        const size = stat.size;

        // Handle truncation
        if (size < posRef.current) {
          posRef.current = 0;
          partialRef.current = '';
        }

        if (size <= posRef.current) return;

        const bytesToRead = size - posRef.current;
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, posRef.current);
        posRef.current += bytesRead;

        const chunk = partialRef.current + buf.toString('utf-8', 0, bytesRead);
        const parts = chunk.split('\n');
        // Last element may be partial (no trailing newline)
        partialRef.current = parts.pop() ?? '';

        if (parts.length > 0) {
          setLines(parts.filter(l => l.length > 0));
        }
      } finally {
        closeSync(fd);
      }
    };

    const id = setInterval(poll, intervalMs);
    // Initial poll
    poll();
    return () => clearInterval(id);
  }, [filePath, intervalMs]);

  return lines;
}
