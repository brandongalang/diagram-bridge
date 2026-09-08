import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramDocument, Operation } from '../src/core/types.js';
import { validateDocument } from '../src/core/index.js';
import {
  documentsHaveSameContent,
  applyInFlightEdits,
  resolveSavePayload,
  shouldKeepPendingAfterError,
  pollDecision,
  shouldApplyAsyncResult,
  pendingRequestFromDraft,
  persistAttemptFromStorage,
  buildDraftState,
  copyTitle,
  revertOperations,
  submittedWorkingForSave,
  documentWithLiveIdentity,
  sessionIsDirty,
  type PendingSaveRequest
} from '../src/editor/storage/session.js';
import { draftStorage, parseStoredDraft } from '../src/editor/storage/drafts.js';

function doc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    revision: 1,
    title: 'Pipeline',
    nodes: [
      { id: 'n1', kind: 'step', label: 'Ingest', layout: { x: 0, y: 0, width: 220, height: 88 } }
    ],
    edges: [],
    notes: [],
    ...overrides
  };
}

test('copy names fit the document title limit and preserve complete Unicode characters', () => {
  assert.equal(copyTitle('Pipeline'), 'Pipeline (Copy)');
  for (const source of ['A'.repeat(200), 'A'.repeat(192) + '🧭'.repeat(4), '🧭'.repeat(100)]) {
    const title = copyTitle(source);
    assert.ok(title.endsWith(' (Copy)'));
    assert.ok(title.length <= 200);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(title)), title);
    assert.doesNotThrow(() => validateDocument(doc({ title })));
  }
});

describe('content dirty detection', () => {
  test('revision and lineage metadata do not mark a document dirty', () => {
    const baseline = doc({ revision: 3, lineage: { documentId: 'src', revision: 2 } });
    const working = doc({ revision: 2 });
    assert.equal(documentsHaveSameContent(baseline, working), true);
  });

  test('title or graph edits mark a document dirty', () => {
    const baseline = doc();
    const working = doc({ title: 'Renamed' });
    assert.equal(documentsHaveSameContent(baseline, working), false);
  });
});

describe('save payload and in-flight rebase', () => {
  test('prefers an exact pending payload over freshly computed operations', () => {
    const baseline = doc({ revision: 4 });
    const working = doc({ revision: 4, title: 'Local title' });
    const pending: PendingSaveRequest = {
      requestId: 'req_exact',
      baseRevision: 4,
      operations: [{ type: 'setTitle', title: 'Pending title' }],
      author: 'human',
      summary: 'Saved 1 changes'
    };
    const resolved = resolveSavePayload(pending, baseline, working, 'other-author');
    assert.equal(resolved.kind, 'replay');
    if (resolved.kind !== 'replay') return;
    assert.deepEqual(resolved.request, pending);
  });

  test('computes a fresh apply payload when no pending replay exists', () => {
    const baseline = doc({ revision: 2 });
    const working = doc({ revision: 2, title: 'Edited' });
    const resolved = resolveSavePayload(null, baseline, working, 'human');
    assert.equal(resolved.kind, 'fresh');
    if (resolved.kind !== 'fresh') return;
    assert.equal(resolved.request.baseRevision, 2);
    assert.equal(resolved.request.author, 'human');
    assert.deepEqual(resolved.request.operations, [{ type: 'setTitle', title: 'Edited' }]);
    assert.match(resolved.request.requestId, /^req_/);
  });

  test('treats metadata-only working documents as a no-op save', () => {
    const baseline = doc({ revision: 5 });
    const working = doc({ revision: 4 });
    const resolved = resolveSavePayload(null, baseline, working, 'human');
    assert.equal(resolved.kind, 'noop');
  });

  test('resets working document to the saved snapshot when nothing changed in flight', () => {
    const submitted = doc({ revision: 2, title: 'Edited' });
    const latest = doc({ revision: 2, title: 'Edited' });
    const saved = doc({ revision: 3, title: 'Edited' });
    const result = applyInFlightEdits(submitted, latest, saved);
    assert.equal(result.hasInFlightEdits, false);
    assert.equal(result.document.revision, 3);
    assert.equal(documentsHaveSameContent(result.document, saved), true);
  });

  test('rebases edits made during the in-flight save onto the saved document', () => {
    const submitted = doc({ revision: 2, title: 'Edited' });
    const latest = doc({ revision: 2, title: 'Edited again' });
    const saved = doc({ revision: 3, title: 'Edited' });
    const result = applyInFlightEdits(submitted, latest, saved);
    assert.equal(result.hasInFlightEdits, true);
    assert.equal(result.document.revision, 3);
    assert.equal(result.document.title, 'Edited again');
  });

  test('replay submitted base is pending ops on baseline so pre-retry edits survive rebase', () => {
    const baseline = doc({ revision: 2, title: 'Pipeline' });
    const pending: PendingSaveRequest = {
      requestId: 'req_retry',
      baseRevision: 2,
      operations: [{ type: 'setTitle', title: 'Edited' }],
      author: 'human',
      summary: 'Saved 1 changes'
    };
    const workingAfterMoreEdits = doc({
      revision: 2,
      title: 'Edited again',
      nodes: [
        ...doc().nodes,
        { id: 'n2', kind: 'step', label: 'After fail', layout: { x: 0, y: 120, width: 220, height: 88 } }
      ]
    });
    const payload = resolveSavePayload(pending, baseline, workingAfterMoreEdits, 'human');
    assert.equal(payload.kind, 'replay');
    if (payload.kind !== 'replay') return;

    const submitted = submittedWorkingForSave(payload, baseline, workingAfterMoreEdits);
    assert.equal(submitted.title, 'Edited');
    assert.equal(submitted.nodes.length, 1);

    const wrongSubmitted = workingAfterMoreEdits;
    const saved = doc({ revision: 3, title: 'Edited' });
    const dropped = applyInFlightEdits(wrongSubmitted, workingAfterMoreEdits, saved);
    assert.equal(dropped.hasInFlightEdits, false);
    assert.equal(dropped.document.nodes.length, 1);

    const kept = applyInFlightEdits(submitted, workingAfterMoreEdits, saved);
    assert.equal(kept.hasInFlightEdits, true);
    assert.equal(kept.document.revision, 3);
    assert.equal(kept.document.title, 'Edited again');
    assert.equal(kept.document.nodes.some((n) => n.id === 'n2'), true);
  });
});

