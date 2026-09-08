import { useState, useCallback, useEffect, useRef } from 'react';
import { documentWithLiveIdentity } from '../storage/session.js';
import type { DiagramDocument } from '../types.js';

interface HistoryState {
  past: DiagramDocument[];
  present: DiagramDocument;
  future: DiagramDocument[];
}

const MAX_HISTORY = 50;

export function useUndoRedo(initialDocument: DiagramDocument, options?: { enableShortcuts?: boolean; canEdit?: () => boolean }) {
  const canEditRef = useRef(options?.canEdit);
  canEditRef.current = options?.canEdit;
  const enableShortcuts = options?.enableShortcuts !== false;
  const [state, setState] = useState<HistoryState>({
    past: [],
    present: initialDocument,
    future: []
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const resetDocument = useCallback((doc: DiagramDocument) => {
    setState({
      past: [],
      present: doc,
      future: []
    });
  }, []);

  const updateDocument = useCallback(
    (updater: (prev: DiagramDocument) => DiagramDocument, recordHistory = true) => {
      setState((prev) => {
        const next = updater(prev.present);
        if (next === prev.present) return prev;

        if (!recordHistory) {
          return {
            ...prev,
            present: next
          };
        }

        const newPast = [...prev.past, prev.present];
        if (newPast.length > MAX_HISTORY) {
          newPast.shift();
        }

        return {
          past: newPast,
          present: next,
          future: [] // clear redo stack on new modification
        };
      });
    },
    []
  );

  const undo = useCallback(() => {
    setState((prev) => {
      if (prev.past.length === 0) return prev;
      const previous = prev.past[prev.past.length - 1];
      const newPast = prev.past.slice(0, prev.past.length - 1);
      return {
        past: newPast,
        present: documentWithLiveIdentity(previous, prev.present),
        future: [prev.present, ...prev.future]
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((prev) => {
      if (prev.future.length === 0) return prev;
      const next = prev.future[0];
      const newFuture = prev.future.slice(1);
      return {
        past: [...prev.past, prev.present],
        present: documentWithLiveIdentity(next, prev.present),
        future: newFuture
      };
    });
  }, []);

  // Keyboard shortcut binding
  useEffect(() => {
    if (!enableShortcuts) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (canEditRef.current && !canEditRef.current()) return;
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (!mod) return;

      // Ignore when focused in text editing fields
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, enableShortcuts]);

  return {
    document: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    undo,
    redo,
    updateDocument,
    resetDocument
  };
}
