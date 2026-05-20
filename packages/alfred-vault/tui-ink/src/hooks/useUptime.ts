/** Elapsed time counter. */

import { useState, useEffect } from 'react';

export function useUptime(startedAt: string): string {
  const [display, setDisplay] = useState('0s');

  useEffect(() => {
    if (!startedAt) {
      setDisplay('--');
      return;
    }

    const update = () => {
      const start = new Date(startedAt).getTime();
      if (isNaN(start)) {
        setDisplay('--');
        return;
      }
      const secs = Math.floor((Date.now() - start) / 1000);
      if (secs < 0) {
        setDisplay('0s');
      } else if (secs < 60) {
        setDisplay(`${secs}s`);
      } else if (secs < 3600) {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        setDisplay(`${m}m ${s.toString().padStart(2, '0')}s`);
      } else {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        setDisplay(`${h}h ${m.toString().padStart(2, '0')}m`);
      }
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return display;
}
