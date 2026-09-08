export type {
  NodeKind,
  Layout,
  DiagramNode,
  NodeInput,
  DiagramEdge,
  Anchor,
  DiagramNote,
  DiagramDocument,
  Operation,
  Change,
  EntityDiff,
  DocumentDiff,
  RevisionMeta,
  PullResult,
  ApplyRequest,
  MutationResult,
  DocumentSummary
} from '../core/types.js';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export type SelectedElement =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;

export interface PendingSaveRequest {
  requestId: string;
  baseRevision: number;
  operations: import('../core/types.js').Operation[];
  author?: string;
  summary?: string;
}

export interface DraftState {
  baseRevision: number;
  document: import('../core/types.js').DiagramDocument;
  pendingRequest?: PendingSaveRequest;
  pendingRequestId?: string;
  pendingOperations?: import('../core/types.js').Operation[];
  pendingAuthor?: string;
  pendingSummary?: string;
  timestamp: number;
}
