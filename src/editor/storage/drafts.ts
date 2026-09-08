import { validateDocument, validateOperations } from '../../core/index.js';
import type { DiagramDocument, DraftState, PendingSaveRequest } from '../types.js';

function getStorageKey(workspaceId: string, docId: string): string {
  return `diagram_draft:${workspaceId || 'default'}:${docId}`;
}

export interface StorageResult<T> {
  data: T | null;
  quotaExceeded?: boolean;
  malformed?: boolean;
  error?: string;
  warning?: string;
  raw?: string;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function malformedResult(raw: string, warning: string): StorageResult<DraftState> {
  return { data: null, malformed: true, warning, error: warning, raw };
}

function parsePendingRequest(
  parsed: Record<string, unknown>,
  draftBaseRevision: number
): { request?: PendingSaveRequest; warning?: string } {
  if (parsed.pendingRequest != null) {
    if (typeof parsed.pendingRequest !== 'object' || parsed.pendingRequest === null) {
      return { warning: 'Draft pending request must be an object.' };
    }
    const pending = parsed.pendingRequest as Record<string, unknown>;
    if (!isNonEmptyString(pending.requestId)) {
      return { warning: 'Draft pending request is missing a requestId.' };
    }
    if (!isPositiveInteger(pending.baseRevision)) {
      return { warning: 'Draft pending request baseRevision must be a positive integer.' };
    }
    if (!Array.isArray(pending.operations)) {
      return { warning: 'Draft pending request operations must be an array.' };
    }
    if (pending.author !== undefined && typeof pending.author !== 'string') {
      return { warning: 'Draft pending request author must be a string.' };
    }
    if (pending.summary !== undefined && typeof pending.summary !== 'string') {
      return { warning: 'Draft pending request summary must be a string.' };
    }
    try {
      const operations = validateOperations(pending.operations);
      return {
        request: {
          requestId: pending.requestId,
          baseRevision: pending.baseRevision,
          operations,
          ...(pending.author !== undefined ? { author: pending.author } : {}),
          ...(pending.summary !== undefined ? { summary: pending.summary } : {})
        }
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid pending operations';
      return { warning: `Draft pending operations failed schema validation: ${message}` };
    }
  }

  if (parsed.pendingRequestId != null || parsed.pendingOperations != null) {
    if (!isNonEmptyString(parsed.pendingRequestId)) {
      return { warning: 'Draft pendingRequestId must be a non-empty string.' };
    }
    if (!Array.isArray(parsed.pendingOperations)) {
      return { warning: 'Draft pendingOperations must be an array.' };
    }
    if (parsed.pendingAuthor !== undefined && typeof parsed.pendingAuthor !== 'string') {
      return { warning: 'Draft pendingAuthor must be a string.' };
    }
    if (parsed.pendingSummary !== undefined && typeof parsed.pendingSummary !== 'string') {
      return { warning: 'Draft pendingSummary must be a string.' };
    }
    try {
      const operations = validateOperations(parsed.pendingOperations);
      return {
        request: {
          requestId: parsed.pendingRequestId,
          baseRevision: draftBaseRevision,
          operations,
          ...(typeof parsed.pendingAuthor === 'string' && parsed.pendingAuthor
            ? { author: parsed.pendingAuthor }
            : {}),
          ...(typeof parsed.pendingSummary === 'string' && parsed.pendingSummary
            ? { summary: parsed.pendingSummary }
            : {})
        }
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid pending operations';
      return { warning: `Draft pending operations failed schema validation: ${message}` };
    }
  }

  return {};
}

export function parseStoredDraft(raw: string, expectedDocId: string): StorageResult<DraftState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'JSON parse error';
    return malformedResult(raw, `Failed to parse recovered draft: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    return malformedResult(raw, 'Malformed draft data found in local storage.');
  }

  const record = parsed as Record<string, unknown>;
  if (!isPositiveInteger(record.baseRevision)) {
    return malformedResult(raw, 'Draft baseRevision must be a positive integer.');
  }

  if (!record.document || typeof record.document !== 'object') {
    return malformedResult(raw, 'Malformed draft data found in local storage.');
  }

  let document: DiagramDocument;
  try {
    document = validateDocument(record.document);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid document';
    return malformedResult(raw, `Draft document failed validation: ${message}`);
  }

  if (document.documentId !== expectedDocId) {
    return malformedResult(raw, `Draft documentId '${document.documentId}' does not match '${expectedDocId}'.`);
  }

  const pendingParsed = parsePendingRequest(record, record.baseRevision);
  if (pendingParsed.warning) {
    return malformedResult(raw, pendingParsed.warning);
  }

  const timestamp = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
    ? record.timestamp
    : Date.now();

  const pending = pendingParsed.request;
  const draft: DraftState = {
    baseRevision: record.baseRevision,
    document,
    timestamp,
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

  return { data: draft };
}

export const draftStorage = {
  saveDraft(workspaceId: string, docId: string, draft: DraftState): StorageResult<void> {
    try {
      const key = getStorageKey(workspaceId, docId);
      const existing = localStorage.getItem(key);
      if (existing && parseStoredDraft(existing, docId).malformed) {
        localStorage.setItem(`${key}:unreadable`, existing);
      }
      const safePayload = {
        baseRevision: draft.baseRevision,
        document: draft.document,
        pendingRequest: draft.pendingRequest,
        pendingRequestId: draft.pendingRequestId,
        pendingOperations: draft.pendingOperations,
        pendingAuthor: draft.pendingAuthor,
        pendingSummary: draft.pendingSummary,
        timestamp: draft.timestamp || Date.now()
      };
      const serialized = JSON.stringify(safePayload);
      localStorage.setItem(key, serialized);
      return { data: null };
    } catch (err: any) {
      const isQuota = err?.name === 'QuotaExceededError' || err?.code === 22 || err?.number === -2147024882;
      return {
        data: null,
        quotaExceeded: isQuota,
        error: isQuota
          ? 'Local draft storage quota exceeded. Changes may not persist across browser reloads.'
          : (err?.message || 'Storage error')
      };
    }
  },

  loadDraft(workspaceId: string, docId: string): StorageResult<DraftState> {
    try {
      const key = getStorageKey(workspaceId, docId);
      const raw = localStorage.getItem(key);
      if (!raw) {
        return { data: null };
      }
      return parseStoredDraft(raw, docId);
    } catch (err: any) {
      return {
        data: null,
        malformed: true,
        warning: `Failed to parse recovered draft: ${err?.message}`,
        error: `Failed to parse recovered draft: ${err?.message}`
      };
    }
  },

  clearDraft(workspaceId: string, docId: string): void {
    try {
      const key = getStorageKey(workspaceId, docId);
      const raw = localStorage.getItem(key);
      if (raw && parseStoredDraft(raw, docId).malformed) return;
      localStorage.removeItem(key);
    } catch (err) {
      console.warn('Failed to clear draft from localStorage:', err);
    }
  },

  downloadDraftJson(doc: DiagramDocument): void {
    const filename = `${doc.title.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}-rev${doc.revision}-draft.json`;
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
};
