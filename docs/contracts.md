# Diagram Bridge Contracts

This document specifies the formal contracts for Diagram Bridge's core domain models, schema validation, pure operations engine, storage mechanics, and command interface.

---

## 1. Domain Types & Invariants

### 1.1 Document Schema (`schemaVersion: 1`)

A diagram document consists of:
- `schemaVersion`: Literal integer `1`. Any other value triggers `UNSUPPORTED_SCHEMA_VERSION`.
- `documentId`: Safe identifier string (`^[a-zA-Z0-9._-]{1,100}$`).
- `revision`: Monotonically increasing integer starting at `1`.
- `title`: String between 1 and 200 characters.
- `nodes`: Array of diagram nodes (maximum 1,000).
- `edges`: Array of diagram edges (maximum 2,000).
- `notes`: Array of diagram notes (maximum 1,000).
- `lineage`: Optional provenance `{ documentId: string; revision: number }` indicating source document copy lineage.

### 1.2 Node Schema & Layout

- `kind`: One of `'step' | 'decision' | 'datastore' | 'text' | 'group'`.
- `layout`: `{ x: number, y: number, width: number, height: number }`.
  - Coordinates bounded in `[-100000, 100000]`.
  - Dimensions positive, finite, up to `100000`.
  - Default dimensions:
    - `step`: 220 x 88
    - `decision`: 220 x 110
    - `datastore`: 220 x 88
    - `group`: 700 x 500
    - `text`: 260 x 64
- `parentId`: Optional group container ID.
  - Groups support single-level containment.
  - A node's `parentId` must refer to a node with `kind: 'group'`.
  - A group cannot have a `parentId` (no nested groups).
  - A node cannot be its own parent.
- `ref`: Optional external reference string (up to 200 characters).

### 1.3 Edge Schema & Connectivity

- `id`: Safe identifier string.
- `source`: Source node ID.
- `target`: Target node ID.
- `label`: Optional label string (up to 2,000 characters).
- **Rules**:
  - Endpoints must exist as nodes in the document.
  - Neither source nor target may have `kind: 'group'` or `kind: 'text'`.
  - Directed cycles and self-loops (`source === target`) are supported for workflow retry loops.

### 1.4 Notes & Anchors

- `id`: Safe identifier string.
- `body`: Plain text body (up to 20,000 characters). Notes are pure descriptive data; they are never executed or parsed as instructions.
- `author`: Author string (1-100 characters).
- `anchor`: One of:
  - `{ type: 'diagram' }`: Global document-level note.
  - `{ type: 'node', id: string }`: Note attached to an active node.
  - `{ type: 'edge', id: string }`: Note attached to an active edge.
  - `{ type: 'detached', previousType: 'node' | 'edge', previousId: string, previousLabel: string }`: Preserved note whose target was removed.
- **Referential Integrity**:
  - Deleting a node or edge detaches attached notes rather than silently deleting them.
  - Deleting notes requires an explicit `removeNote` operation.
  - New notes cannot be created targeting non-existent nodes or edges.

---

## 2. Operations & Mutation Engine

Mutations are submitted as an ordered array of operations (maximum 5,000 operations per batch):

| Operation | Fields | Semantics |
|---|---|---|
| `setTitle` | `{ title: string }` | Updates document title (1-200 chars). |
| `addNode` | `{ node: NodeInput }` | Adds a node. If layout coordinates are omitted, computes deterministic non-overlapping placement below existing content. |
| `updateNode` | `{ id: string, patch: {...} }` | Patches kind, label, ref, layout, or parentId (`null` unparents). Cannot overwrite `id`. |
| `removeNode` | `{ id: string, cascade?: boolean }` | Removes node. If incident edges or child nodes exist, requires `cascade: true`. Detaches notes attached to removed nodes/edges. |
| `addEdge` | `{ edge: DiagramEdge }` | Adds directed edge between non-group, non-text nodes. |
| `updateEdge` | `{ id: string, patch: {...} }` | Patches source, target, or label. Validates endpoints. |
| `removeEdge` | `{ id: string }` | Removes edge. Detaches any notes attached to this edge. |
| `addNote` | `{ note: DiagramNote }` | Adds note attached to diagram, node, edge, or detached anchor. |
| `updateNote` | `{ id: string, patch: {...} }` | Patches body, author, or anchor. |
| `removeNote` | `{ id: string }` | Explicitly deletes note. |

---

## 3. Limits & Security Protections

- Maximum Nodes: 1,000
- Maximum Edges: 2,000
- Maximum Notes: 1,000
- Maximum Operations: 5,000
- Maximum JSON Payload: 5 MiB (5,242,880 bytes)
- Maximum Node Label: 2,000 characters
- Maximum Note Body: 20,000 characters
- Maximum Title: 200 characters
- Safe Application IDs: 1 to 100 ASCII alphanumeric characters, dashes, underscores, dots (`^[a-zA-Z0-9._-]{1,100}$`).
- **Strict Schema Validation**: Extra or unexpected object keys are rejected (not silently stripped).
- **Prototype Pollution Defense**: Keys named `__proto__`, `constructor`, or `prototype` are rejected recursively across all inputs.