describe('uncertain retry and discard', () => {
  test('keeps the exact pending request after uncertain transport errors', () => {
    assert.equal(shouldKeepPendingAfterError({ message: 'The operation was aborted due to timeout' }), true);
    assert.equal(shouldKeepPendingAfterError({ status: 500, code: 'STORAGE_ERROR' }), true);
    assert.equal(shouldKeepPendingAfterError({ status: 0 }), true);
  });

  test('clears pending replay after certain client failures', () => {
    assert.equal(shouldKeepPendingAfterError({ status: 409, code: 'STALE_REVISION_CONFLICT' }), false);
    assert.equal(shouldKeepPendingAfterError({ status: 400, code: 'VALIDATION_ERROR' }), false);
    assert.equal(shouldKeepPendingAfterError({ status: 404, code: 'NOT_FOUND' }), false);
  });

  test('discarded drafts drop pending replay payloads', () => {
    const draft = buildDraftState({
      baseRevision: 2,
      document: doc({ title: 'Draft' }),
      pendingRequest: {
        requestId: 'req_1',
        baseRevision: 2,
        operations: [{ type: 'setTitle', title: 'Draft' }],
        author: 'human',
        summary: 'Saved 1 changes'
      }
    });
    assert.ok(pendingRequestFromDraft(draft));
    assert.equal(pendingRequestFromDraft(null), null);
  });

  test('reconstructs pending replay from legacy draft fields', () => {
    const pending = pendingRequestFromDraft({
      baseRevision: 6,
      document: doc(),
      pendingRequestId: 'req_legacy',
      pendingOperations: [{ type: 'setTitle', title: 'Legacy' }] as Operation[],
      timestamp: 1
    });
    assert.deepEqual(pending, {
      requestId: 'req_legacy',
      baseRevision: 6,
      operations: [{ type: 'setTitle', title: 'Legacy' }]
    });
  });
});

