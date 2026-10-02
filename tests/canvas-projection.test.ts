import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramDocument, DiagramEdge, DiagramNode, DiagramNote } from '../src/core/types.js';
import {
  CanvasRouteCache,
  projectNodes,
  type LiveCanvasNode
} from '../src/editor/canvas/projection.js';

function live(
  id: string,
  x: number,
  y: number,
  extra: Partial<LiveCanvasNode> & { width?: number; height?: number } = {}
): LiveCanvasNode {
  const { width = 220, height = 88, style, ...rest } = extra;
  return {
    id,
    type: extra.type ?? 'step',
    position: { x, y },
    style: { width, height, ...style },
    ...rest
  };
}

function cloneLive(nodes: LiveCanvasNode[]): LiveCanvasNode[] {
  return nodes.map((n) => ({
    ...n,
    selected: n.selected,
    position: { ...n.position },
    style: n.style ? { ...n.style } : undefined
  }));
}

function sampleDoc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  const nodes: DiagramNode[] = [
    { id: 'a', kind: 'step', label: 'Ingest', layout: { x: 80, y: 120, width: 220, height: 88 } },
    { id: 'b', kind: 'step', label: 'Store', layout: { x: 480, y: 120, width: 220, height: 88 } }
  ];
  const edges: DiagramEdge[] = [{ id: 'e1', source: 'a', target: 'b', label: 'persist' }];
  return {
    schemaVersion: 1,
    documentId: 'doc-a',
    revision: 1,
    title: 'Sample',
    nodes,
    edges,
    notes: [],
    ...overrides
  };
}

function project(
  cache: CanvasRouteCache,
  liveNodes: LiveCanvasNode[],
  edges: DiagramEdge[],
  extra: { documentId?: string; selectedElement?: { type: 'edge'; id: string } | { type: 'node'; id: string } | null; isExport?: boolean } = {}
) {
  return cache.project({
    documentId: extra.documentId ?? 'doc-a',
    liveNodes,
    edges,
    selectedElement: extra.selectedElement ?? null,
    isExport: extra.isExport ?? false
  });
}

describe('projectNodes', () => {
  test('counts node-anchored notes in one pass and ignores other anchors', () => {
    const notes: DiagramNote[] = [
      { id: 'n1', body: 'one', author: 'a', anchor: { type: 'node', id: 'a' } },
      { id: 'n2', body: 'two', author: 'a', anchor: { type: 'node', id: 'a' } },
      { id: 'n3', body: 'edge', author: 'a', anchor: { type: 'edge', id: 'e1' } },
      { id: 'n4', body: 'diagram', author: 'a', anchor: { type: 'diagram' } }
    ];
    const nodes = projectNodes(sampleDoc({ notes }), { type: 'node', id: 'b' }, false, false);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    assert.equal(byId.get('a')?.data.noteCount, 2);
    assert.equal(byId.get('b')?.data.noteCount, 0);
    assert.equal(byId.get('b')?.selected, true);
    assert.equal(byId.get('a')?.selected, false);
  });
});

