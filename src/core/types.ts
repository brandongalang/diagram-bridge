export type NodeKind = 'step' | 'decision' | 'datastore' | 'text' | 'group';
export interface Layout { x: number; y: number; width: number; height: number }
export interface DiagramNode { id: string; kind: NodeKind; label: string; layout: Layout; parentId?: string; ref?: string }
export type NodeInput = Omit<DiagramNode, 'layout'> & { layout?: Partial<Layout> };
export interface DiagramEdge { id: string; source: string; target: string; label?: string }
export type Anchor = { type: 'diagram' } | { type: 'node' | 'edge'; id: string } | { type: 'detached'; previousType: 'node' | 'edge'; previousId: string; previousLabel: string };
export interface DiagramNote { id: string; body: string; author: string; anchor: Anchor }
export interface DiagramDocument {
  schemaVersion: 1;
  documentId: string;
  revision: number;
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  notes: DiagramNote[];
  lineage?: { documentId: string; revision: number };
}
export type Operation =
  | { type: 'addNode'; node: NodeInput }
  | { type: 'updateNode'; id: string; patch: Partial<Omit<DiagramNode, 'id' | 'layout' | 'parentId' | 'ref'>> & { layout?: Partial<Layout>; parentId?: string | null; ref?: string | null } }
  | { type: 'removeNode'; id: string; cascade?: boolean }
  | { type: 'addEdge'; edge: DiagramEdge }
  | { type: 'updateEdge'; id: string; patch: Partial<Omit<DiagramEdge, 'id' | 'label'>> & { label?: string | null } }
  | { type: 'removeEdge'; id: string }
  | { type: 'addNote'; note: DiagramNote }
  | { type: 'updateNote'; id: string; patch: Partial<Omit<DiagramNote, 'id'>> }
  | { type: 'removeNote'; id: string }
  | { type: 'setTitle'; title: string };
export interface Change<T> { id: string; before: T; after: T; fields: string[] }
export interface EntityDiff<T> { added: T[]; removed: T[]; changed: Change<T>[] }
export interface DocumentDiff {
  title: { before: string; after: string } | null;
  nodes: EntityDiff<DiagramNode>;
  edges: EntityDiff<DiagramEdge>;
  notes: EntityDiff<DiagramNote>;
}
export interface RevisionMeta { revision: number; author: string; summary: string; createdAt: string }
export interface PullResult {
  document: DiagramDocument;
  baseRevision: number | null;
  headRevision: number;
  diff: DocumentDiff | null;
  revisions: RevisionMeta[];
  noteActivity: { revision: number; notes: EntityDiff<DiagramNote> }[];
}
export interface ApplyRequest { baseRevision: number; requestId: string; operations: Operation[]; author?: string; summary?: string }
export interface MutationResult { document: DiagramDocument; revision: number; replayed: boolean; changed: boolean }
export interface DocumentSummary { documentId: string; title: string; revision: number; updatedAt: string }
