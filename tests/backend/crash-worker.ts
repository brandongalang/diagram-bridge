import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspaceRoot = process.argv[2];
const dbPath = path.join(workspaceRoot, '.diagram-bridge', 'diagrams.sqlite');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('BEGIN IMMEDIATE;');
// Simulate partial uncommitted write
db.exec("INSERT INTO documents (id, title, head_revision, created_at, updated_at) VALUES ('crash-doc', 'Crashing', 1, 'now', 'now');");
// Intentionally kill process before commit
process.kill(process.pid, 'SIGKILL');
