import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DiagramError } from '../core/errors.js';

export interface StorageOptions {
  dbPath?: string;
  busyTimeout?: number;
}

export function openDatabase(workspaceRoot: string, options?: StorageOptions): DatabaseSync {
  let db: DatabaseSync | null = null;
  try {
    const storageDir = path.join(workspaceRoot, '.diagram-bridge');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const dbPath = options?.dbPath ?? path.join(storageDir, 'diagrams.sqlite');
    db = new DatabaseSync(dbPath);

    // Validate numeric timeout and set busy_timeout before WAL/migration work
    const rawTimeout = options?.busyTimeout ?? 5000;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 0) {
      throw new DiagramError('VALIDATION_ERROR', 'busyTimeout must be a non-negative finite number', 4);
    }
    db.exec(`PRAGMA busy_timeout = ${Math.floor(rawTimeout)};`);
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(`PRAGMA synchronous = FULL;`);

    // Initialize tables and check schema version
    initSchema(db);

    return db;
  } catch (err: any) {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    if (err instanceof DiagramError) throw err;
    throw new DiagramError('STORAGE_ERROR', `Failed to open database: ${err.message}`, 5, err);
  }
}

function initSchema(db: DatabaseSync): void {
  // Avoid initial DDL writes on an already initialized DB:
  // Query sqlite_master first to inspect existing tables without executing DDL.
  const checkTableStmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  );
  const tableRow = checkTableStmt.get() as { name: string } | undefined;

  if (tableRow) {
    const verStmt = db.prepare('SELECT version FROM schema_version LIMIT 1');
    const verRow = verStmt.get() as { version: number } | undefined;
    if (!verRow || typeof verRow.version !== 'number') {
      throw new DiagramError('CORRUPT_DATA', 'schema_version table is empty or invalid', 5);
    }
    if (verRow.version > 1) {
      throw new DiagramError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported database schema version ${verRow.version} (maximum supported version is 1)`,
        5
      );
    }
    if (verRow.version < 1) {
      throw new DiagramError('CORRUPT_DATA', `Invalid database schema version ${verRow.version}`, 5);
    }
    // Database is already initialized at supported version 1; avoid any DDL writes
    return;
  }

  // Database is uninitialized: create schema version 1 transactionally
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        head_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE revisions (
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        author TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (document_id, revision),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE TABLE requests (
        document_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        committed_revision INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, request_id),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_revisions_doc ON revisions(document_id, revision);
      CREATE INDEX idx_requests_doc ON requests(document_id, request_id);

      INSERT INTO schema_version (version) VALUES (1);
    `);
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    throw err;
  }
}