---

## 4. Storage & Command Architecture

### 4.1 SQLite Storage (`DiagramStore`)

- Path: `<workspaceRoot>/.diagram-bridge/diagrams.sqlite`.
- Engine: Node.js built-in `node:sqlite` `DatabaseSync`.
- Pragma Configuration:
  - `PRAGMA journal_mode = WAL;`
  - `PRAGMA busy_timeout = 5000;`
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA synchronous = NORMAL;`

### 4.2 Tables Schema

1. `documents`:
   - `id TEXT PRIMARY KEY`
   - `title TEXT NOT NULL`
   - `head_revision INTEGER NOT NULL`
   - `created_at TEXT NOT NULL`
   - `updated_at TEXT NOT NULL`
2. `revisions`:
   - `document_id TEXT NOT NULL`
   - `revision INTEGER NOT NULL`
   - `author TEXT NOT NULL`
   - `summary TEXT NOT NULL`
   - `created_at TEXT NOT NULL`
   - `snapshot_json TEXT NOT NULL`
   - `PRIMARY KEY (document_id, revision)`
3. `requests`:
   - `document_id TEXT NOT NULL`
   - `request_id TEXT NOT NULL`
   - `base_revision INTEGER NOT NULL`
   - `payload_hash TEXT NOT NULL`
   - `committed_revision INTEGER NOT NULL`
   - `changed INTEGER NOT NULL`
   - `created_at TEXT NOT NULL`
   - `PRIMARY KEY (document_id, request_id)`

### 4.3 Idempotency & Safe Retries

- Every `apply` requires a `baseRevision` and a client-provided `requestId`.
- Within a `BEGIN IMMEDIATE` transaction:
  1. Look up existing `(document_id, request_id)` in `requests`.
  2. If found:
     - If `base_revision` and `payload_hash` match the recorded request, return the original committed revision with `replayed: true` and `changed: recordedChanged`.
     - If `base_revision` or `payload_hash` differs, abort and throw `REQUEST_ID_REUSED` (exitCode 4).
  3. If not found:
     - Verify head revision matches `baseRevision`. If not, abort and throw `STALE_REVISION_CONFLICT` (exitCode 3).
     - Apply operations. If operations result in an identical snapshot, advance no revision, record no-op in `requests` table with `changed = 0`, and return `replayed: false, changed: false`.
     - If changes occurred, commit new revision `head + 1`, store immutable snapshot and revision metadata, record request in `requests` table, and return `replayed: false, changed: true`.

### 4.4 Coherent Pull & Diffs

`pull(id, since?: number)` runs a single consistent read transaction:
- Returns current snapshot at head revision `H`.
- If `since` is omitted: returns document snapshot and null diff.
- If `since` is specified:
  - Validates `1 <= since <= H`. If `since > H` or invalid, throws `INVALID_BASELINE` (exitCode 4).
  - Computes structural, content, layout, and note diff from revision `since` to `H`.
  - Delivers ordered revision metadata in `(since, H]`.
  - Delivers chronological note activity in `(since, H]` so intermediate note modifications/deletions remain inspectable even if absent at head.

### 4.5 Forward-Moving Revert

- `revert(id, { baseRevision, requestId, author?, summary? })`
- Verifies `baseRevision === headRevision`.
- Reverting revision 1 throws `CANNOT_REVERT_INITIAL` (exitCode 4).
- Reads snapshot at `baseRevision - 1`.
- Creates forward revision `baseRevision + 1` restoring the prior document content with new timestamp, author, and revert summary.
- Preserves complete immutable audit history.

### 4.6 Copy & Lineage

- `create(title, from?: DiagramDocument, author?: string)`
- Generates a new unique document ID at revision 1.
- If `from` is provided, copies nodes, edges, and notes, while setting:
  `lineage: { documentId: from.documentId, revision: from.revision }`.
- Caller-supplied metadata cannot mutate original document state.

---

## 5. Structured Error Codes & Exit Codes

| Code | Exit Code | Condition |
|---|---|---|
| `STALE_REVISION_CONFLICT` | 3 | Base revision does not match current head revision. |
| `NOT_FOUND` | 4 | Document ID or requested revision does not exist. |
| `INVALID_BASELINE` | 4 | Pull since revision is negative, future, or invalid. |
| `REQUEST_ID_REUSED` | 4 | Same request ID submitted with different base revision or payload. |
| `VALIDATION_ERROR` | 4 | Schema violation, ID format, prototype key, or limit exceeded. |
| `INVALID_OPERATION` | 4 | Missing endpoints, non-cascade deletion of attached node, or invalid group nesting. |
| `CANNOT_REVERT_INITIAL` | 4 | Attempted to revert revision 1. |
| `UNSUPPORTED_SCHEMA_VERSION` | 4 | Schema version is not 1. |
| `CORRUPT_DATA` | 5 | Stored snapshot or database state corrupted. |
| `STORAGE_ERROR` | 5 | SQLite lock failure, busy timeout, or unrecoverable disk error. |
