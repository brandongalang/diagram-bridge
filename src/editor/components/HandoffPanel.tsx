import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardCopy, X } from 'lucide-react';
import { buildHandoff, type HandoffContext } from '../handoff.js';
import { usePanelFocus } from '../hooks/usePanelFocus.js';
import type { DiagramDocument } from '../types.js';

interface Props {
  document: DiagramDocument;
  context: HandoffContext;
  hasUnsavedEdits: boolean;
  onClose: () => void;
}

export function HandoffPanel({ document, context, hasUnsavedEdits, onClose }: Props) {
  const key = `diagram_handoff:${context.workspacePath}:${document.documentId}`;
  const [previous] = useState<number | undefined>(() => {
    try { return Number(localStorage.getItem(key)) || undefined; } catch { return undefined; }
  });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const text = useMemo(() => buildHandoff(document, context, previous), [document, context, previous]);
  const { panelRef, closeButtonRef } = usePanelFocus(onClose);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const copy = async () => {
    const instructions = text;
    const revision = document.revision;
    const storageKey = key;
    try {
      await navigator.clipboard.writeText(instructions);
      if (!mountedRef.current) return;
      setCopied(true);
      setCopyError('');
      try { localStorage.setItem(storageKey, String(revision)); } catch { /* Copy works without a remembered baseline. */ }
    } catch {
      if (!mountedRef.current) return;
      setCopied(false);
      setCopyError('Select the instructions below and copy them manually.');
      const field = instructionsRef.current;
      if (field && panelRef.current?.contains(field.ownerDocument.activeElement)) {
        field.focus();
        field.select();
      }
    }
  };
  return <aside ref={panelRef} className="handoff-panel" aria-label="Agent handoff">
    <div className="inspector-header">
      <strong>Hand off to your agent</strong>
      <button type="button" className="tool-rail-btn" ref={closeButtonRef} aria-label="Close agent handoff" onClick={onClose}><X size={17} /></button>
    </div>
    <div className="handoff-content">
      <p>Paste these instructions into your agent conversation. Your agent can read the saved diagram, review the notes, and preview its edits.</p>
      <div className="handoff-revision">Saved revision {document.revision}{previous && previous < document.revision ? ` · changes since revision ${previous}` : ''}</div>
      {hasUnsavedEdits && <p className="handoff-pending" role="status">Save your draft before copying a handoff so your agent sees all your edits.</p>}
      <button type="button" className="btn btn-primary" onClick={copy} disabled={hasUnsavedEdits}>
        {copied ? <Check size={16} /> : <ClipboardCopy size={16} />}{copied ? 'Copied — paste into your agent' : 'Copy agent instructions'}
      </button>
      {copyError && <p role="alert">{copyError}</p>}
      <textarea ref={instructionsRef} className="handoff-instructions" aria-label="Agent instructions" value={text} readOnly spellCheck={false} />
      <p className="field-hint" role="status" aria-live="polite" aria-atomic="true">
        {copied ? `Revision ${document.revision} copied. Your agent runs when you send it the instructions.` : 'Copying keeps the handoff under your control. Your agent runs when you send it the instructions.'}
      </p>
    </div>
  </aside>;
}
