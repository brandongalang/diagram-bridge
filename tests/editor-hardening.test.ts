import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  REVISION_AUTHOR_MAX_LENGTH,
  resolveAuthorForNewRequest,
  revisionAuthorError,
  TopBar
} from '../src/editor/components/TopBar.js';
import { ConfirmModal } from '../src/editor/components/ConfirmModal.js';
import {
  HistoryRevisionEntries
} from '../src/editor/components/HistoryPanel.js';
import { resolveSavePayload, type PendingSaveRequest } from '../src/editor/storage/session.js';
import type { DiagramDocument } from '../src/core/types.js';

function doc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    revision: 1,
    title: 'Pipeline',
    nodes: [],
    edges: [],
    notes: [],
    ...overrides
  };
}

const topBarProps = {
  title: 'Pipeline',
  onTitleChange: () => {},
  revision: 3,
  saveStatus: 'unsaved' as const,
  onSave: () => {},
  documents: [{ documentId: 'doc-1', title: 'Pipeline', revision: 3, updatedAt: '2026-01-01T00:00:00.000Z' }],
  currentDocumentId: 'doc-1',
  onSelectDocument: () => {},
  onCreateDocument: () => {},
  onSaveAsCopy: () => {},
  onDownloadDraft: () => {},
  onDiscardChanges: () => {},
  hasUnsavedEdits: true
};

describe('confirmation semantics', () => {
  test('associates the dialog message and keeps cancel as a sibling action', () => {
    const html = renderToString(
      React.createElement(ConfirmModal, {
        isOpen: true,
        title: 'Discard Unsaved Changes',
        message: 'Are you sure you want to discard your local edits? This cannot be undone.',
        confirmLabel: 'Discard Changes',
        isDestructive: true,
        onConfirm: () => {},
        onCancel: () => {}
      })
    );
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-describedby="modal-message"/);
    assert.match(html, /id="modal-message"/);
    assert.match(html, />Cancel</);
    assert.doesNotMatch(html, /Could not load the diagram/);
  });
});

describe('revision author bounds', () => {
  test('matches the server 1-100 trimmed-character rule and normalizes only new requests', () => {
    assert.equal(REVISION_AUTHOR_MAX_LENGTH, 100);
    assert.equal(revisionAuthorError('human'), null);
    assert.equal(revisionAuthorError('   '), 'Author must be between 1 and 100 characters.');
    assert.equal(revisionAuthorError(''), 'Author must be between 1 and 100 characters.');
    assert.equal(revisionAuthorError('x'.repeat(101)), 'Author must be between 1 and 100 characters.');

    const rejected = resolveAuthorForNewRequest('   ');
    assert.equal(rejected.ok, false);

    const normalized = resolveAuthorForNewRequest('  reviewer  ');
    assert.equal(normalized.ok, true);
    if (normalized.ok) assert.equal(normalized.author, 'reviewer');

    const pending: PendingSaveRequest = {
      requestId: 'req_exact',
      baseRevision: 1,
      operations: [{ type: 'setTitle', title: 'Pending title' }],
      author: 'original-author',
      summary: 'Saved 1 changes'
    };
    const resolved = resolveSavePayload(pending, doc(), doc({ title: 'Local' }), '   ');
    assert.equal(resolved.kind, 'replay');
    if (resolved.kind !== 'replay') return;
    assert.equal(resolved.request.author, 'original-author');
    assert.equal(resolved.request.requestId, 'req_exact');
  });

  test('exposes persistent field-associated author validation without disabling retry', () => {
    const invalid = renderToString(
      React.createElement(TopBar, { ...topBarProps, author: '   ', onAuthorChange: () => {} })
    );
    assert.match(invalid, /class="revision-author-field"/);
    assert.match(invalid, /class="inspector-input revision-author-input"/);
    assert.match(invalid, /maxLength="100"/);
    assert.match(invalid, /aria-invalid="true"/);
    assert.match(invalid, /aria-describedby="revision-author-error"/);
    assert.match(invalid, /id="revision-author-error"/);
    assert.match(invalid, /class="field-error"/);
    assert.match(invalid, /data-testid="save-button"/);
    assert.doesNotMatch(invalid, /save-button"[^>]*disabled/);

    const valid = renderToString(
      React.createElement(TopBar, { ...topBarProps, author: 'human', onAuthorChange: () => {} })
    );
    assert.doesNotMatch(valid, /revision-author-error/);
    assert.doesNotMatch(valid, /aria-invalid/);
  });
});

describe('history revision keyboard target', () => {
  test('uses a native selector button with a sibling revert control', () => {
    const html = renderToString(
      React.createElement(HistoryRevisionEntries, {
        currentRevision: 2,
        selectedRev: 1,
        onSelect: () => {},
        onRevert: () => {},
        revisions: [
          {
            revision: 1,
            author: 'human',
            summary: 'First commit',
            createdAt: '2026-01-02T15:04:00.000Z'
          },
          {
            revision: 2,
            author: 'agent',
            summary: 'Head',
            createdAt: '2026-01-03T15:04:00.000Z'
          }
        ]
      })
    );

    assert.match(html, /class="history-revision-button"/);
    assert.match(html, /aria-label="Revision 1"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /class="history-entry-heading"/);
    assert.match(html, /class="history-entry-meta"/);
    assert.match(html, /class="history-entry-summary"/);
    assert.match(html, /First commit/);
    assert.match(html, /Revert to Rev/);
    assert.match(html, /title="Revert back to revision 1"/);

    const selectorClose = html.indexOf('</button>');
    const revertAt = html.indexOf('Revert to Rev');
    assert.ok(selectorClose > -1 && revertAt > selectorClose);

    const afterFirstButton = html.slice(html.indexOf('history-revision-button'));
    const firstButtonInner = afterFirstButton.slice(0, afterFirstButton.indexOf('</button>'));
    assert.doesNotMatch(firstButtonInner, /Revert to Rev/);
  });
});