describe('poll and document-switch races', () => {
  test('ignores poll results during save or after the document changes', () => {
    assert.equal(
      pollDecision({
        isExport: false,
        saveInFlight: true,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-1',
        headRevision: 4,
        baselineRevision: 3,
        hasUnsavedEdits: false
      }),
      'ignore'
    );
    assert.equal(
      pollDecision({
        isExport: false,
        saveInFlight: false,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-2',
        headRevision: 4,
        baselineRevision: 3,
        hasUnsavedEdits: false
      }),
      'ignore'
    );
  });

  test('export mode never polls and async results never apply across document switches', () => {
    assert.equal(
      pollDecision({
        isExport: true,
        saveInFlight: false,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-1',
        headRevision: 9,
        baselineRevision: 1,
        hasUnsavedEdits: false
      }),
      'ignore'
    );
    assert.equal(shouldApplyAsyncResult({ expectedDocId: 'doc-1', currentDocId: 'doc-2' }), false);
    assert.equal(shouldApplyAsyncResult({ expectedDocId: 'doc-1', currentDocId: 'doc-1' }), true);
  });

  test('dirty local work becomes a conflict instead of a refresh', () => {
    assert.equal(
      pollDecision({
        isExport: false,
        saveInFlight: false,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-1',
        headRevision: 5,
        baselineRevision: 3,
        hasUnsavedEdits: true
      }),
      'conflict'
    );
    assert.equal(
      pollDecision({
        isExport: false,
        saveInFlight: false,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-1',
        headRevision: 5,
        baselineRevision: 3,
        hasUnsavedEdits: false
      }),
      'refresh'
    );
  });
});

describe('targeted revert ops', () => {
  test('computes the exact content diff from baseline to a fetched target revision', () => {
    const baseline = doc({
      revision: 4,
      title: 'Later',
      nodes: [
        { id: 'n1', kind: 'step', label: 'Later label', layout: { x: 10, y: 10, width: 220, height: 88 } }
      ]
    });
    const target = doc({
      revision: 2,
      title: 'Earlier',
      nodes: [
        { id: 'n1', kind: 'step', label: 'Earlier label', layout: { x: 0, y: 0, width: 220, height: 88 } }
      ]
    });
    const ops = revertOperations(baseline, target);
    assert.deepEqual(ops, [
      { type: 'setTitle', title: 'Earlier' },
      {
        type: 'updateNode',
        id: 'n1',
        patch: { label: 'Earlier label', layout: { x: 0, y: 0, width: 220, height: 88 } }
      }
    ]);
  });
});

describe('poll recheck after document fetch', () => {
  test('refresh becomes conflict when the person edits during getDocument', () => {
    const beforeFetch = pollDecision({
      isExport: false,
      saveInFlight: false,
      expectedDocId: 'doc-1',
      currentDocId: 'doc-1',
      headRevision: 5,
      baselineRevision: 3,
      hasUnsavedEdits: false
    });
    assert.equal(beforeFetch, 'refresh');

    const afterTyping = pollDecision({
      isExport: false,
      saveInFlight: false,
      expectedDocId: 'doc-1',
      currentDocId: 'doc-1',
      headRevision: 5,
      baselineRevision: 3,
      hasUnsavedEdits: sessionIsDirty(doc({ revision: 3 }), doc({ revision: 3, title: 'Typed during GET' }), null)
    });
    assert.equal(afterTyping, 'conflict');
  });

  test('refresh is ignored if a save starts during getDocument', () => {
    assert.equal(
      pollDecision({
        isExport: false,
        saveInFlight: true,
        expectedDocId: 'doc-1',
        currentDocId: 'doc-1',
        headRevision: 5,
        baselineRevision: 3,
        hasUnsavedEdits: false
      }),
      'ignore'
    );
  });
});

describe('persist storage errors', () => {
  test('non-quota storage errors are not treated as success', () => {
    const quota = persistAttemptFromStorage({
      quotaExceeded: true,
      error: 'Local draft storage quota exceeded. Changes may not persist across browser reloads.'
    });
    assert.equal(quota.ok, false);
    assert.equal(quota.persisted, false);
    assert.equal(quota.quotaExceeded, true);

    const other = persistAttemptFromStorage({ error: 'localStorage is disabled' });
    assert.equal(other.ok, false);
    assert.equal(other.persisted, false);
    assert.equal(other.quotaExceeded, false);
    assert.equal(other.error, 'localStorage is disabled');

    const ok = persistAttemptFromStorage({});
    assert.equal(ok.ok, true);
    assert.equal(ok.persisted, true);
  });
});

