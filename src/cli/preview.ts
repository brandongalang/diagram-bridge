import type { DocumentDiff, PullResult } from '../core/types.js';

export function documentChanged(diff: DocumentDiff): boolean {
  return Boolean(
    diff.title ||
      diff.nodes.added.length ||
      diff.nodes.removed.length ||
      diff.nodes.changed.length ||
      diff.edges.added.length ||
      diff.edges.removed.length ||
      diff.edges.changed.length ||
      diff.notes.added.length ||
      diff.notes.removed.length ||
      diff.notes.changed.length
  );
}

export function briefPull(result: PullResult) {
  const { document, ...rest } = result;
  return {
    documentId: document.documentId,
    title: document.title,
    headRevision: rest.headRevision,
    baseRevision: rest.baseRevision,
    counts: {
      nodes: document.nodes.length,
      edges: document.edges.length,
      notes: document.notes.length,
    },
    summary: summarizeDiff(rest.diff, rest.noteActivity),
    diff: rest.diff,
    revisions: rest.revisions,
    noteActivity: rest.noteActivity,
  };
}

function summarizeDiff(diff: DocumentDiff | null, noteActivity: PullResult['noteActivity']) {
  if (!diff) {
    return {
      hasChanges: null,
      comparison: 'No baseline supplied; use read to inspect this revision.',
      layout: { count: 0, changedNodes: [] as { id: string; fields: string[] }[] },
      content: {
        title: null,
        nodesAdded: [] as string[],
        nodesRemoved: [] as string[],
        nodesChanged: [] as { id: string; fields: string[] }[],
        edgesAdded: [] as string[],
        edgesRemoved: [] as string[],
        edgesChanged: [] as { id: string; fields: string[] }[],
      },
      notes: {
        added: [] as { id: string; author: string }[],
        removed: [] as string[],
        changed: [] as { id: string; fields: string[] }[],
        activityCount: 0,
      },
    };
  }

  const layoutNodes = diff.nodes.changed
    .filter(change => change.fields.includes('layout'))
    .map(change => ({ id: change.id, fields: ['layout'] }));
  const contentNodeChanges = diff.nodes.changed
    .filter(change => change.fields.some(field => field !== 'layout'))
    .map(change => ({ id: change.id, fields: change.fields.filter(field => field !== 'layout') }));

  return {
    hasChanges: documentChanged(diff) || noteActivity.length > 0,
    layout: { count: layoutNodes.length, changedNodes: layoutNodes },
    content: {
      title: diff.title,
      nodesAdded: diff.nodes.added.map(node => node.id),
      nodesRemoved: diff.nodes.removed.map(node => node.id),
      nodesChanged: contentNodeChanges,
      edgesAdded: diff.edges.added.map(edge => edge.id),
      edgesRemoved: diff.edges.removed.map(edge => edge.id),
      edgesChanged: diff.edges.changed.map(change => ({ id: change.id, fields: change.fields })),
    },
    notes: {
      added: diff.notes.added.map(note => ({ id: note.id, author: note.author })),
      removed: diff.notes.removed.map(note => note.id),
      changed: diff.notes.changed.map(change => ({ id: change.id, fields: change.fields })),
      activityCount: noteActivity.reduce((count, item) => count + item.notes.added.length + item.notes.removed.length + item.notes.changed.length, 0),
    },
  };
}
