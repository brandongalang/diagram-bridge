import { applyOps, canonicalJson, documentToOps, LIMITS } from '../../core/index.js';
import type { DiagramDocument, DraftState, Operation, PendingSaveRequest } from '../types.js';

export type { PendingSaveRequest };

export type SavePayload =
  | { kind: 'noop' }
  | { kind: 'fresh'; request: PendingSaveRequest }
  | { kind: 'replay'; request: PendingSaveRequest };

export type PollDecision = 'ignore' | 'refresh' | 'conflict';

export function copyTitle(title: string): string {
  const suffix = ' (Copy)';
  let prefix = '';
  for (const character of title) {
    if (prefix.length + character.length > LIMITS.MAX_TITLE_LENGTH - suffix.length) break;
    prefix += character;
  }
  return `${prefix.trimEnd()}${suffix}`;
}

function generateRequestId(): string {
  return `req_${Math.random().toString(36).substring(2, 10)}`;
}

export function editableContent(doc: DiagramDocument): Pick<DiagramDocument, 'title' | 'nodes' | 'edges' | 'notes'> {
  return {
    title: doc.title,
    nodes: doc.nodes,
    edges: doc.edges,
    notes: doc.notes
  };
}

export function documentsHaveSameContent(a: DiagramDocument, b: DiagramDocument): boolean {
  try {
    return canonicalJson(editableContent(a)) === canonicalJson(editableContent(b));
  } catch {
    return false;
  }
}

export function sessionIsDirty(
  baseline: DiagramDocument | null,
  working: DiagramDocument,
  pending: PendingSaveRequest | null
): boolean {
  if (pending && pending.operations.length > 0) return true;
  if (!baseline) return false;
  return !documentsHaveSameContent(working, baseline);
}

export function submittedWorkingForSave(
  payload: Extract<SavePayload, { kind: 'fresh' | 'replay' }>,
  baseline: DiagramDocument,
  working: DiagramDocument
): DiagramDocument {
  if (payload.kind === 'replay') {
    return applyOps(baseline, payload.request.operations);
  }
  return working;
}

export function documentWithLiveIdentity(
  content: DiagramDocument,
  live: DiagramDocument
): DiagramDocument {
  const next: DiagramDocument = {
    ...content,
    schemaVersion: live.schemaVersion,
    documentId: live.documentId,
    revision: live.revision
  };
  if (live.lineage) {
    next.lineage = live.lineage;
  } else {
    delete next.lineage;
  }
  return next;
}

export type PersistAttempt = {
  ok: boolean;
  persisted: boolean;
  quotaExceeded: boolean;
  error?: string;
};

export function persistAttemptFromStorage(res: { quotaExceeded?: boolean; error?: string }): PersistAttempt {
  if (res.error) {
    return {
      ok: false,
      persisted: false,
      quotaExceeded: Boolean(res.quotaExceeded),
      error: res.error
    };
  }
  return { ok: true, persisted: true, quotaExceeded: false };
}

export function applyInFlightEdits(
  submittedWorking: DiagramDocument,
  latestWorking: DiagramDocument,
  savedDocument: DiagramDocument
): { document: DiagramDocument; hasInFlightEdits: boolean } {
  if (documentsHaveSameContent(submittedWorking, latestWorking)) {
    return { document: savedDocument, hasInFlightEdits: false };
  }

  const inflightOps = documentToOps(submittedWorking, latestWorking);
  if (inflightOps.length === 0) {
    return { document: savedDocument, hasInFlightEdits: false };
  }

  return {
    document: applyOps(savedDocument, inflightOps),
    hasInFlightEdits: true
  };
}

export function resolveSavePayload(
  pending: PendingSaveRequest | null,
  baseline: DiagramDocument,
  working: DiagramDocument,
  author: string,
  createRequestId: () => string = generateRequestId
): SavePayload {
  if (baseline.documentId !== working.documentId) throw new Error('Save snapshots must belong to the same diagram.');
  if (pending && pending.operations.length > 0) {
    return { kind: 'replay', request: pending };
  }

  if (documentsHaveSameContent(baseline, working)) {
    return { kind: 'noop' };
  }

  const operations = documentToOps(baseline, working);
  if (operations.length === 0) {
    return { kind: 'noop' };
  }

  return {
    kind: 'fresh',
    request: {
      requestId: createRequestId(),
      baseRevision: baseline.revision,
      operations,
      author,
      summary: `Saved ${operations.length} changes`
    }
  };
}

export function shouldKeepPendingAfterError(err: { status?: number; code?: string; message?: string }): boolean {
  const status = err.status;
  if (status === 400 || status === 404 || status === 409) {
    return false;
  }
  if (err.code === 'STALE_REVISION_CONFLICT' || err.code === 'VALIDATION_ERROR' || err.code === 'NOT_FOUND') {
    return false;
  }
  return true;
}

export function pollDecision(opts: {
  isExport: boolean;
  saveInFlight: boolean;
  expectedDocId: string;
  currentDocId: string;
  headRevision: number;
  baselineRevision: number;
  hasUnsavedEdits: boolean;
}): PollDecision {
  if (opts.isExport || opts.saveInFlight) return 'ignore';
  if (!opts.expectedDocId || opts.expectedDocId !== opts.currentDocId) return 'ignore';
  if (opts.headRevision <= opts.baselineRevision) return 'ignore';
  return opts.hasUnsavedEdits ? 'conflict' : 'refresh';
}

export function shouldApplyAsyncResult(opts: { expectedDocId: string; currentDocId: string }): boolean {
  return Boolean(opts.expectedDocId) && opts.expectedDocId === opts.currentDocId;
}

export function pendingRequestFromDraft(draft: DraftState | null | undefined): PendingSaveRequest | null {
  if (!draft) return null;
  if (draft.pendingRequest && draft.pendingRequest.operations.length > 0) {
    return draft.pendingRequest;
  }
  if (draft.pendingRequestId && draft.pendingOperations && draft.pendingOperations.length > 0) {
    return {
      requestId: draft.pendingRequestId,
      baseRevision: draft.baseRevision,
      operations: draft.pendingOperations,
      ...(draft.pendingAuthor ? { author: draft.pendingAuthor } : {}),
      ...(draft.pendingSummary ? { summary: draft.pendingSummary } : {})
    };
  }
  return null;
}

export function buildDraftState(input: {
  baseRevision: number;
  document: DiagramDocument;
  pendingRequest?: PendingSaveRequest | null;
  timestamp?: number;
}): DraftState {
  const pending = input.pendingRequest ?? undefined;
  return {
    baseRevision: input.baseRevision,
    document: input.document,
    timestamp: input.timestamp ?? Date.now(),
    ...(pending
      ? {
          pendingRequest: pending,
          pendingRequestId: pending.requestId,
          pendingOperations: pending.operations,
          pendingAuthor: pending.author,
          pendingSummary: pending.summary
        }
      : {})
  };
}

export function revertOperations(baseline: DiagramDocument, target: DiagramDocument): Operation[] {
  return documentToOps(baseline, target);
}
