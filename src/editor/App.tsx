import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api, initializeAuthToken, ApiError } from './api/client.js';
import { draftStorage } from './storage/drafts.js';
import {
  applyInFlightEdits,
  buildDraftState,
  copyTitle,
  documentsHaveSameContent,
  pendingRequestFromDraft,
  persistAttemptFromStorage,
  pollDecision,
  resolveSavePayload,
  revertOperations,
  sessionIsDirty,
  shouldApplyAsyncResult,
  shouldKeepPendingAfterError,
  submittedWorkingForSave,
  type PendingSaveRequest
} from './storage/session.js';
import { useUndoRedo } from './history/useUndoRedo.js';
import { Canvas } from './components/Canvas.js';
import { HandoffPanel } from './components/HandoffPanel.js';
import type { HandoffContext } from './handoff.js';
import { TopBar, resolveAuthorForNewRequest } from './components/TopBar.js';
import { ToolRail } from './components/ToolRail.js';
import { Inspector } from './components/Inspector.js';
import { HistoryPanel } from './components/HistoryPanel.js';
import { ConflictBanner } from './components/ConflictBanner.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { applyOps } from '../core/index.js';
import type {
  DiagramDocument,
  DocumentSummary,
  SelectedElement,
  SaveStatus,
  NodeKind,
  Anchor,
} from './types.js';
import { Loader2, AlertCircle } from 'lucide-react';

