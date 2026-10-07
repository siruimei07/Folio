import { useEffect, useRef } from 'react';

/**
 * Puts the focus back once the dialog it is in has gone. React Aria tries first, in the frame after
 * the dialog unmounts, and gives up when the element it came from was replaced meanwhile (Restore
 * turning disabled as its version became the current one, §8.3; a reworded commit's entry, which
 * gets the new id, §9.1); this runs after it. The strict mode's trial unmount schedules nothing that
 * runs.
 */
export function Refocus({ refocus }: { refocus: () => void }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestAnimationFrame(() => {
        if (!mounted.current) refocus();
      });
    };
  }, [refocus]);
  return null;
}
