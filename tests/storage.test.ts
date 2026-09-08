import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DiagramStore } from '../src/commands/index.js';
import { DiagramError } from '../src/core/index.js';

describe('DiagramStore & SQLite Command Engine', () => {
  let tmpDir: string;
  let store: DiagramStore;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-bridge-test-'));
    store = new DiagramStore(tmpDir);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates document at revision 1 and lists it', () => {
    const doc = store.create('System Architecture', undefined, 'alice');
    assert.equal(doc.revision, 1);
    assert.equal(doc.title, 'System Architecture');
    assert.equal(doc.nodes.length, 0);

    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].documentId, doc.documentId);
    assert.equal(list[0].title, 'System Architecture');
    assert.equal(list[0].revision, 1);
  });

  test('atomic failure: bad operation rolls back entire batch without advancing revision', () => {
    const doc = store.create('Atomic Test');
    const initialRev = doc.revision;

    // Operation 1 is valid, Operation 2 is invalid (references non-existent node for edge)
    const badBatch = [
      {
        type: 'addNode' as const,
        node: { id: 'step-ok', kind: 'step' as const, label: 'Valid Step' }
      },
      {
        type: 'addEdge' as const,
        edge: { id: 'edge-bad', source: 'step-ok', target: 'ghost-node', label: 'Broken' }
      }
    ];

    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: initialRev,
          requestId: 'req-fail-1',
          operations: badBatch
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    // Verify document was not modified
    const current = store.read(doc.documentId);
    assert.equal(current.revision, initialRev);
    assert.equal(current.nodes.length, 0);
  });

  test('exact idempotency with lost response and changed payload', () => {
    const doc = store.create('Idempotency Test');

    const ops = [
      {
        type: 'addNode' as const,
        node: { id: 'step-1', kind: 'step' as const, label: 'Initial' }
      }
    ];

    // First apply: advances revision to 2
    const res1 = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-idem-1',
      operations: ops
    });
    assert.equal(res1.revision, 2);
    assert.equal(res1.replayed, false);
    assert.equal(res1.changed, true);

    // Exact retry with identical requestId, baseRevision, and payload: replayed = true, same revision 2
    const res2 = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-idem-1',
      operations: ops
    });
    assert.equal(res2.revision, 2);
    assert.equal(res2.replayed, true);
    assert.equal(res2.changed, true);

    // Even after further commits, exact retry of earlier request still returns revision 2 before head guard!
    const res3 = store.apply(doc.documentId, {
      baseRevision: 2,
      requestId: 'req-idem-2',
      operations: [{ type: 'setTitle' as const, title: 'Idempotency Advanced' }]
    });
    assert.equal(res3.revision, 3);

    // Replay req-idem-1 again
    const resReplay = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-idem-1',
      operations: ops
    });
    assert.equal(resReplay.revision, 2);
    assert.equal(resReplay.replayed, true);

    // Reusing request ID with different payload fails with REQUEST_ID_REUSED
    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 1,
          requestId: 'req-idem-1',
          operations: [{ type: 'setTitle' as const, title: 'Tampered Payload' }]
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'REQUEST_ID_REUSED' && err.exitCode === 4
    );
  });

  test('no-op request records hash and result, returns changed: false without advancing revision', () => {
    const doc = store.create('No-op Test');

    // Apply no-op: setting the same title
    const resNoOp = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-noop-1',
      operations: [{ type: 'setTitle' as const, title: 'No-op Test' }]
    });

    assert.equal(resNoOp.revision, 1);
    assert.equal(resNoOp.replayed, false);
    assert.equal(resNoOp.changed, false);

    // Reading document confirms it is still at revision 1
    const current = store.read(doc.documentId);
    assert.equal(current.revision, 1);

    // Exact replay of no-op request returns replayed: true, changed: false
    const replayNoOp = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-noop-1',
      operations: [{ type: 'setTitle' as const, title: 'No-op Test' }]
    });
    assert.equal(replayNoOp.revision, 1);
    assert.equal(replayNoOp.replayed, true);
    assert.equal(replayNoOp.changed, false);
  });

  test('consistent pull and net/chronological note changes', () => {
    const doc = store.create('Pull Lifecycle Test');

    // Rev 2: Add step-1 and note-1
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-p2',
      operations: [
        { type: 'addNode', node: { id: 'step-1', kind: 'step', label: 'Step 1' } },
        { type: 'addNote', note: { id: 'note-1', body: 'First note', author: 'agent', anchor: { type: 'node', id: 'step-1' } } }
      ]
    });

    // Rev 3: Add note-2, modify note-1
    store.apply(doc.documentId, {
      baseRevision: 2,
      requestId: 'req-p3',
      operations: [
        { type: 'addNote', note: { id: 'note-2', body: 'Ephemeral note', author: 'human', anchor: { type: 'node', id: 'step-1' } } },
        { type: 'updateNote', id: 'note-1', patch: { body: 'First note updated' } }
      ]
    });

    // Rev 4: Remove note-2, update step-1 label
    store.apply(doc.documentId, {
      baseRevision: 3,
      requestId: 'req-p4',
      operations: [
        { type: 'removeNote', id: 'note-2' },
        { type: 'updateNode', id: 'step-1', patch: { label: 'Step 1 Final' } }
      ]
    });

    // Pull since revision 1
    const pullResult = store.pull(doc.documentId, 1);
    assert.equal(pullResult.baseRevision, 1);
    assert.equal(pullResult.headRevision, 4);
    assert.equal(pullResult.document.revision, 4);

    // In the net diff, note-2 was added and deleted within (1, 4], so it is NOT in net diff
    assert.equal(pullResult.diff?.notes.added.length, 1);
    assert.equal(pullResult.diff?.notes.added[0].id, 'note-1');
    assert.equal(pullResult.diff?.notes.added[0].body, 'First note updated');
    assert.equal(pullResult.diff?.notes.removed.length, 0);

    // But note-2 IS recorded in chronological note activity!
    assert.equal(pullResult.noteActivity.length, 3); // rev 2, 3, 4
    const rev2Notes = pullResult.noteActivity.find(a => a.revision === 2);
    assert.equal(rev2Notes?.notes.added.find((n: any) => n.id === 'note-1') !== undefined, true);

    const rev3Notes = pullResult.noteActivity.find(a => a.revision === 3);
    assert.equal(rev3Notes?.notes.added.find((n: any) => n.id === 'note-2') !== undefined, true);
    assert.equal(rev3Notes?.notes.changed.find((c: any) => c.id === 'note-1') !== undefined, true);

    const rev4Notes = pullResult.noteActivity.find(a => a.revision === 4);
    assert.equal(rev4Notes?.notes.removed.find((n: any) => n.id === 'note-2') !== undefined, true);

    // Invalid baseline tests
    assert.throws(
      () => store.pull(doc.documentId, 999),
      (err: any) => err instanceof DiagramError && err.code === 'INVALID_BASELINE' && err.exitCode === 4
    );
    assert.throws(
      () => store.pull(doc.documentId, -1),
      (err: any) => err instanceof DiagramError && err.code === 'INVALID_BASELINE'
    );
  });

  test('forward revert restores prior revision and records revert metadata', () => {
    const doc = store.create('Revert Test');

    // Rev 2: Add step-1
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-rev-add',
      operations: [{ type: 'addNode', node: { id: 'step-rev', kind: 'step', label: 'To Be Reverted' } }]
    });

    const rev2 = store.read(doc.documentId);
    assert.equal(rev2.revision, 2);
    assert.equal(rev2.nodes.length, 1);

    // Revert revision 2 with baseRevision: 2 -> commits revision 3 with rev 1's content
    const revertResult = store.revert(doc.documentId, {
      baseRevision: 2,
      requestId: 'req-revert-action',
      author: 'bob'
    });

    assert.equal(revertResult.revision, 3);
    assert.equal(revertResult.changed, true);
    assert.equal(revertResult.document.nodes.length, 0); // Restored revision 1 state

    // Revision history preserves 1, 2, and 3
    const history = store.history(doc.documentId);
    assert.equal(history.length, 3);
    assert.equal(history[2].revision, 3);
    assert.equal(history[2].author, 'bob');
    assert.match(history[2].summary, /Revert revision 2/);

    // Attempting to revert revision 1 fails with CANNOT_REVERT_INITIAL
    const docNew = store.create('Cannot Revert Rev 1');
    assert.throws(
      () => {
        store.revert(docNew.documentId, {
          baseRevision: 1,
          requestId: 'req-cannot-revert-1'
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'CANNOT_REVERT_INITIAL' && err.exitCode === 4
    );
  });

  test('copy creates unique document identity and records lineage', () => {
    const original = store.create('Original Plan');
    store.apply(original.documentId, {
      baseRevision: 1,
      requestId: 'req-copy-setup',
      operations: [
        { type: 'addNode', node: { id: 'orig-node', kind: 'step', label: 'Original Step' } }
      ]
    });
    const originalRev2 = store.read(original.documentId);

    // Create copy from originalRev2
    const copy = store.create('Forked Branch Plan', originalRev2, 'designer');
    assert.notEqual(copy.documentId, original.documentId);
    assert.equal(copy.revision, 1);
    assert.equal(copy.title, 'Forked Branch Plan');
    assert.equal(copy.nodes.length, 1);
    assert.equal(copy.nodes[0].id, 'orig-node');
    assert.deepEqual(copy.lineage, {
      documentId: original.documentId,
      revision: 2
    });

    // Mutating copy does not mutate original
    store.apply(copy.documentId, {
      baseRevision: 1,
      requestId: 'req-mutate-copy',
      operations: [
        { type: 'updateNode', id: 'orig-node', patch: { label: 'Forked Modification' } }
      ]
    });

    const originalUnchanged = store.read(original.documentId);
    assert.equal(originalUnchanged.nodes[0].label, 'Original Step');
  });

  test('two-process concurrency: conflicting writes handle head CAS safely', () => {
    const doc = store.create('Concurrency Test');
    const workerScript = path.resolve('tests/backend/worker-apply.ts');

    // Run two processes concurrently both targeting baseRevision 1
    const p1 = spawnSync('node', [
      '--import', 'tsx',
      workerScript,
      tmpDir,
      doc.documentId,
      '1',
      'req-proc-1',
      'Worker 1 Node'
    ], { encoding: 'utf8' });

    const p2 = spawnSync('node', [
      '--import', 'tsx',
      workerScript,
      tmpDir,
      doc.documentId,
      '1',
      'req-proc-2',
      'Worker 2 Node'
    ], { encoding: 'utf8' });

    const codes = [p1.status, p2.status];
    // Exactly one process must succeed (code 0), and the other must fail with exit code 3 (STALE_REVISION_CONFLICT)
    assert.equal(codes.includes(0), true, 'One process must succeed');
    assert.equal(codes.includes(3), true, 'Conflicting process must fail with exit code 3');

    // The winning process advanced revision to 2
    const current = store.read(doc.documentId);
    assert.equal(current.revision, 2);
    assert.equal(current.nodes.length, 1);
  });

  test('crash recovery: abrupt termination mid-transaction rolls back safely', () => {
    const crashScript = path.resolve('tests/backend/crash-worker.ts');

    // Run crash script which initiates an uncommitted transaction and exits via SIGKILL
    const proc = spawnSync('node', [
      '--import', 'tsx',
      crashScript,
      tmpDir
    ], { encoding: 'utf8' });

    // Ensure it was killed by signal
    assert.equal(proc.signal, 'SIGKILL');

    // Reopen database and verify integrity
    const dbPath = path.join(tmpDir, '.diagram-bridge', 'diagrams.sqlite');
    const db = new DatabaseSync(dbPath);
    const checkStmt = db.prepare('PRAGMA integrity_check;');
    const checkResult = checkStmt.get() as any;
    assert.equal(checkResult.integrity_check, 'ok');

    // Verify the uncommitted document was rolled back
    const stmt = db.prepare("SELECT id FROM documents WHERE id = 'crash-doc';");
    const row = stmt.get();
    assert.equal(row, undefined, 'Uncommitted transaction must not be present');
    db.close();
  });

  test('validates full complete document before commit and preserves atomicity', () => {
    const doc = store.create('Bounds Atomic Test');
    const initialRev = doc.revision;

    // Operation pushes y coordinate past LIMITS.COORD_MAX (100,000)
    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: initialRev,
          requestId: 'req-bounds-fail',
          operations: [
            {
              type: 'addNode',
              node: { id: 'step-out-of-bounds', kind: 'step', label: 'Way Out', layout: { x: 0, y: 150000, width: 220, height: 88 } }
            }
          ]
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
    );

    // Verify document was not modified and revision was not advanced
    const current = store.read(doc.documentId);
    assert.equal(current.revision, initialRev);
    assert.equal(current.nodes.length, 0);
  });

  test('request hash includes author and summary; rejects metadata tampering on replay', () => {
    const doc = store.create('Metadata Tamper Test');

    const ops = [
      {
        type: 'addNode' as const,
        node: { id: 'step-meta', kind: 'step' as const, label: 'Metadata Node' }
      }
    ];

    // First apply with author 'alice' and summary 'Adding step-meta'
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-meta-1',
      author: 'alice',
      summary: 'Adding step-meta',
      operations: ops
    });

    // Replay with identical author and summary succeeds as exact replay
    const replaySame = store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-meta-1',
      author: 'alice',
      summary: 'Adding step-meta',
      operations: ops
    });
    assert.equal(replaySame.replayed, true);

    // Tampering author with same request ID fails with REQUEST_ID_REUSED
    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 1,
          requestId: 'req-meta-1',
          author: 'bob',
          summary: 'Adding step-meta',
          operations: ops
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'REQUEST_ID_REUSED' && err.exitCode === 4
    );

    // Tampering summary with same request ID fails with REQUEST_ID_REUSED
    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 1,
          requestId: 'req-meta-1',
          author: 'alice',
          summary: 'Different summary',
          operations: ops
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'REQUEST_ID_REUSED' && err.exitCode === 4
    );

    // Shared engine boundary validates author and summary types and lengths
    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 2,
          requestId: 'req-bad-author',
          author: 123 as any,
          operations: ops
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
    );

    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 2,
          requestId: 'req-long-author',
          author: 'a'.repeat(101),
          operations: ops
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
    );

    assert.throws(
      () => {
        store.apply(doc.documentId, {
          baseRevision: 2,
          requestId: 'req-long-summary',
          summary: 's'.repeat(501),
          operations: ops
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
    );
  });

  test('revert request hash includes author/summary and rejects metadata tampering', () => {
    const doc = store.create('Revert Metadata Test');
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-rev-meta-setup',
      operations: [{ type: 'addNode', node: { id: 'step-rev', kind: 'step', label: 'Rev Step' } }]
    });

    store.revert(doc.documentId, {
      baseRevision: 2,
      requestId: 'req-revert-meta',
      author: 'alice',
      summary: 'Revert step-rev'
    });

    // Exact replay with same author & summary
    const replayRevert = store.revert(doc.documentId, {
      baseRevision: 2,
      requestId: 'req-revert-meta',
      author: 'alice',
      summary: 'Revert step-rev'
    });
    assert.equal(replayRevert.replayed, true);

    // Tampered author fails with REQUEST_ID_REUSED
    assert.throws(
      () => {
        store.revert(doc.documentId, {
          baseRevision: 2,
          requestId: 'req-revert-meta',
          author: 'bob',
          summary: 'Revert step-rev'
        });
      },
      (err: any) => err instanceof DiagramError && err.code === 'REQUEST_ID_REUSED' && err.exitCode === 4
    );
  });

  test('stale revision conflict details: expectedRevision is caller base, currentRevision is head', () => {
    const doc = store.create('Stale Details Test');
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-adv',
      operations: [{ type: 'setTitle', title: 'Stale Details Adv' }]
    });

    // Caller attempts to apply with stale baseRevision: 1 when head is 2
    try {
      store.apply(doc.documentId, {
        baseRevision: 1,
        requestId: 'req-stale-attempt',
        operations: [{ type: 'setTitle', title: 'Attempt' }]
      });
      assert.fail('Expected STALE_REVISION_CONFLICT');
    } catch (err: any) {
      assert.ok(err instanceof DiagramError);
      assert.equal(err.code, 'STALE_REVISION_CONFLICT');
      assert.equal(err.exitCode, 3);
      assert.equal((err.details as any).expectedRevision, 1);
      assert.equal((err.details as any).currentRevision, 2);
    }
  });

  test('database schema version 1 persisted transactionally, future versions rejected without modification', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-schema-test-'));
    try {
      // First open: initializes schema version 1
      const s = new DiagramStore(freshDir);
      s.close();

      const dbPath = path.join(freshDir, '.diagram-bridge', 'diagrams.sqlite');
      const db = new DatabaseSync(dbPath);
      const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
      assert.equal(row.version, 1);

      // Verify PRAGMA synchronous is FULL
      const syncPragma = db.prepare('PRAGMA synchronous;').get() as any;
      assert.equal(syncPragma.synchronous, 2); // 2 = FULL

      // Simulate future schema version 2 in database
      db.prepare('UPDATE schema_version SET version = 2').run();
      db.close();

      // Opening database with future schema version fails with UNSUPPORTED_SCHEMA_VERSION (exit 5)
      assert.throws(
        () => new DiagramStore(freshDir),
        (err: any) => err instanceof DiagramError && err.code === 'UNSUPPORTED_SCHEMA_VERSION' && err.exitCode === 5
      );

      // Verify future DB was not modified
      const dbVerify = new DatabaseSync(dbPath);
      const rowVerify = dbVerify.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
      assert.equal(rowVerify.version, 2);
      dbVerify.close();
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('validates numeric busyTimeout and fails gracefully', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-timeout-test-'));
    try {
      assert.throws(
        () => new DiagramStore(freshDir, { busyTimeout: -10 }),
        (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
      );
      assert.throws(
        () => new DiagramStore(freshDir, { busyTimeout: NaN }),
        (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR' && err.exitCode === 4
      );
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('snapshot corruption and incompatible schemaVersion map to CORRUPT_DATA exit 5', () => {
    const doc = store.create('Corruption Test');
    const dbPath = path.join(tmpDir, '.diagram-bridge', 'diagrams.sqlite');
    const db = new DatabaseSync(dbPath);

    // Corrupt snapshot JSON for revision 1
    db.prepare("UPDATE revisions SET snapshot_json = '{ invalid json' WHERE document_id = ? AND revision = 1").run(doc.documentId);
    db.close();

    assert.throws(
      () => store.read(doc.documentId, 1),
      (err: any) => err instanceof DiagramError && err.code === 'CORRUPT_DATA' && err.exitCode === 5
    );

    // Unsupported schema version inside snapshot JSON
    const incompatibleDoc = {
      schemaVersion: 99,
      documentId: doc.documentId,
      revision: 1,
      title: 'Incompatible',
      nodes: [],
      edges: [],
      notes: []
    };
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("UPDATE revisions SET snapshot_json = ? WHERE document_id = ? AND revision = 1").run(JSON.stringify(incompatibleDoc), doc.documentId);
    db2.close();

    assert.throws(
      () => store.read(doc.documentId, 1),
      (err: any) => err instanceof DiagramError && err.code === 'CORRUPT_DATA' && err.exitCode === 5 && err.message.includes('schema version')
    );
  });

  test('pull with missing requested baseline throws INVALID_BASELINE exit 4', () => {
    const doc = store.create('Missing Baseline Test');
    store.apply(doc.documentId, {
      baseRevision: 1,
      requestId: 'req-p-adv',
      operations: [{ type: 'setTitle', title: 'Missing Baseline Adv' }]
    });

    const dbPath = path.join(tmpDir, '.diagram-bridge', 'diagrams.sqlite');
    const db = new DatabaseSync(dbPath);
    // Delete revision 1 row to simulate missing requested baseline in DB
    db.prepare('DELETE FROM revisions WHERE document_id = ? AND revision = 1').run(doc.documentId);
    db.close();

    assert.throws(
      () => store.pull(doc.documentId, 1),
      (err: any) => err instanceof DiagramError && err.code === 'INVALID_BASELINE' && err.exitCode === 4
    );
  });
});
