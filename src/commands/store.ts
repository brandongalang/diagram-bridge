import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type StorageOptions } from '../storage/db.js';
import { DiagramError } from '../core/errors.js';
import { canonicalJson } from '../core/canonical.js';
import {
  idSchema,
  validateDocument,
  validateOperations,
  LIMITS
} from '../core/schema.js';
import { applyOps } from '../core/graph.js';
import { diffDocuments } from '../core/diff.js';
import type {
  DiagramDocument,
  DocumentSummary,
  ApplyRequest,
  MutationResult,
  PullResult,
  RevisionMeta
} from '../core/types.js';

const MAX_AUTHOR_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 500;

export function validateAndNormalizeAuthor(author?: unknown): string {
  if (author === undefined) {
    return 'agent';
  }
  if (typeof author !== 'string') {
    throw new DiagramError('VALIDATION_ERROR', 'Author must be a string', 4);
  }
  const trimmed = author.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AUTHOR_LENGTH) {
    throw new DiagramError(
      'VALIDATION_ERROR',
      `Author must be between 1 and ${MAX_AUTHOR_LENGTH} characters`,
      4
    );
  }
  return trimmed;
}

export function validateAndNormalizeSummary(summary?: unknown, defaultSummary = ''): string {
  if (summary === undefined) {
    return defaultSummary;
  }
  if (typeof summary !== 'string') {
    throw new DiagramError('VALIDATION_ERROR', 'Summary must be a string', 4);
  }
  const trimmed = summary.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SUMMARY_LENGTH) {
    throw new DiagramError(
      'VALIDATION_ERROR',
      `Summary must be between 1 and ${MAX_SUMMARY_LENGTH} characters`,
      4
    );
  }
  return trimmed;
}