describe('draft load validation', () => {
  test('accepts a valid draft with matching documentId and pending operations', () => {
    const raw = JSON.stringify({
      baseRevision: 2,
      timestamp: 10,
      document: doc({ revision: 2, title: 'Draft' }),
      pendingRequest: {
        requestId: 'req_ok',
        baseRevision: 2,
        operations: [{ type: 'setTitle', title: 'Draft' }],
        author: 'human',
        summary: 'Saved 1 changes'
      }
    });
    const result = parseStoredDraft(raw, 'doc-1');
    assert.equal(result.malformed, undefined);
    assert.equal(result.data?.document.title, 'Draft');
    assert.equal(result.data?.pendingRequest?.requestId, 'req_ok');
    assert.equal(result.raw, undefined);
  });

  test('retains raw bytes and warns on malformed nodes, ids, or pending ops', () => {
    const badNode = JSON.stringify({
      baseRevision: 1,
      document: {
        ...doc(),
        nodes: [{ id: 'n1', kind: 'step', label: 'Broken' }]
      }
    });
    const nodeResult = parseStoredDraft(badNode, 'doc-1');
    assert.equal(nodeResult.malformed, true);
    assert.equal(nodeResult.data, null);
    assert.equal(nodeResult.raw, badNode);
    assert.match(nodeResult.warning || '', /validation/i);

    const wrongId = JSON.stringify({
      baseRevision: 1,
      document: doc({ documentId: 'other-doc' })
    });
    const idResult = parseStoredDraft(wrongId, 'doc-1');
    assert.equal(idResult.malformed, true);
    assert.equal(idResult.raw, wrongId);
    assert.match(idResult.warning || '', /does not match/);

    const badBase = JSON.stringify({
      baseRevision: 0,
      document: doc()
    });
    const baseResult = parseStoredDraft(badBase, 'doc-1');
    assert.equal(baseResult.malformed, true);
    assert.equal(baseResult.raw, badBase);

    const badPending = JSON.stringify({
      baseRevision: 1,
      document: doc(),
      pendingRequest: {
        requestId: 'req_bad',
        baseRevision: 1,
        operations: [{ type: 'notARealOp', title: 'nope' }]
      }
    });
    const pendingResult = parseStoredDraft(badPending, 'doc-1');
    assert.equal(pendingResult.malformed, true);
    assert.equal(pendingResult.raw, badPending);
    assert.match(pendingResult.warning || '', /pending operations/i);
  });
});

describe('undo identity', () => {
  test('restored history content keeps live revision and lineage', () => {
    const past = doc({ revision: 2, title: 'Older', lineage: { documentId: 'src', revision: 1 } });
    const live = doc({ revision: 8, title: 'Newer', lineage: { documentId: 'copy', revision: 7 } });
    const restored = documentWithLiveIdentity(past, live);
    assert.equal(restored.title, 'Older');
    assert.equal(restored.revision, 8);
    assert.equal(restored.documentId, 'doc-1');
    assert.deepEqual(restored.lineage, { documentId: 'copy', revision: 7 });
  });
});


test('unreadable draft bytes survive clean refresh and later editing', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const key = 'diagram_draft:workspace:doc-1';
  values.set(key, '{ damaged JSON');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, value: string) => values.set(k, value),
    removeItem: (k: string) => values.delete(k)
  } });
  try {
    draftStorage.clearDraft('workspace', 'doc-1');
    assert.equal(values.get(key), '{ damaged JSON');
    const result = draftStorage.saveDraft('workspace', 'doc-1', buildDraftState({ baseRevision: 1, document: doc() }));
    assert.equal(result.error, undefined);
    assert.equal(values.get(`${key}:unreadable`), '{ damaged JSON');
    assert.ok(parseStoredDraft(values.get(key)!, 'doc-1').data);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});


test('save refuses mismatched document identities even with an exact pending request', () => {
  const baseline = doc();
  const different = doc({ documentId: 'other-diagram' });
  const pending: PendingSaveRequest = { requestId: 'retry', baseRevision: 1, operations: [{type:'setTitle', title:'Changed'}] };
  assert.throws(() => resolveSavePayload(pending, baseline, different, 'human'), /same diagram/);
});