describe('CanvasRouteCache', () => {
  const nodes = [live('a', 80, 120), live('b', 480, 120), live('o', 300, 300)];
  const edges: DiagramEdge[] = [
    { id: 'e1', source: 'a', target: 'b', label: 'persist' },
    { id: 'e2', source: 'a', target: 'o' }
  ];

  test('cloned live nodes with selection, node label, and note-only changes reuse route identities', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const labeled = cloneLive(nodes).map((n) =>
      n.id === 'a' ? { ...n, selected: true, data: { label: 'Renamed', noteCount: 3 } } : { ...n, selected: false }
    );
    const second = project(cache, labeled, edges, { selectedElement: { type: 'node', id: 'a' } });
    assert.equal(first.edges[0].data.route, second.edges[0].data.route);
    assert.equal(first.edges[1].data.route, second.edges[1].data.route);
    assert.equal(first.edges[0].sourceHandle, second.edges[0].sourceHandle);
    assert.equal(first.edges[0].targetHandle, second.edges[0].targetHandle);
  });

  test('measured dimensions with unchanged numeric size do not reroute', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const measured = cloneLive(nodes).map((n) => ({
      ...n,
      style: { ...n.style, width: String(n.style?.width ?? 220), height: n.style?.height }
    }));
    const second = project(cache, measured, edges);
    assert.equal(first.edges[0].data.route, second.edges[0].data.route);
    assert.equal(first.edges[1].data.route, second.edges[1].data.route);
  });

  test('endpoint movement invalidates routes', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const moved = cloneLive(nodes).map((n) =>
      n.id === 'a' ? { ...n, position: { x: n.position.x + 40, y: n.position.y } } : n
    );
    const second = project(cache, moved, edges);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
    assert.notEqual(first.edges[1].data.route, second.edges[1].data.route);
  });

  test('obstacle movement invalidates all routes', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const moved = cloneLive(nodes).map((n) =>
      n.id === 'o' ? { ...n, position: { x: 280, y: 100 } } : n
    );
    const second = project(cache, moved, edges);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
    assert.notEqual(first.edges[1].data.route, second.edges[1].data.route);
  });

  test('group movement updates child absolute positions and invalidates', () => {
    const grouped = [
      live('g', 0, 0, { type: 'group', width: 700, height: 500 }),
      live('a', 80, 120, { parentId: 'g' }),
      live('b', 480, 120, { parentId: 'g' })
    ];
    const groupedEdges: DiagramEdge[] = [{ id: 'e1', source: 'a', target: 'b', label: 'persist' }];
    const cache = new CanvasRouteCache();
    const first = project(cache, grouped, groupedEdges);
    const moved = cloneLive(grouped).map((n) =>
      n.id === 'g' ? { ...n, position: { x: 60, y: 20 } } : n
    );
    const second = project(cache, moved, groupedEdges);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
    assert.equal(first.edges[0].sourceHandle, 'right');
    assert.equal(first.edges[0].targetHandle, 'left');
  });

  test('dimension changes invalidate routes', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const resized = cloneLive(nodes).map((n) =>
      n.id === 'b' ? { ...n, style: { ...n.style, width: 300, height: 88 } } : n
    );
    const second = project(cache, resized, edges);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
  });

  test('edge label update recomputes only that route', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const relabeled: DiagramEdge[] = [
      { id: 'e1', source: 'a', target: 'b', label: 'updated' },
      edges[1]
    ];
    const second = project(cache, cloneLive(nodes), relabeled);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
    assert.equal(first.edges[1].data.route, second.edges[1].data.route);
  });

  test('source and target rewires recompute only that edge', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const rewired: DiagramEdge[] = [
      { id: 'e1', source: 'a', target: 'o', label: 'persist' },
      edges[1]
    ];
    const second = project(cache, cloneLive(nodes), rewired);
    assert.notEqual(first.edges[0].data.route, second.edges[0].data.route);
    assert.equal(first.edges[1].data.route, second.edges[1].data.route);
    assert.equal(second.edges[0].target, 'o');
  });

  test('removed edges are pruned from output and remaining identities stay', () => {
    const cache = new CanvasRouteCache();
    const first = project(cache, nodes, edges);
    const second = project(cache, cloneLive(nodes), [edges[0]]);
    assert.equal(second.edges.length, 1);
    assert.equal(second.edges[0].id, 'e1');
    assert.equal(first.edges[0].data.route, second.edges[0].data.route);
    const restored = project(cache, cloneLive(nodes), edges);
    assert.equal(restored.edges.length, 2);
    assert.equal(restored.edges[0].data.route, first.edges[0].data.route);
    assert.notEqual(restored.edges[1].data.route, first.edges[1].data.route);
  });

  test('document switching isolates the cache', () => {
    const cache = new CanvasRouteCache();
    const fromA = project(cache, nodes, edges, { documentId: 'doc-a' });
    const fromB = project(cache, cloneLive(nodes), edges, { documentId: 'doc-b' });
    assert.notEqual(fromA.edges[0].data.route, fromB.edges[0].data.route);
    const againA = project(cache, cloneLive(nodes), edges, { documentId: 'doc-a' });
    assert.notEqual(fromA.edges[0].data.route, againA.edges[0].data.route);
    assert.notEqual(fromB.edges[0].data.route, againA.edges[0].data.route);
  });

  test('preserves blocked route detection', () => {
    const overlapping = [live('a', 0, 0), live('b', 10, 10)];
    const cache = new CanvasRouteCache();
    const result = project(cache, overlapping, [{ id: 'blocked', source: 'a', target: 'b' }]);
    assert.equal(result.edges[0].data.route.unroutable, true);
    assert.equal(result.blockedRoutes.length, 1);
    assert.equal(result.blockedRoutes[0].id, 'blocked');
  });
});
