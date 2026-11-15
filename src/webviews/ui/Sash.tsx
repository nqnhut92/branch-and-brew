import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import './sash.css';

export interface SashProps {
  /** 'horizontal' means horizontal divider line that drags vertically (row-resize). 'vertical' means vertical divider line that drags horizontally (col-resize). */
  orientation: 'horizontal' | 'vertical';
  onMouseDown: (e: ReactMouseEvent) => void;
  className?: string;
  title?: string;
}

export function Sash({ orientation, onMouseDown, className = '', title }: SashProps) {
  return (
    <div
      role="separator"
      tabIndex={-1}
      title={title}
      className={`sash sash-${orientation === 'horizontal' ? 'row' : 'col'} ${className}`}
      onMouseDown={onMouseDown}
    />
  );
}

export function useDragResize(
  initialSize: number,
  storageKey?: string,
  min = 100,
  max = 1200,
  invertDelta = false,
) {
  const [size, setSize] = useState<number>(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const val = Number(stored);
          if (!Number.isNaN(val) && val >= min && val <= max) return val;
        }
      } catch { /* ignored */ }
    }
    return initialSize;
  });

  const onStartResize = useCallback((e: ReactMouseEvent, orientation: 'horizontal' | 'vertical') => {
    e.preventDefault();
    e.stopPropagation();
    const startCoord = orientation === 'horizontal' ? e.clientY : e.clientX;
    const startSize = size;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = orientation === 'horizontal' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    let currentSize = startSize;

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault();
      const currentCoord = orientation === 'horizontal' ? ev.clientY : ev.clientX;
      const rawDelta = currentCoord - startCoord;
      const delta = invertDelta ? -rawDelta : rawDelta;
      const next = Math.max(min, Math.min(max, startSize + delta));
      currentSize = next;
      setSize(next);
    };

    const onMouseUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(currentSize));
        } catch { /* ignored */ }
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [size, min, max, invertDelta, storageKey]);

  return [size, onStartResize] as const;
}
