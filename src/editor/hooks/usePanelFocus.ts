import { useEffect, useRef } from 'react';

function isTextEntry(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes(type);
}

/** Non-modal sidebar focus: open to close, Escape only inside the panel, restore opener when we still own focus. */
export function usePanelFocus(onClose: () => void) {
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!isTextEntry(opener)) closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!(event.target instanceof Node) || !panel?.contains(event.target)) return;
      event.preventDefault();
      onCloseRef.current();
    };
    panel?.addEventListener('keydown', onKeyDown);

    return () => {
      panel?.removeEventListener('keydown', onKeyDown);
      const active = document.activeElement;
      const stillInPanel = panel != null && active instanceof Node && panel.contains(active);
      const atRoot = !active || active === document.body;
      if (opener?.isConnected && (stillInPanel || atRoot)) opener.focus();
    };
  }, []);

  return { panelRef, closeButtonRef };
}