function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).substring(2, 10)}`;
}

export function App() {
  // Query parameters & mode detection
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const isExport = query.get('export') === '1';
  const initialDocId = query.get('document');
  const targetRevision = query.get('revision') ? parseInt(query.get('revision')!, 10) : undefined;

  // Initialize auth token from URL fragment
  useEffect(() => {
    initializeAuthToken();
  }, []);

  const [handoffContext, setHandoffContext] = useState<HandoffContext | null>(null);
  const [isHandoffOpen, setIsHandoffOpen] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [currentDocId, setCurrentDocId] = useState<string>(initialDocId || '');
  const [author, setAuthor] = useState<string>('human');

  // Document states
  const [baselineDocument, setBaselineDocument] = useState<DiagramDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);
  const [savePersistError, setSavePersistError] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);

  // Undo/Redo & current working document
  const modalOpenRef = useRef(false);

  const dummyDoc: DiagramDocument = useMemo(
    () => ({
      schemaVersion: 1,
      documentId: 'initial',
      revision: 1,
      title: 'Loading...',
      nodes: [],
      edges: [],
      notes: []
    }),
    []
  );

  const {
    document: workingDoc,
    canUndo,
    canRedo,
    undo,
    redo,
    updateDocument,
    resetDocument
  } = useUndoRedo(dummyDoc, {
    enableShortcuts: !isExport && !loading,
    canEdit: () => !loadingRef.current && !saveInFlightRef.current && !modalOpenRef.current
  });

  // Save & conflict states
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [pendingRequest, setPendingRequest] = useState<PendingSaveRequest | null>(null);
  const [remoteConflictRevision, setRemoteConflictRevision] = useState<number | null>(null);

  const workingDocRef = useRef(workingDoc);
  const baselineRef = useRef<DiagramDocument | null>(null);
  const currentDocIdRef = useRef(currentDocId);
  const workspaceIdRef = useRef(workspaceId);
  const pendingRequestRef = useRef<PendingSaveRequest | null>(null);
  const saveInFlightRef = useRef(false);
  const loadingRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const authorRef = useRef(author);

  workingDocRef.current = workingDoc;
  baselineRef.current = baselineDocument;
  currentDocIdRef.current = currentDocId;
  workspaceIdRef.current = workspaceId;
  pendingRequestRef.current = pendingRequest;
  authorRef.current = author;

  // UI panels
  const [selectedElement, setSelectedElement] = useState<SelectedElement>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(true);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [fitViewCounter, setFitViewCounter] = useState<number>(0);

  // Modals
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    isDestructive?: boolean;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const openConfirmModal = useCallback((
    config: Omit<typeof modalState, 'isOpen'>
  ) => {
    modalOpenRef.current = true;
    setModalState({ ...config, isOpen: true });
  }, []);

  const closeConfirmModal = useCallback(() => {
    modalOpenRef.current = false;
    setModalState((m) => ({ ...m, isOpen: false }));
  }, []);

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const hasContentEdits = useMemo(() => {
    if (!baselineDocument) return false;
    return !documentsHaveSameContent(workingDoc, baselineDocument);
  }, [workingDoc, baselineDocument]);

  const hasUnsavedEdits = hasContentEdits || pendingRequest !== null;

  const persistCurrentDraft = useCallback(
    (overrides?: {
      workspaceId?: string;
      docId?: string;
      baseline?: DiagramDocument | null;
      working?: DiagramDocument;
      pending?: PendingSaveRequest | null;
    }) => {
      if (isExport) return { ok: true, persisted: false, quotaExceeded: false };
      const ws = overrides?.workspaceId ?? workspaceIdRef.current;
      const docId = overrides?.docId ?? currentDocIdRef.current;
      const baseline = overrides?.baseline ?? baselineRef.current;
      const working = overrides?.working ?? workingDocRef.current;
      const pending = overrides?.pending !== undefined ? overrides.pending : pendingRequestRef.current;
      if (!ws || !docId || !baseline || !working) {
        if (pending || working) {
          return { ok: false, persisted: false, quotaExceeded: false, error: 'Cannot persist the current draft.' };
        }
        return { ok: true, persisted: false, quotaExceeded: false };
      }
      if (baseline.documentId !== docId || working.documentId !== docId) {
        return { ok: false, persisted: false, quotaExceeded: false, error: 'Draft document does not match the open document.' };
      }

      if (!pending && documentsHaveSameContent(working, baseline)) {
        draftStorage.clearDraft(ws, docId);
        return { ok: true, persisted: false, quotaExceeded: false };
      }

      const res = draftStorage.saveDraft(
        ws,
        docId,
        buildDraftState({
          baseRevision: baseline.revision,
          document: working,
          pendingRequest: pending
        })
      );

      const attempt = persistAttemptFromStorage(res);
      if (!attempt.ok) {
        showToast(attempt.error || 'Local draft storage failed. Changes may not persist.', 'error');
      }

      return attempt;
    },
    [isExport, showToast]
  );

  // Update save status when edits change
  useEffect(() => {
    if (isExport) return;
    if (saveInFlightRef.current || saveStatus === 'saving') return;

    if (hasUnsavedEdits) {
      if (saveStatus !== 'error') {
        setSaveStatus('unsaved');
      }
    } else {
      setSaveStatus('saved');
    }
  }, [hasUnsavedEdits, isExport, saveStatus]);

  // Persist draft to local storage on edits
  useEffect(() => {
    persistCurrentDraft();
  }, [workingDoc, baselineDocument, hasUnsavedEdits, currentDocId, workspaceId, pendingRequest, persistCurrentDraft]);

  const loadDocument = useCallback(
    async (
      docId: string,
      options?: { revision?: number; workspaceId?: string; skipDraft?: boolean }
    ) => {
      const sequence = ++loadSequenceRef.current;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      const workspace = options?.workspaceId ?? workspaceIdRef.current;
      const commitLoaded = (baseline: DiagramDocument, working: DiagramDocument, pending: PendingSaveRequest | null) => {
        if (sequence !== loadSequenceRef.current) return false;
        if (baseline.documentId !== docId || working.documentId !== docId) throw new Error('The server returned a different diagram.');
        baselineRef.current = baseline;
        workingDocRef.current = working;
        currentDocIdRef.current = docId;
        pendingRequestRef.current = pending;
        setCurrentDocId(docId);
        setBaselineDocument(baseline);
        resetDocument(working);
        setPendingRequest(pending);
        setSaveStatus(sessionIsDirty(baseline, working, pending) ? 'unsaved' : 'saved');
        setSelectedElement(null);
        setEditorEpoch(value => value + 1);
        setRemoteConflictRevision(null);
        setSavePersistError(null);
        const url = new URL(window.location.href);
        url.searchParams.set('document', docId);
        window.history.replaceState(null, '', url.toString());
        return true;
      };
      try {
        if (!isExport && !options?.skipDraft) {
          const recovered = draftStorage.loadDraft(workspace, docId);
          if (recovered.malformed) showToast(recovered.error || 'Could not read the recovered draft.', 'error');
          if (recovered.data) {
            const draft = recovered.data;
            // An exact baseline is necessary to preserve the meaning of a pending retry.
            const baseline = (await api.getDocument(docId, draft.baseRevision)).document;
            const pending = pendingRequestFromDraft(draft);
            if (!commitLoaded(baseline, draft.document, pending)) return false;
            showToast(pending ? 'Recovered draft. Retry Save to confirm the previous request.' : 'Recovered unsaved draft.', 'info');
            return true;
          }
        }
        const loaded = (await api.getDocument(docId, options?.revision)).document;
        return commitLoaded(loaded, loaded, null);
      } catch (err: unknown) {
        if (sequence !== loadSequenceRef.current) return false;
        const message = err instanceof Error ? err.message : 'Unable to load this diagram.';
        if (isExport) (window as any).__DIAGRAM_ERROR__ = message;
        setError(message);
        return false;
      } finally {
        if (sequence === loadSequenceRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [isExport, resetDocument, showToast]
  );

  // Initial bootstrap
  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const boot = await api.getBootstrap();
        if (!active) return;
        setWorkspaceId(boot.workspaceId);
        if (boot.workspacePath && boot.cliPath) setHandoffContext({ workspacePath: boot.workspacePath, cliPath: boot.cliPath });
        workspaceIdRef.current = boot.workspaceId;
        setDocuments(boot.documents);

        if (isExport) {
          if (!initialDocId) {
            const message = 'Export requires a document query parameter.';
            (window as any).__DIAGRAM_ERROR__ = message;
            setError(message);
            setLoading(false);
            return;
          }
          setCurrentDocId(initialDocId);
          currentDocIdRef.current = initialDocId;
          await loadDocument(initialDocId, {
            revision: targetRevision,
            workspaceId: boot.workspaceId,
            skipDraft: true
          });
          return;
        }

        let selectedId = initialDocId;
        if (!selectedId && boot.documents.length > 0) {
          selectedId = boot.documents[0].documentId;
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.set('document', selectedId);
          window.history.replaceState(null, '', newUrl.toString());
        }

        if (selectedId) {
          setCurrentDocId(selectedId);
          currentDocIdRef.current = selectedId;
          await loadDocument(selectedId, {
            revision: targetRevision,
            workspaceId: boot.workspaceId
          });
        } else {
          const created = await api.createDocument('Classification Pipeline');
          if (!active) return;
          setCurrentDocId(created.document.documentId);
          currentDocIdRef.current = created.document.documentId;
          setBaselineDocument(created.document);
          resetDocument(created.document);
          setPendingRequest(null);
          setDocuments([
            {
              documentId: created.document.documentId,
              title: created.document.title,
              revision: created.document.revision,
              updatedAt: new Date().toISOString()
            }
          ]);
          const newUrl = new URL(window.location.href);
          newUrl.searchParams.set('document', created.document.documentId);
          window.history.replaceState(null, '', newUrl.toString());
          loadingRef.current = false;
          setLoading(false);
        }
      } catch (err: any) {
        if (!active) return;
        if (isExport) {
          (window as any).__DIAGRAM_ERROR__ = err.message || 'Bootstrap failed';
        }
        setError(err.message || 'Bootstrap failed');
        loadingRef.current = false;
        setLoading(false);
      }
    }

    bootstrap();

    return () => {
      active = false;
    };
  }, []);

  // Remote head polling (only when visible and not in export mode)
  useEffect(() => {
    if (isExport) return;

    const interval = setInterval(async () => {
      if (document.visibilityState !== 'visible' || loadingRef.current) return;
      const docId = currentDocIdRef.current;
      const baseline = baselineRef.current;
      if (!docId || !baseline || saveInFlightRef.current) return;

      try {
        const head = await api.getHead(docId);
        if (loadingRef.current) return;
        const firstDecision = pollDecision({
          isExport,
          saveInFlight: saveInFlightRef.current,
          expectedDocId: docId,
          currentDocId: currentDocIdRef.current,
          headRevision: head.revision,
          baselineRevision: baselineRef.current?.revision ?? baseline.revision,
          hasUnsavedEdits: sessionIsDirty(
            baselineRef.current,
            workingDocRef.current,
            pendingRequestRef.current
          )
        });

        if (firstDecision === 'refresh') {
          const fresh = await api.getDocument(docId);
          if (loadingRef.current) return;
          const latestDecision = pollDecision({
            isExport,
            saveInFlight: saveInFlightRef.current,
            expectedDocId: docId,
            currentDocId: currentDocIdRef.current,
            headRevision: fresh.document.revision,
            baselineRevision: baselineRef.current?.revision ?? baseline.revision,
            hasUnsavedEdits: sessionIsDirty(
              baselineRef.current,
              workingDocRef.current,
              pendingRequestRef.current
            )
          });
          if (latestDecision === 'ignore') {
            return;
          }
          if (latestDecision === 'conflict') {
            setRemoteConflictRevision(fresh.document.revision);
            return;
          }
          setBaselineDocument(fresh.document);
          resetDocument(fresh.document);
          setPendingRequest(null);
          setRemoteConflictRevision(null);
          setEditorEpoch(value => value + 1);
          setSaveStatus('saved');
          setDocuments(items => items.map(item => item.documentId === docId ? { ...item, title: fresh.document.title, revision: fresh.document.revision } : item));
          showToast(`Document refreshed to Revision ${fresh.document.revision}.`, 'info');
        } else if (firstDecision === 'conflict') {
          if (shouldApplyAsyncResult({ expectedDocId: docId, currentDocId: currentDocIdRef.current })) {
            setRemoteConflictRevision(head.revision);
          }
        }
      } catch {
        // Suppress background polling network glitches
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [isExport, resetDocument, showToast]);

  const navigateToDocument = useCallback(
    (newId: string) => {
      if (saveInFlightRef.current || loadingRef.current) {
        showToast('Wait for this operation to finish before switching diagrams.', 'info');
        return;
      }
      const persist = persistCurrentDraft();
      if (!persist.ok) {
        showToast(persist.error || 'Could not persist the current draft. Staying on this document.', 'error');
        return;
      }
      void loadDocument(newId, { workspaceId: workspaceIdRef.current });
    },
    [loadDocument, persistCurrentDraft, showToast]
  );

  // Atomic Save operation
  const handleSave = useCallback(async () => {
    if (isExport || saveInFlightRef.current || loadingRef.current) return;
    if (modalOpenRef.current) return;
    const baseline = baselineRef.current;
    const workingAtClick = workingDocRef.current;
    const docId = currentDocIdRef.current;
    if (!baseline || !docId) return;
    if (baseline.documentId !== docId || workingAtClick.documentId !== docId) {
      showToast('Wait for the selected diagram to finish loading before saving.', 'error');
      return;
    }

    const pending = pendingRequestRef.current;
    let authorForRequest = authorRef.current;
    if (!pending) {
      const resolvedAuthor = resolveAuthorForNewRequest(authorRef.current);
      if (!resolvedAuthor.ok) return;
      authorForRequest = resolvedAuthor.author;
      if (authorForRequest !== authorRef.current) {
        authorRef.current = authorForRequest;
        setAuthor(authorForRequest);
      }
    }

    let payload;
    try {
      payload = resolveSavePayload(pending, baseline, workingAtClick, authorForRequest);
    } catch (err: any) {
      showToast(`Validation error: ${err.message}`, 'error');
      setSaveStatus('error');
      return;
    }

    if (payload.kind === 'noop') {
      resetDocument(baseline);
      setSaveStatus('saved');
      return;
    }

    let submitted = workingAtClick;
    try {
      submitted = submittedWorkingForSave(payload, baseline, workingAtClick);
    } catch (err: any) {
      showToast(`Validation error: ${err.message}`, 'error');
      setSaveStatus('error');
      return;
    }

    const request = payload.request;
    saveInFlightRef.current = true;
    setPendingRequest(request);
    pendingRequestRef.current = request;
    setSaveStatus('saving');
    const persist = persistCurrentDraft({
      docId,
      baseline,
      working: workingAtClick,
      pending: request
    });

    if (!persist.ok) {
      saveInFlightRef.current = false;
      setSaveStatus('error');
      setSavePersistError(
        `${persist.error ?? 'Could not store this save locally.'} The revision was not sent to the server. Export JSON, then retry.`
      );
      return;
    }
    setSavePersistError(null);

    try {
      const res = await api.apply(docId, {
        baseRevision: request.baseRevision,
        requestId: request.requestId,
        operations: request.operations,
        author: request.author,
        summary: request.summary
      });

      const stillOnDoc = shouldApplyAsyncResult({
        expectedDocId: docId,
        currentDocId: currentDocIdRef.current
      });

      if (!stillOnDoc) {
        draftStorage.clearDraft(workspaceIdRef.current, docId);
        return;
      }

      const rebased = applyInFlightEdits(submitted, workingDocRef.current, res.document);
      setBaselineDocument(res.document);
      setRemoteConflictRevision(null);
      resetDocument(rebased.document);
      setPendingRequest(null);
      pendingRequestRef.current = null;

      if (rebased.hasInFlightEdits) {
        persistCurrentDraft({
          docId,
          baseline: res.document,
          working: rebased.document,
          pending: null
        });
        setSaveStatus('unsaved');
        showToast(`Saved Revision ${res.document.revision}. Further pending edits present.`, 'info');
      } else {
        draftStorage.clearDraft(workspaceIdRef.current, docId);
        setSaveStatus('saved');
        showToast(`Revision ${res.document.revision} saved successfully.`, 'success');
      }

      setDocuments((prev) =>
        prev.map((d) =>
          d.documentId === res.document.documentId
            ? { ...d, revision: res.document.revision, title: res.document.title }
            : d
        )
      );
    } catch (err: any) {
      const keepPending = shouldKeepPendingAfterError(err);
      if (!keepPending) {
        setPendingRequest(null);
        pendingRequestRef.current = null;
        persistCurrentDraft({
          docId,
          baseline,
          working: workingDocRef.current,
          pending: null
        });
      }

      if (shouldApplyAsyncResult({ expectedDocId: docId, currentDocId: currentDocIdRef.current })) {
        setSaveStatus('error');
        if (err instanceof ApiError && (err.status === 409 || err.code === 'STALE_REVISION_CONFLICT')) {
          try {
            const head = await api.getHead(docId);
            setRemoteConflictRevision(head.revision);
          } catch {
            setRemoteConflictRevision(baseline.revision + 1);
          }
          showToast(`Save conflict: ${err.message}. Draft preserved.`, 'error');
        } else {
          showToast(`Save failed: ${err.message}. Click Save to retry.`, 'error');
        }
      }
    } finally {
      saveInFlightRef.current = false;
    }
  }, [isExport, persistCurrentDraft, resetDocument, showToast]);

  // Global Ctrl/Cmd+S keyboard shortcut
  useEffect(() => {
    if (isExport) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key === 's') {
        e.preventDefault();
        if (modalOpenRef.current) return;
        void handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, isExport]);

  // Switch Document
  const handleSelectDocument = (newId: string) => {
    if (newId === currentDocId) return;

    if (hasUnsavedEdits) {
      openConfirmModal({
        title: 'Unsaved Changes',
        message: 'You have unsaved changes in this diagram. Switching documents will preserve your draft in local storage. Switch now?',
        confirmLabel: 'Switch Document',
        onConfirm: () => {
          closeConfirmModal();
          navigateToDocument(newId);
        }
      });
      return;
    }

    navigateToDocument(newId);
  };

  // Create Document
  const handleCreateDocument = async () => {
    const title = prompt('Enter new diagram title:', 'New Process Diagram');
    if (!title || !title.trim()) return;

    const create = async () => {
      if (saveInFlightRef.current || loadingRef.current) {
        showToast('Wait for the current save to finish before creating a document.', 'info');
        return;
      }
      const persist = persistCurrentDraft();
      if (!persist.ok) {
        showToast(persist.error || 'Could not persist the current draft. Create cancelled.', 'error');
        return;
      }
      saveInFlightRef.current = true;
      try {
        const created = await api.createDocument(title.trim());
        setDocuments((prev) => [
          ...prev,
          {
            documentId: created.document.documentId,
            title: created.document.title,
            revision: created.document.revision,
            updatedAt: new Date().toISOString()
          }
        ]);
        setCurrentDocId(created.document.documentId);
        currentDocIdRef.current = created.document.documentId;
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('document', created.document.documentId);
        window.history.replaceState(null, '', newUrl.toString());
        setBaselineDocument(created.document);
        resetDocument(created.document);
        setPendingRequest(null);
        pendingRequestRef.current = null;
        setRemoteConflictRevision(null);
        setSaveStatus('saved');
        showToast(`Created "${created.document.title}".`, 'success');
      } catch (err: any) {
        showToast(`Failed to create document: ${err.message}`, 'error');
      } finally {
        saveInFlightRef.current = false;
      }
    };

    if (hasUnsavedEdits) {
      openConfirmModal({
        title: 'Unsaved Changes',
        message: 'You have unsaved changes in this diagram. Creating a document will preserve your draft in local storage. Continue?',
        confirmLabel: 'Create Document',
        onConfirm: () => {
          closeConfirmModal();
          void create();
        }
      });
      return;
    }

    await create();
  };

  // Save as copy
  const handleSaveAsCopy = async () => {
    if (saveInFlightRef.current || loadingRef.current) {
      showToast('Wait for the current save to finish before copying.', 'info');
      return;
    }
    const persist = persistCurrentDraft();
    if (!persist.ok) {
      showToast(persist.error || 'Could not persist the current draft. Copy cancelled.', 'error');
      return;
    }
    saveInFlightRef.current = true;
    setIsCopying(true);
    const newTitle = copyTitle(workingDocRef.current.title);
    try {
      const created = await api.createDocument(newTitle, workingDocRef.current);
      setDocuments((prev) => [
        ...prev,
        {
          documentId: created.document.documentId,
          title: created.document.title,
          revision: created.document.revision,
          updatedAt: new Date().toISOString()
        }
      ]);
      setCurrentDocId(created.document.documentId);
      currentDocIdRef.current = created.document.documentId;
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('document', created.document.documentId);
      window.history.replaceState(null, '', newUrl.toString());
      setBaselineDocument(created.document);
      resetDocument(created.document);
      setPendingRequest(null);
      pendingRequestRef.current = null;
      setSaveStatus('saved');
      setRemoteConflictRevision(null);
      setSavePersistError(null);
      setSelectedElement(null);
      showToast(`Saved as copy "${created.document.title}".`, 'success');
    } catch (err: any) {
      showToast(`Failed to copy document: ${err.message}`, 'error');
    } finally {
      saveInFlightRef.current = false;
      setIsCopying(false);
    }
  };

  // Download draft JSON
  const handleDownloadDraft = () => {
    draftStorage.downloadDraftJson(workingDoc);
    showToast('Draft downloaded as JSON.', 'info');
  };

  // Discard local changes and reload
  const handleDiscardChanges = () => {
    openConfirmModal({
      title: 'Discard Unsaved Changes',
      message: 'Are you sure you want to discard your local edits? This cannot be undone.',
      confirmLabel: 'Discard Changes',
      isDestructive: true,
      onConfirm: async () => {
        closeConfirmModal();
        const docId = currentDocIdRef.current;
        if (saveInFlightRef.current || loadingRef.current) return;
        const loaded = await loadDocument(docId, { workspaceId: workspaceIdRef.current, skipDraft: true });
        if (loaded) {
          draftStorage.clearDraft(workspaceIdRef.current, docId);
          setSavePersistError(null);
          showToast('Local changes discarded.', 'info');
        }
      }
    });
  };

  // Forward Revert to Revision R
  const handleRevert = (targetRev: number) => {
    openConfirmModal({
      title: `Revert to Revision ${targetRev}`,
      message: `Restore Revision ${targetRev} as a saved revision? This replaces the current draft.`,
      confirmLabel: `Revert to Rev ${targetRev}`,
      isDestructive: true,
      onConfirm: async () => {
        closeConfirmModal();
        const baseline = baselineRef.current;
        const docId = currentDocIdRef.current;
        if (!baseline || !docId || saveInFlightRef.current) return;
        const persist = persistCurrentDraft();
        if (!persist.ok) {
          showToast(persist.error || 'Could not persist the current draft. Revert cancelled.', 'error');
          return;
        }
        const resolvedAuthor = resolveAuthorForNewRequest(authorRef.current);
        if (!resolvedAuthor.ok) return;
        saveInFlightRef.current = true;
        try {
          const target = await api.getDocument(docId, targetRev);
          if (!shouldApplyAsyncResult({ expectedDocId: docId, currentDocId: currentDocIdRef.current })) {
            return;
          }
          const ops = revertOperations(baseline, target.document);
          if (ops.length === 0) {
            showToast(`Revision ${targetRev} already matches the current baseline.`, 'info');
            return;
          }
          const request: PendingSaveRequest = {
            requestId: generateId('req'),
            baseRevision: baseline.revision,
            operations: ops,
            author: resolvedAuthor.author,
            summary: `Reverted to revision ${targetRev}`
          };
          const submitted = applyOps(baseline, ops);
          resetDocument(submitted);
          workingDocRef.current = submitted;
          setPendingRequest(request);
          pendingRequestRef.current = request;
          setSaveStatus('saving');
          const pendingPersist = persistCurrentDraft({ pending: request, baseline, working: submitted });
          if (!pendingPersist.ok) {
            setSaveStatus('error');
            setSavePersistError(`${pendingPersist.error ?? 'Could not store this change locally.'} Export JSON to keep a copy, then retry saving.`);
            return;
          }
          setSavePersistError(null);
          const res = await api.apply(docId, request);
          if (!shouldApplyAsyncResult({ expectedDocId: docId, currentDocId: currentDocIdRef.current })) {
            return;
          }
          const rebased = applyInFlightEdits(submitted, workingDocRef.current, res.document);
          setBaselineDocument(res.document);
          setRemoteConflictRevision(null);
          resetDocument(rebased.document);
          setPendingRequest(null);
          pendingRequestRef.current = null;
          persistCurrentDraft({ baseline: res.document, working: rebased.document, pending: null });
          setSaveStatus(rebased.hasInFlightEdits ? 'unsaved' : 'saved');
          setIsHistoryOpen(false);
          setDocuments((prev) =>
            prev.map((d) =>
              d.documentId === res.document.documentId
                ? { ...d, revision: res.document.revision, title: res.document.title }
                : d
            )
          );
          showToast(`Reverted to Revision ${targetRev}. Committed as Rev ${res.document.revision}.`, 'success');
        } catch (err: any) {
          if (!shouldKeepPendingAfterError(err)) {
            setPendingRequest(null);
            pendingRequestRef.current = null;
            persistCurrentDraft({ pending: null });
          }
          setSaveStatus('error');
          showToast(`Revert failed: ${err.message}`, 'error');
        } finally {
          saveInFlightRef.current = false;
        }
      }
    });
  };

  // Graph Manipulations (using applyOps or immutable updates)
  const handleAddNode = (kind: NodeKind) => {
    const id = generateId('node');
    const label = `New ${kind.charAt(0).toUpperCase() + kind.slice(1)}`;
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'addNode',
          node: { id, kind, label }
        }
      ]);
      updateDocument(() => nextDoc);
      setSelectedElement({ type: 'node', id });
      setIsInspectorOpen(true);
    } catch (err: any) {
      showToast(`Cannot add node: ${err.message}`, 'error');
    }
  };

  const handleUpdateNodePosition = (nodeId: string, pos: { x: number; y: number }) => {
    updateDocument((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === nodeId ? { ...n, layout: { ...n.layout, x: pos.x, y: pos.y } } : n
      )
    }));
  };

  const handleUpdateNode = (
    id: string,
    patch: { label?: string; parentId?: string | null }
  ) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'updateNode',
          id,
          patch
        }
      ]);
      updateDocument(() => nextDoc);
    } catch (err: any) {
      showToast(`Cannot update node: ${err.message}`, 'error');
    }
  };

  const handleRemoveNode = (id: string, cascade: boolean) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'removeNode',
          id,
          cascade
        }
      ]);
      updateDocument(() => nextDoc);
      setSelectedElement(null);
    } catch (err: any) {
      showToast(`Cannot remove node: ${err.message}`, 'error');
    }
  };

  const handleConnect = (connection: any) => {
    const id = generateId('edge');
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'addEdge',
          edge: {
            id,
            source: connection.source,
            target: connection.target
          }
        }
      ]);
      updateDocument(() => nextDoc);
      setSelectedElement({ type: 'edge', id });
      setIsInspectorOpen(true);
    } catch (err: any) {
      showToast(`Cannot connect nodes: ${err.message}`, 'error');
    }
  };

  const handleAddEdge = (source: string, target: string, label?: string) => {
    const id = generateId('edge');
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'addEdge',
          edge: {
            id,
            source,
            target,
            ...(label ? { label } : {})
          }
        }
      ]);
      updateDocument(() => nextDoc);
      setSelectedElement({ type: 'edge', id });
      setIsInspectorOpen(true);
    } catch (err: any) {
      showToast(`Cannot add edge: ${err.message}`, 'error');
    }
  };

  const handleUpdateEdge = (
    id: string,
    patch: { label?: string | null; source?: string; target?: string }
  ) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'updateEdge',
          id,
          patch
        }
      ]);
      updateDocument(() => nextDoc);
    } catch (err: any) {
      showToast(`Cannot update edge: ${err.message}`, 'error');
    }
  };

  const handleRemoveEdge = (id: string) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'removeEdge',
          id
        }
      ]);
      updateDocument(() => nextDoc);
      setSelectedElement(null);
    } catch (err: any) {
      showToast(`Cannot remove edge: ${err.message}`, 'error');
    }
  };

  const handleAddNote = (note: { body: string; author: string; anchor: Anchor }) => {
    const id = generateId('note');
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'addNote',
          note: {
            id,
            body: note.body,
            author: note.author,
            anchor: note.anchor
          }
        }
      ]);
      updateDocument(() => nextDoc);
      return id;
    } catch (err: any) {
      showToast(`Cannot add note: ${err.message}`, 'error');
    }
  };

  const handleUpdateNote = (
    id: string,
    patch: { body?: string; author?: string; anchor?: Anchor }
  ) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'updateNote',
          id,
          patch
        }
      ]);
      updateDocument(() => nextDoc);
    } catch (err: any) {
      showToast(`Cannot update note: ${err.message}`, 'error');
    }
  };

  const handleRemoveNote = (id: string) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'removeNote',
          id
        }
      ]);
      updateDocument(() => nextDoc);
    } catch (err: any) {
      showToast(`Cannot remove note: ${err.message}`, 'error');
    }
  };

  const handleUpdateTitle = (newTitle: string) => {
    try {
      const nextDoc = applyOps(workingDoc, [
        {
          type: 'setTitle',
          title: newTitle
        }
      ]);
      updateDocument(() => nextDoc);
    } catch (err: any) {
      showToast(`Cannot update title: ${err.message}`, 'error');
    }
  };

  // Render Export Mode (Clean, no chrome)
  if (isExport) {
    if (loading) {
      return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff' }}>
          <Loader2 size={32} className="spin" color="#0f766e" />
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ width: '100vw', height: '100vh', padding: '40px', background: '#ffffff', color: '#b91c1c' }}>
          <h2>Export Error</h2>
          <p>{error}</p>
        </div>
      );
    }

    return (
      <div style={{ width: '100vw', height: '100vh', background: '#ffffff', overflow: 'hidden' }}>
        <Canvas
          document={workingDoc}
          selectedElement={null}
          onSelectElement={() => {}}
          onUpdateNodePosition={() => {}}
          onConnect={() => {}}
          isExport={true}
          readOnly={true}
        />
      </div>
    );
  }

  // Loading State
  if (loading && !baselineDocument) {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', gap: '12px' }}>
        <Loader2 size={32} className="spin" color="#0f766e" />
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>
          Loading diagram workspace...
        </span>
      </div>
    );
  }

  // Fatal Error State
  if (error && !baselineDocument) {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', gap: '12px' }}>
        <AlertCircle size={36} color="#b91c1c" />
        <h2 style={{ fontSize: '18px', color: '#0f172a', margin: 0 }}>Unable to Load Diagram</h2>
        <p style={{ fontSize: '13px', color: '#64748b', maxWidth: '400px', textAlign: 'center', margin: 0 }}>
          {error}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="editor-layout">
      {/* Top Header */}
      <TopBar
        key={`${workingDoc.documentId}:${editorEpoch}`}
        title={workingDoc.title}
        onHandoff={handoffContext ? () => { setIsHandoffOpen(value => !value); setIsHistoryOpen(false); } : undefined}
        onTitleChange={handleUpdateTitle}
        revision={baselineDocument?.revision ?? workingDoc.revision}
        saveStatus={saveStatus}
        onSave={handleSave}
        documents={documents}
        currentDocumentId={currentDocId}
        onSelectDocument={handleSelectDocument}
        onCreateDocument={handleCreateDocument}
        onSaveAsCopy={handleSaveAsCopy}
        onDownloadDraft={handleDownloadDraft}
        onDiscardChanges={handleDiscardChanges}
        hasUnsavedEdits={hasUnsavedEdits}
        author={author}
        onAuthorChange={setAuthor}
        disabled={loading || isCopying || saveStatus === 'saving'}
      />

      {/* Conflict Banner */}
      {remoteConflictRevision && (
        <ConflictBanner
          remoteRevision={remoteConflictRevision}
          onSaveAsCopy={handleSaveAsCopy}
          onDownloadDraft={handleDownloadDraft}
          onDiscardAndReload={handleDiscardChanges}
        />
      )}

      {/* Workspace Area */}
      {error && baselineDocument && <div className="operation-error" role="alert">
        <span>Could not load the diagram: {error}. Your open draft is preserved.</span>
        <button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button>
      </div>}
      {savePersistError && <div className="operation-error" role="alert">
        <span>{savePersistError}</span>
        <div className="operation-error-actions">
          <button type="button" className="btn btn-sm" onClick={handleDownloadDraft}>Export JSON</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleSave()}>Retry Save</button>
        </div>
      </div>}
      {loading && baselineDocument && <div className="loading-strip" role="status">Opening diagram…</div>}
      {isCopying && <div className="loading-strip" role="status">Saving a copy…</div>}
      <div className="editor-workspace" inert={loading || isCopying || undefined} aria-busy={loading || isCopying}>
        {/* Left Tool Rail */}
        <ToolRail
          onAddNode={handleAddNode}
          onFitView={() => setFitViewCounter((c) => c + 1)}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          isHistoryOpen={isHistoryOpen}
          onToggleHistory={() => { setIsHistoryOpen((o) => !o); setIsHandoffOpen(false); }}
          isInspectorOpen={isInspectorOpen && !isHandoffOpen && !isHistoryOpen}
          onToggleInspector={() => {
            if (isHandoffOpen || isHistoryOpen) {
              setIsHandoffOpen(false);
              setIsHistoryOpen(false);
              setIsInspectorOpen(true);
            } else setIsInspectorOpen((o) => !o);
          }}
          disabled={loading || isCopying || saveStatus === 'saving'}
        />

        {/* Central Canvas */}
        <Canvas
          document={workingDoc}
          selectedElement={selectedElement}
          onSelectElement={setSelectedElement}
          onUpdateNodePosition={handleUpdateNodePosition}
          onConnect={handleConnect}
          isExport={false}
          onAddFirstNode={() => handleAddNode('step')}
          fitViewTrigger={fitViewCounter}
        />

        {/* Right Collapsible Inspector */}
        {!isHandoffOpen && !isHistoryOpen && <Inspector
          key={`${workingDoc.documentId}:${editorEpoch}`}
          isOpen={isInspectorOpen}
          onToggle={() => setIsInspectorOpen((o) => !o)}
          selectedElement={selectedElement}
          document={workingDoc}
          author={author}
          onUpdateNode={handleUpdateNode}
          onRemoveNode={handleRemoveNode}
          onUpdateEdge={handleUpdateEdge}
          onRemoveEdge={handleRemoveEdge}
          onAddEdge={handleAddEdge}
          onAddNote={handleAddNote}
          onUpdateNote={handleUpdateNote}
          onRemoveNote={handleRemoveNote}
          onDeselect={() => setSelectedElement(null)}
        />}

        {isHandoffOpen && handoffContext && baselineDocument && <HandoffPanel
          key={`${workingDoc.documentId}:${baselineDocument.revision}`}
          document={baselineDocument} context={handoffContext}
          hasUnsavedEdits={hasUnsavedEdits} onClose={() => setIsHandoffOpen(false)}
        />}

        {/* History Drawer */}
        {isHistoryOpen && (
          <HistoryPanel
            documentId={currentDocId || workingDoc.documentId}
            currentRevision={baselineDocument?.revision ?? workingDoc.revision}
            onClose={() => setIsHistoryOpen(false)}
            onRevert={handleRevert}
            disabled={loading || saveStatus === 'saving'}
          />
        )}
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className={`notification-toast ${toast.type}`} role="status">
          {toast.type === 'error' && <AlertCircle size={15} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Confirmation Modal */}
      <ConfirmModal
        isOpen={modalState.isOpen}
        title={modalState.title}
        message={modalState.message}
        confirmLabel={modalState.confirmLabel}
        isDestructive={modalState.isDestructive}
        onConfirm={modalState.onConfirm}
        onCancel={closeConfirmModal}
      />
    </div>
  );
}
