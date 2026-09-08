import { DiagramError } from './errors.js';
import { canonicalJson } from './canonical.js';
import type {
  DiagramDocument,
  DiagramNode,
  DiagramEdge,
  DiagramNote,
  DocumentDiff,
  EntityDiff,
  Change
} from './types.js';

export function diffDocuments(before: DiagramDocument, after: DiagramDocument): DocumentDiff {
  if (before.documentId !== after.documentId) {
    throw new DiagramError(
      'VALIDATION_ERROR',
      `Cannot diff different documents: '${before.documentId}' vs '${after.documentId}'`,
      4
    );
  }
  if (before.schemaVersion !== after.schemaVersion) {
    throw new DiagramError(
      'VALIDATION_ERROR',
      `Cannot diff documents with different schema versions: ${before.schemaVersion} vs ${after.schemaVersion}`,
      4
    );
  }

  // 1. Title diff
  const title =
    before.title !== after.title
      ? { before: before.title, after: after.title }
      : null;

  // 2. Nodes diff
  const beforeNodes = new Map<string, DiagramNode>(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map<string, DiagramNode>(after.nodes.map((n) => [n.id, n]));

  const nodesAdded: DiagramNode[] = [];
  const nodesRemoved: DiagramNode[] = [];
  const nodesChanged: Change<DiagramNode>[] = [];

  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) {
      nodesAdded.push({ ...node });
    }
  }

  for (const node of before.nodes) {
    const next = afterNodes.get(node.id);
    if (!next) {
      nodesRemoved.push({ ...node });
    } else {
      const fields: string[] = [];
      if (node.kind !== next.kind) fields.push('kind');
      if (node.label !== next.label) fields.push('label');
      if (node.parentId !== next.parentId) fields.push('parentId');
      if (node.ref !== next.ref) fields.push('ref');
      if (
        node.layout.x !== next.layout.x ||
        node.layout.y !== next.layout.y ||
        node.layout.width !== next.layout.width ||
        node.layout.height !== next.layout.height
      ) {
        fields.push('layout');
      }

      if (fields.length > 0) {
        nodesChanged.push({
          id: node.id,
          before: { ...node, layout: { ...node.layout } },
          after: { ...next, layout: { ...next.layout } },
          fields: fields.sort(),
        });
      }
    }
  }

  const nodesDiff: EntityDiff<DiagramNode> = {
    added: nodesAdded.sort((a, b) => a.id.localeCompare(b.id)),
    removed: nodesRemoved.sort((a, b) => a.id.localeCompare(b.id)),
    changed: nodesChanged.sort((a, b) => a.id.localeCompare(b.id)),
  };

  // 3. Edges diff
  const beforeEdges = new Map<string, DiagramEdge>(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map<string, DiagramEdge>(after.edges.map((e) => [e.id, e]));

  const edgesAdded: DiagramEdge[] = [];
  const edgesRemoved: DiagramEdge[] = [];
  const edgesChanged: Change<DiagramEdge>[] = [];

  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) {
      edgesAdded.push({ ...edge });
    }
  }

  for (const edge of before.edges) {
    const next = afterEdges.get(edge.id);
    if (!next) {
      edgesRemoved.push({ ...edge });
    } else {
      const fields: string[] = [];
      if (edge.source !== next.source) fields.push('source');
      if (edge.target !== next.target) fields.push('target');
      if (edge.label !== next.label) fields.push('label');

      if (fields.length > 0) {
        edgesChanged.push({
          id: edge.id,
          before: { ...edge },
          after: { ...next },
          fields: fields.sort(),
        });
      }
    }
  }

  const edgesDiff: EntityDiff<DiagramEdge> = {
    added: edgesAdded.sort((a, b) => a.id.localeCompare(b.id)),
    removed: edgesRemoved.sort((a, b) => a.id.localeCompare(b.id)),
    changed: edgesChanged.sort((a, b) => a.id.localeCompare(b.id)),
  };

  // 4. Notes diff
  const beforeNotes = new Map<string, DiagramNote>(before.notes.map((n) => [n.id, n]));
  const afterNotes = new Map<string, DiagramNote>(after.notes.map((n) => [n.id, n]));

  const notesAdded: DiagramNote[] = [];
  const notesRemoved: DiagramNote[] = [];
  const notesChanged: Change<DiagramNote>[] = [];

  for (const note of after.notes) {
    if (!beforeNotes.has(note.id)) {
      notesAdded.push({ ...note, anchor: { ...note.anchor } });
    }
  }

  for (const note of before.notes) {
    const next = afterNotes.get(note.id);
    if (!next) {
      notesRemoved.push({ ...note, anchor: { ...note.anchor } });
    } else {
      const fields: string[] = [];
      if (note.body !== next.body) fields.push('body');
      if (note.author !== next.author) fields.push('author');
      if (canonicalJson(note.anchor) !== canonicalJson(next.anchor)) fields.push('anchor');

      if (fields.length > 0) {
        notesChanged.push({
          id: note.id,
          before: { ...note, anchor: { ...note.anchor } },
          after: { ...next, anchor: { ...next.anchor } },
          fields: fields.sort(),
        });
      }
    }
  }

  const notesDiff: EntityDiff<DiagramNote> = {
    added: notesAdded.sort((a, b) => a.id.localeCompare(b.id)),
    removed: notesRemoved.sort((a, b) => a.id.localeCompare(b.id)),
    changed: notesChanged.sort((a, b) => a.id.localeCompare(b.id)),
  };

  return {
    title,
    nodes: nodesDiff,
    edges: edgesDiff,
    notes: notesDiff,
  };
}