export class DiagramStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(workspaceRoot: string, options?: StorageOptions) {
    this.db = openDatabase(workspaceRoot, options);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DiagramError('STORAGE_ERROR', 'DiagramStore is closed', 5);
    }
  }

  public close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  public list(): DocumentSummary[] {
    this.assertOpen();
    try {
      const stmt = this.db.prepare(
        'SELECT id, title, head_revision, updated_at FROM documents ORDER BY updated_at DESC, id ASC'
      );
      const rows = stmt.all() as any[];
      return rows.map((r) => ({
        documentId: r.id,
        title: r.title,
        revision: r.head_revision,
        updatedAt: r.updated_at,
      }));
    } catch (err: any) {
      if (err instanceof DiagramError) throw err;
      throw new DiagramError('STORAGE_ERROR', `Failed to list documents: ${err.message}`, 5, err);
    }
  }

  public create(title: string, from?: DiagramDocument, author?: string): DiagramDocument {
    this.assertOpen();
    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > LIMITS.MAX_TITLE_LENGTH) {
      throw new DiagramError(
        'VALIDATION_ERROR',
        `Title must be between 1 and ${LIMITS.MAX_TITLE_LENGTH} characters`,
        4
      );
    }

    const cleanTitle = title.trim();
    const docAuthor = validateAndNormalizeAuthor(author);
    const documentId = crypto.randomUUID();
    const now = new Date().toISOString();

    let initialDoc: DiagramDocument;

    if (from) {
      const validatedFrom = validateDocument(from);
      initialDoc = {
        schemaVersion: 1,
        documentId,
        revision: 1,
        title: cleanTitle,
        nodes: validatedFrom.nodes.map((n) => ({ ...n, layout: { ...n.layout } })),
        edges: validatedFrom.edges.map((e) => ({ ...e })),
        notes: validatedFrom.notes.map((n) => ({ ...n, anchor: { ...n.anchor } })),
        lineage: {
          documentId: validatedFrom.documentId,
          revision: validatedFrom.revision,
        },
      };
    } else {
      initialDoc = {
        schemaVersion: 1,
        documentId,
        revision: 1,
        title: cleanTitle,
        nodes: [],
        edges: [],
        notes: [],
      };
    }

    // Validate full complete document before commit
    validateDocument(initialDoc);

    const summary = from
      ? `Created copy from ${from.documentId}@${from.revision}`
      : 'Initial revision';

    const snapshotJson = canonicalJson(initialDoc);

    try {
      this.db.exec('BEGIN IMMEDIATE;');

      const docStmt = this.db.prepare(
        'INSERT INTO documents (id, title, head_revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)'
      );
      docStmt.run(documentId, cleanTitle, now, now);

      const revStmt = this.db.prepare(
        'INSERT INTO revisions (document_id, revision, author, summary, created_at, snapshot_json) VALUES (?, 1, ?, ?, ?, ?)'
      );
      revStmt.run(documentId, docAuthor, summary, now, snapshotJson);

      this.db.exec('COMMIT;');
      return initialDoc;
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      if (err instanceof DiagramError) throw err;
      throw new DiagramError('STORAGE_ERROR', `Failed to create document: ${err.message}`, 5, err);
    }
  }

  public read(id: string, revision?: number): DiagramDocument {
    this.assertOpen();
    const idCheck = idSchema.safeParse(id);
    if (!idCheck.success) {
      throw new DiagramError('NOT_FOUND', `Invalid document ID '${id}'`, 4);
    }

    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
      throw new DiagramError('NOT_FOUND', `Invalid revision ${revision}`, 4);
    }

    try {
      if (revision !== undefined) {
        const stmt = this.db.prepare(
          'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
        );
        const row = stmt.get(id, revision) as any;
        if (!row) {
          throw new DiagramError('NOT_FOUND', `Revision ${revision} of document '${id}' not found`, 4);
        }
        return this.parseSnapshot(row.snapshot_json);
      } else {
        const stmt = this.db.prepare(
          'SELECT r.snapshot_json FROM revisions r JOIN documents d ON d.id = r.document_id AND d.head_revision = r.revision WHERE d.id = ?'
        );
        const row = stmt.get(id) as any;
        if (!row) {
          throw new DiagramError('NOT_FOUND', `Document '${id}' not found`, 4);
        }
        return this.parseSnapshot(row.snapshot_json);
      }
    } catch (err: any) {
      if (err instanceof DiagramError) throw err;
      throw new DiagramError('STORAGE_ERROR', `Failed to read document '${id}': ${err.message}`, 5, err);
    }
  }

  public apply(id: string, request: ApplyRequest): MutationResult {
    this.assertOpen();
    const idCheck = idSchema.safeParse(id);
    if (!idCheck.success) {
      throw new DiagramError('NOT_FOUND', `Invalid document ID '${id}'`, 4);
    }

    const reqIdCheck = idSchema.safeParse(request.requestId);
    if (!reqIdCheck.success) {
      throw new DiagramError('VALIDATION_ERROR', `Invalid requestId '${request.requestId}'`, 4);
    }

    if (!Number.isInteger(request.baseRevision) || request.baseRevision < 1) {
      throw new DiagramError('VALIDATION_ERROR', `Invalid baseRevision ${request.baseRevision}`, 4);
    }

    const validatedOps = validateOperations(request.operations);
    const author = validateAndNormalizeAuthor(request.author);
    const summary = validateAndNormalizeSummary(request.summary, 'Apply operations');

    const payloadHash = crypto
      .createHash('sha256')
      .update(canonicalJson({
        author,
        baseRevision: request.baseRevision,
        operations: validatedOps,
        summary,
      }))
      .digest('hex');

    try {
      this.db.exec('BEGIN IMMEDIATE;');

      // 1. Check idempotency in requests table
      const reqStmt = this.db.prepare(
        'SELECT base_revision, payload_hash, committed_revision, changed FROM requests WHERE document_id = ? AND request_id = ?'
      );
      const recorded = reqStmt.get(id, request.requestId) as any;
      if (recorded) {
        if (recorded.base_revision !== request.baseRevision || recorded.payload_hash !== payloadHash) {
          throw new DiagramError(
            'REQUEST_ID_REUSED',
            `Request ID '${request.requestId}' already used with different payload or base revision`,
            4
          );
        }
        // Exact replay! Fetch recorded committed revision
        const revStmt = this.db.prepare(
          'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
        );
        const revRow = revStmt.get(id, recorded.committed_revision) as any;
        if (!revRow) {
          throw new DiagramError('CORRUPT_DATA', `Snapshot for revision ${recorded.committed_revision} missing`, 5);
        }
        this.db.exec('ROLLBACK;');
        return {
          document: this.parseSnapshot(revRow.snapshot_json),
          revision: recorded.committed_revision,
          replayed: true,
          changed: Boolean(recorded.changed),
        };
      }

      // 2. Fetch document head
      const docStmt = this.db.prepare('SELECT head_revision, title FROM documents WHERE id = ?');
      const docRow = docStmt.get(id) as any;
      if (!docRow) {
        throw new DiagramError('NOT_FOUND', `Document '${id}' not found`, 4);
      }

      // 3. Head revision check: expectedRevision is caller's base, currentRevision is saved head
      if (docRow.head_revision !== request.baseRevision) {
        throw new DiagramError(
          'STALE_REVISION_CONFLICT',
          `Mutation rejected: base revision is stale. Expected ${request.baseRevision}, current head is ${docRow.head_revision}`,
          3,
          {
            documentId: id,
            expectedRevision: request.baseRevision,
            currentRevision: docRow.head_revision,
          }
        );
      }

      // 4. Read base revision snapshot
      const baseRevStmt = this.db.prepare(
        'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
      );
      const baseRow = baseRevStmt.get(id, request.baseRevision) as any;
      if (!baseRow) {
        throw new DiagramError('CORRUPT_DATA', `Baseline revision ${request.baseRevision} snapshot not found`, 5);
      }
      const currentDoc = this.parseSnapshot(baseRow.snapshot_json);

      // 5. Apply operations purely
      const nextDoc = applyOps(currentDoc, validatedOps);

      // 6. Check changes
      const diff = diffDocuments(currentDoc, nextDoc);
      const hasChanges = Boolean(
        diff.title ||
          diff.nodes.added.length > 0 ||
          diff.nodes.removed.length > 0 ||
          diff.nodes.changed.length > 0 ||
          diff.edges.added.length > 0 ||
          diff.edges.removed.length > 0 ||
          diff.edges.changed.length > 0 ||
          diff.notes.added.length > 0 ||
          diff.notes.removed.length > 0 ||
          diff.notes.changed.length > 0
      );

      const now = new Date().toISOString();

      if (!hasChanges) {
        // No-op: record request, do NOT advance revision
        const insReq = this.db.prepare(
          'INSERT INTO requests (document_id, request_id, base_revision, payload_hash, committed_revision, changed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
        );
        insReq.run(id, request.requestId, request.baseRevision, payloadHash, docRow.head_revision, now);

        this.db.exec('COMMIT;');
        return {
          document: currentDoc,
          revision: docRow.head_revision,
          replayed: false,
          changed: false,
        };
      }

      // Advance head revision
      const nextRev = docRow.head_revision + 1;
      const committedDoc: DiagramDocument = {
        ...nextDoc,
        revision: nextRev,
      };

      // Full document validation (size, shape, metadata, graph) before commit
      validateDocument(committedDoc);
      const snapshotJson = canonicalJson(committedDoc);

      const updDoc = this.db.prepare(
        'UPDATE documents SET head_revision = ?, title = ?, updated_at = ? WHERE id = ?'
      );
      updDoc.run(nextRev, committedDoc.title, now, id);

      const insRev = this.db.prepare(
        'INSERT INTO revisions (document_id, revision, author, summary, created_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insRev.run(id, nextRev, author, summary, now, snapshotJson);

      const insReq = this.db.prepare(
        'INSERT INTO requests (document_id, request_id, base_revision, payload_hash, committed_revision, changed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      );
      insReq.run(id, request.requestId, request.baseRevision, payloadHash, nextRev, now);

      this.db.exec('COMMIT;');
      return {
        document: committedDoc,
        revision: nextRev,
        replayed: false,
        changed: true,
      };
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      if (err instanceof DiagramError) throw err;
      if (err.message && err.message.includes('busy')) {
        throw new DiagramError('STORAGE_ERROR', `Database busy timeout: ${err.message}`, 5, err);
      }
      throw new DiagramError('STORAGE_ERROR', `Apply failed: ${err.message}`, 5, err);
    }
  }

  public pull(id: string, since?: number): PullResult {
    this.assertOpen();
    const idCheck = idSchema.safeParse(id);
    if (!idCheck.success) {
      throw new DiagramError('NOT_FOUND', `Invalid document ID '${id}'`, 4);
    }

    try {
      this.db.exec('BEGIN;');

      const docStmt = this.db.prepare('SELECT head_revision FROM documents WHERE id = ?');
      const docRow = docStmt.get(id) as any;
      if (!docRow) {
        throw new DiagramError('NOT_FOUND', `Document '${id}' not found`, 4);
      }
      const headRev: number = docRow.head_revision;

      const headRevStmt = this.db.prepare(
        'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
      );
      const headRow = headRevStmt.get(id, headRev) as any;
      if (!headRow) {
        throw new DiagramError('CORRUPT_DATA', `Snapshot for head revision ${headRev} not found`, 5);
      }
      const headDoc = this.parseSnapshot(headRow.snapshot_json);

      if (since !== undefined) {
        if (typeof since !== 'number' || !Number.isInteger(since) || since < 1 || since > headRev) {
          throw new DiagramError(
            'INVALID_BASELINE',
            `Invalid baseline revision: ${since}. Current head is ${headRev}`,
            4
          );
        }

        const sinceRevStmt = this.db.prepare(
          'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
        );
        const sinceRow = sinceRevStmt.get(id, since) as any;
        if (!sinceRow) {
          throw new DiagramError(
            'INVALID_BASELINE',
            `Baseline revision ${since} not found for document '${id}'`,
            4
          );
        }
        const sinceDoc = this.parseSnapshot(sinceRow.snapshot_json);

        // Net diff from since to head
        const diff = diffDocuments(sinceDoc, headDoc);

        // Ordered revisions in (since, headRev]
        const revsStmt = this.db.prepare(
          'SELECT revision, author, summary, created_at FROM revisions WHERE document_id = ? AND revision > ? AND revision <= ? ORDER BY revision ASC'
        );
        const revRows = revsStmt.all(id, since, headRev) as any[];
        const revisions: RevisionMeta[] = revRows.map((r) => ({
          revision: r.revision,
          author: r.author,
          summary: r.summary,
          createdAt: r.created_at,
        }));

        // Chronological note activity across (since, headRev]
        const noteActivity: { revision: number; notes: any }[] = [];
        let prevDoc = sinceDoc;

        const intermediateStmt = this.db.prepare(
          'SELECT revision, snapshot_json FROM revisions WHERE document_id = ? AND revision > ? AND revision <= ? ORDER BY revision ASC'
        );
        const intermediateRows = intermediateStmt.all(id, since, headRev) as any[];

        for (const row of intermediateRows) {
          const currDoc = this.parseSnapshot(row.snapshot_json);
          const stepDiff = diffDocuments(prevDoc, currDoc);
          noteActivity.push({
            revision: row.revision,
            notes: stepDiff.notes,
          });
          prevDoc = currDoc;
        }

        this.db.exec('COMMIT;');
        return {
          document: headDoc,
          baseRevision: since,
          headRevision: headRev,
          diff,
          revisions,
          noteActivity,
        };
      } else {
        // No baseline specified: full snapshot, null diff
        const revsStmt = this.db.prepare(
          'SELECT revision, author, summary, created_at FROM revisions WHERE document_id = ? ORDER BY revision ASC'
        );
        const revRows = revsStmt.all(id) as any[];
        const revisions: RevisionMeta[] = revRows.map((r) => ({
          revision: r.revision,
          author: r.author,
          summary: r.summary,
          createdAt: r.created_at,
        }));

        this.db.exec('COMMIT;');
        return {
          document: headDoc,
          baseRevision: null,
          headRevision: headRev,
          diff: null,
          revisions,
          noteActivity: [],
        };
      }
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      if (err instanceof DiagramError) throw err;
      throw new DiagramError('STORAGE_ERROR', `Failed to pull document '${id}': ${err.message}`, 5, err);
    }
  }

  public history(id: string): RevisionMeta[] {
    this.assertOpen();
    const idCheck = idSchema.safeParse(id);
    if (!idCheck.success) {
      throw new DiagramError('NOT_FOUND', `Invalid document ID '${id}'`, 4);
    }

    try {
      const docStmt = this.db.prepare('SELECT id FROM documents WHERE id = ?');
      const doc = docStmt.get(id);
      if (!doc) {
        throw new DiagramError('NOT_FOUND', `Document '${id}' not found`, 4);
      }

      const stmt = this.db.prepare(
        'SELECT revision, author, summary, created_at FROM revisions WHERE document_id = ? ORDER BY revision ASC'
      );
      const rows = stmt.all(id) as any[];
      return rows.map((r) => ({
        revision: r.revision,
        author: r.author,
        summary: r.summary,
        createdAt: r.created_at,
      }));
    } catch (err: any) {
      if (err instanceof DiagramError) throw err;
      throw new DiagramError('STORAGE_ERROR', `Failed to fetch history for '${id}': ${err.message}`, 5, err);
    }
  }

  public revert(id: string, request: Omit<ApplyRequest, 'operations'>): MutationResult {
    this.assertOpen();
    const idCheck = idSchema.safeParse(id);
    if (!idCheck.success) {
      throw new DiagramError('NOT_FOUND', `Invalid document ID '${id}'`, 4);
    }

    const reqIdCheck = idSchema.safeParse(request.requestId);
    if (!reqIdCheck.success) {
      throw new DiagramError('VALIDATION_ERROR', `Invalid requestId '${request.requestId}'`, 4);
    }

    if (!Number.isInteger(request.baseRevision) || request.baseRevision < 1) {
      throw new DiagramError('VALIDATION_ERROR', `Invalid baseRevision ${request.baseRevision}`, 4);
    }

    const author = validateAndNormalizeAuthor(request.author);
    const summaryProvided = request.summary !== undefined;
    const stableHashSummary = validateAndNormalizeSummary(request.summary, 'Revert revision');

    const payloadHash = crypto
      .createHash('sha256')
      .update(canonicalJson({
        author,
        baseRevision: request.baseRevision,
        revert: true,
        summary: stableHashSummary,
      }))
      .digest('hex');

    try {
      this.db.exec('BEGIN IMMEDIATE;');

      // 1. Check idempotency in requests table
      const reqStmt = this.db.prepare(
        'SELECT base_revision, payload_hash, committed_revision, changed FROM requests WHERE document_id = ? AND request_id = ?'
      );
      const recorded = reqStmt.get(id, request.requestId) as any;
      if (recorded) {
        if (recorded.base_revision !== request.baseRevision || recorded.payload_hash !== payloadHash) {
          throw new DiagramError(
            'REQUEST_ID_REUSED',
            `Request ID '${request.requestId}' already used with different payload or base revision`,
            4
          );
        }
        const revStmt = this.db.prepare(
          'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
        );
        const revRow = revStmt.get(id, recorded.committed_revision) as any;
        if (!revRow) {
          throw new DiagramError('CORRUPT_DATA', `Snapshot for revision ${recorded.committed_revision} missing`, 5);
        }
        this.db.exec('ROLLBACK;');
        return {
          document: this.parseSnapshot(revRow.snapshot_json),
          revision: recorded.committed_revision,
          replayed: true,
          changed: Boolean(recorded.changed),
        };
      }

      // 2. Fetch document head
      const docStmt = this.db.prepare('SELECT head_revision, title FROM documents WHERE id = ?');
      const docRow = docStmt.get(id) as any;
      if (!docRow) {
        throw new DiagramError('NOT_FOUND', `Document '${id}' not found`, 4);
      }

      // 3. Head revision check: expectedRevision is caller's base, currentRevision is saved head
      if (docRow.head_revision !== request.baseRevision) {
        throw new DiagramError(
          'STALE_REVISION_CONFLICT',
          `Mutation rejected: base revision is stale. Expected ${request.baseRevision}, current head is ${docRow.head_revision}`,
          3,
          {
            documentId: id,
            expectedRevision: request.baseRevision,
            currentRevision: docRow.head_revision,
          }
        );
      }

      // 4. Cannot revert revision 1
      if (request.baseRevision <= 1) {
        throw new DiagramError('CANNOT_REVERT_INITIAL', 'Cannot revert initial revision 1', 4);
      }

      // 5. Load prior revision snapshot (baseRevision - 1)
      const targetRev = request.baseRevision - 1;
      const priorRevStmt = this.db.prepare(
        'SELECT snapshot_json FROM revisions WHERE document_id = ? AND revision = ?'
      );
      const priorRow = priorRevStmt.get(id, targetRev) as any;
      if (!priorRow) {
        throw new DiagramError('CORRUPT_DATA', `Snapshot for target revert revision ${targetRev} missing`, 5);
      }
      const priorDoc = this.parseSnapshot(priorRow.snapshot_json);

      // Fetch reverted revision metadata for summary
      const revertedMetaStmt = this.db.prepare(
        'SELECT author, summary FROM revisions WHERE document_id = ? AND revision = ?'
      );
      const revertedRow = revertedMetaStmt.get(id, request.baseRevision) as any;

      // 6. Advance head to next revision
      const nextRev = docRow.head_revision + 1;
      const now = new Date().toISOString();
      const displaySummary = summaryProvided
        ? stableHashSummary
        : `Revert revision ${request.baseRevision} (by ${revertedRow?.author ?? 'unknown'}: ${revertedRow?.summary ?? ''})`;

      const restoredDoc: DiagramDocument = {
        ...priorDoc,
        revision: nextRev,
      };

      // Full document validation before commit
      validateDocument(restoredDoc);
      const snapshotJson = canonicalJson(restoredDoc);

      const updDoc = this.db.prepare(
        'UPDATE documents SET head_revision = ?, title = ?, updated_at = ? WHERE id = ?'
      );
      updDoc.run(nextRev, restoredDoc.title, now, id);

      const insRev = this.db.prepare(
        'INSERT INTO revisions (document_id, revision, author, summary, created_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insRev.run(id, nextRev, author, displaySummary, now, snapshotJson);

      const insReq = this.db.prepare(
        'INSERT INTO requests (document_id, request_id, base_revision, payload_hash, committed_revision, changed, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      );
      insReq.run(id, request.requestId, request.baseRevision, payloadHash, nextRev, now);

      this.db.exec('COMMIT;');
      return {
        document: restoredDoc,
        revision: nextRev,
        replayed: false,
        changed: true,
      };
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      if (err instanceof DiagramError) throw err;
      if (err.message && err.message.includes('busy')) {
        throw new DiagramError('STORAGE_ERROR', `Database busy timeout: ${err.message}`, 5, err);
      }
      throw new DiagramError('STORAGE_ERROR', `Revert failed: ${err.message}`, 5, err);
    }
  }

  private parseSnapshot(json: string): DiagramDocument {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err: any) {
      throw new DiagramError('CORRUPT_DATA', `Snapshot data is not valid JSON: ${err.message}`, 5, err);
    }

    try {
      return validateDocument(parsed);
    } catch (err: any) {
      if (err instanceof DiagramError && err.code === 'UNSUPPORTED_SCHEMA_VERSION') {
        throw new DiagramError(
          'CORRUPT_DATA',
          `Snapshot schema version incompatibility: ${err.message}`,
          5,
          err
        );
      }
      if (err instanceof DiagramError) {
        throw new DiagramError(
          'CORRUPT_DATA',
          `Snapshot data corruption: ${err.message}`,
          5,
          err
        );
      }
      throw new DiagramError('CORRUPT_DATA', `Snapshot data is corrupt: ${err.message}`, 5, err);
    }
  }
}
