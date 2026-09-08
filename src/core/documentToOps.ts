import { diffDocuments } from './diff.js';
import { applyOps } from './graph.js';
import { DiagramError } from './errors.js';
import type { DiagramDocument, Operation } from './types.js';

export function documentToOps(before: DiagramDocument, after: DiagramDocument): Operation[] {
  const diff = diffDocuments(before, after);
  const ops: Operation[] = [];

  // 1. Title change
  if (diff.title) {
    ops.push({ type: 'setTitle', title: diff.title.after });
  }

  // 2. Added nodes: parents (groups) before children
  const addedNodes = [...diff.nodes.added];
  addedNodes.sort((a, b) => {
    // If a is group and b is not, a first
    if (a.kind === 'group' && b.kind !== 'group') return -1;
    if (b.kind === 'group' && a.kind !== 'group') return 1;
    // If b is child of a, a first
    if (b.parentId === a.id) return -1;
    if (a.parentId === b.id) return 1;
    return a.id.localeCompare(b.id);
  });

  for (const node of addedNodes) {
    ops.push({
      type: 'addNode',
      node: {
        id: node.id,
        kind: node.kind,
        label: node.label,
        layout: { ...node.layout },
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.ref ? { ref: node.ref } : {}),
      },
    });
  }

  // 3. Updated nodes: reparent retained children away from deleted groups BEFORE group deletion!
  for (const change of diff.nodes.changed) {
    const patch: any = {};
    if (change.fields.includes('kind')) patch.kind = change.after.kind;
    if (change.fields.includes('label')) patch.label = change.after.label;
    if (change.fields.includes('ref')) {
      patch.ref = change.after.ref ?? null;
    }
    if (change.fields.includes('layout')) patch.layout = { ...change.after.layout };
    if (change.fields.includes('parentId')) {
      patch.parentId = change.after.parentId ?? null;
    }
    ops.push({ type: 'updateNode', id: change.id, patch });
  }

  // 4. Updated edges: reconnect retained edges away from deleted nodes BEFORE node deletion!
  for (const change of diff.edges.changed) {
    const patch: any = {};
    if (change.fields.includes('source')) patch.source = change.after.source;
    if (change.fields.includes('target')) patch.target = change.after.target;
    if (change.fields.includes('label')) {
      patch.label = change.after.label ?? null;
    }
    ops.push({ type: 'updateEdge', id: change.id, patch });
  }

  // 5. Added edges (endpoints exist now)
  for (const edge of diff.edges.added) {
    ops.push({
      type: 'addEdge',
      edge: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label ? { label: edge.label } : {}),
      },
    });
  }

  // 6. Updated notes
  for (const change of diff.notes.changed) {
    const patch: any = {};
    if (change.fields.includes('body')) patch.body = change.after.body;
    if (change.fields.includes('author')) patch.author = change.after.author;
    if (change.fields.includes('anchor')) patch.anchor = { ...change.after.anchor };
    ops.push({ type: 'updateNote', id: change.id, patch });
  }

  // 7. Removed notes
  for (const note of diff.notes.removed) {
    ops.push({ type: 'removeNote', id: note.id });
  }

  // 8. Removed edges
  for (const edge of diff.edges.removed) {
    ops.push({ type: 'removeEdge', id: edge.id });
  }

  // 9. Removed nodes: children before parents
  const removedNodes = [...diff.nodes.removed];
  removedNodes.sort((a, b) => {
    // If a is child of b, a should be removed first (-1)
    if (a.parentId === b.id) return -1;
    if (b.parentId === a.id) return 1;
    // Non-groups before groups
    if (a.kind !== 'group' && b.kind === 'group') return -1;
    if (a.kind === 'group' && b.kind !== 'group') return 1;
    return a.id.localeCompare(b.id);
  });

  for (const node of removedNodes) {
    ops.push({ type: 'removeNode', id: node.id, cascade: true });
  }

  // 10. Added notes
  for (const note of diff.notes.added) {
    ops.push({
      type: 'addNote',
      note: {
        id: note.id,
        body: note.body,
        author: note.author,
        anchor: { ...note.anchor },
      },
    });
  }

  // 11. Validate final result roundtrip against after document
  const roundtrip = applyOps(before, ops);
  const roundtripDiff = diffDocuments(roundtrip, after);
  const hasDiff = Boolean(
    roundtripDiff.title ||
      roundtripDiff.nodes.added.length > 0 ||
      roundtripDiff.nodes.removed.length > 0 ||
      roundtripDiff.nodes.changed.length > 0 ||
      roundtripDiff.edges.added.length > 0 ||
      roundtripDiff.edges.removed.length > 0 ||
      roundtripDiff.edges.changed.length > 0 ||
      roundtripDiff.notes.added.length > 0 ||
      roundtripDiff.notes.removed.length > 0 ||
      roundtripDiff.notes.changed.length > 0
  );

  if (hasDiff) {
    throw new DiagramError(
      'VALIDATION_ERROR',
      'documentToOps roundtrip validation failed against target document',
      4,
      { diff: roundtripDiff }
    );
  }

  return ops;
}
