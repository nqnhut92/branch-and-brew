import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = { label: string; run(): void } | 'separator';

export interface MenuRequest {
  x: number;
  y: number;
  items: MenuItem[];
  /** Gets the focus back when the menu closes. */
  returnFocus?: HTMLElement | null;
}

/**
 * A context menu drawn inside the webview. Opens with the first item focused; arrows, Home and
 * End move, Enter or Space runs the item, Escape or a click elsewhere closes it.
 */
export function ContextMenu({ request, onClose }: { request: MenuRequest; onClose(): void }) {
  const ref = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState({ left: request.x, top: request.y });

  const close = () => {
    onClose();
    request.returnFocus?.focus();
  };

  useLayoutEffect(() => {
    const menu = ref.current!;
    // Keep the whole menu inside the window.
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(request.x, window.innerWidth - width - 4)),
      top: Math.max(0, Math.min(request.y, window.innerHeight - height - 4)),
    });
    menu.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [request]);

  useEffect(() => {
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', outside);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = (from: HTMLElement, step: number | 'first' | 'last') => {
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>('[role=menuitem]'));
    const index = step === 'first' ? 0 : step === 'last' ? items.length - 1
      : (items.indexOf(from) + step + items.length) % items.length;
    items[index]?.focus();
  };

  return (
    <ul className="menu" role="menu" ref={ref} style={position} onContextMenu={(e) => e.preventDefault()}>
      {request.items.map((item, i) => item === 'separator'
        ? <li key={i} role="separator" />
        : (
          <li
            key={i} role="menuitem" tabIndex={-1}
            onClick={() => { close(); item.run(); }}
            onMouseEnter={(e) => e.currentTarget.focus()}
            onKeyDown={(e) => {
              const keys: Record<string, () => void> = {
                ArrowDown: () => move(e.currentTarget, 1),
                ArrowUp: () => move(e.currentTarget, -1),
                Home: () => move(e.currentTarget, 'first'),
                End: () => move(e.currentTarget, 'last'),
                Enter: () => { close(); item.run(); },
                ' ': () => { close(); item.run(); },
                Escape: close,
                Tab: close,
              };
              const action = keys[e.key];
              if (action) { e.preventDefault(); e.stopPropagation(); action(); }
            }}
          >{item.label}</li>
        ))}
    </ul>
  );
}

/** True for the keyboard ways of asking for a context menu: the Menu key and Shift+F10. */
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
