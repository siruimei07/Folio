import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

/** How far Left and Right move the handle (app-shell handoff §7). */
export const RESIZE_STEP = 16;

export interface ResizeHandleProps {
  /** The panel's width now, and the least and greatest it can take. */
  value: number;
  min: number;
  max: number;
  /** The id of the panel it resizes. */
  controls: string;
  label: string;
  /** A new width, already between `min` and `max`. */
  onChange: (width: number) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
}

/**
 * The handle between the History panel and the diff (app-shell handoff §7): an 8 px focusable
 * `separator` with a 4 × 36 px grip. Dragging it resizes the panel, Left and Right by 16 px, Home
 * and End to the least and greatest width (the WAI-ARIA window splitter), and a double-click resets
 * it.
 */
export function ResizeHandle({ value, min, max, controls, label, onChange, onReset }: ResizeHandleProps) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let width: number;
    switch (event.key) {
      case 'ArrowLeft':
        width = value - RESIZE_STEP;
        break;
      case 'ArrowRight':
        width = value + RESIZE_STEP;
        break;
      case 'Home':
        width = min;
        break;
      case 'End':
        width = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(clamp(width));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    onChange(clamp(start.width + event.clientX - start.x));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onReset}
    >
      <span className="resize-handle__grip" aria-hidden />
    </div>
  );
}
