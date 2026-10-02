import type { DiagramDocument, DiagramEdge, SelectedElement } from '../types.js';
import { routeEdge, type Rect, type RouteResult, type Side } from '../routing/index.js';

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 88;

export type LiveCanvasNode = {
  id: string;
  type?: string | null;
  parentId?: string;
  position: { x: number; y: number };
  style?: { width?: number | string; height?: number | string };
  selected?: boolean;
};

export type ProjectedRfNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  parentId?: string;
  style: { width: number; height: number; zIndex: number };
  selected: boolean;
  draggable: boolean;
  selectable: boolean;
  data: {
    id: string;
    label: string;
    kind: string;
    parentId?: string;
    noteCount: number;
    isExport: boolean;
  };
};

export type RoutedCanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: Side;
  targetHandle: Side;
  type: 'custom';
  label: string | undefined;
  selected: boolean;
  selectable: boolean;
  data: {
    route: RouteResult;
    isExport: boolean;
    label: string | undefined;
  };
};

export type RouteProjectionInput = {
  documentId: string;
  liveNodes: LiveCanvasNode[];
  edges: ReadonlyArray<Pick<DiagramEdge, 'id' | 'source' | 'target' | 'label'>>;
  selectedElement: SelectedElement;
  isExport: boolean;
};

export type RouteProjection = {
  edges: RoutedCanvasEdge[];
  blockedRoutes: RoutedCanvasEdge[];
};

type CachedRoute = { key: string; route: RouteResult };

function numericSize(value: number | string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

export function absoluteNodeBounds(nodes: ReadonlyArray<LiveCanvasNode>): Map<string, Rect> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return new Map(
    nodes.map((n) => {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      const bounds: Rect = {
        id: n.id,
        x: n.position.x + (parent?.position.x ?? 0),
        y: n.position.y + (parent?.position.y ?? 0),
        width: numericSize(n.style?.width, DEFAULT_WIDTH),
        height: numericSize(n.style?.height, DEFAULT_HEIGHT)
      };
      return [n.id, bounds];
    })
  );
}

function sceneGeometryKey(nodes: ReadonlyArray<LiveCanvasNode>, bounds: Map<string, Rect>): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.type === 'group') continue;
    const b = bounds.get(n.id);
    if (!b) continue;
    parts.push(`${b.id}:${b.x}:${b.y}:${b.width}:${b.height}`);
  }
  parts.sort();
  return parts.join('|');
}

function edgeRouteKey(
  edge: Pick<DiagramEdge, 'id' | 'source' | 'target' | 'label'>,
  bounds: Map<string, Rect>
): string | null {
  const source = bounds.get(edge.source);
  const target = bounds.get(edge.target);
  if (!source || !target) return null;
  return [
    edge.id,
    edge.source,
    source.x,
    source.y,
    source.width,
    source.height,
    edge.target,
    target.x,
    target.y,
    target.width,
    target.height,
    edge.label ?? ''
  ].join(':');
}

export function projectNodes(
  doc: Pick<DiagramDocument, 'nodes' | 'notes'>,
  selectedElement: SelectedElement,
  readOnly: boolean,
  isExport: boolean
): ProjectedRfNode[] {
  const noteCountByNode = new Map<string, number>();
  for (const note of doc.notes) {
    if (note.anchor.type !== 'node') continue;
    noteCountByNode.set(note.anchor.id, (noteCountByNode.get(note.anchor.id) ?? 0) + 1);
  }

  const groupNodes = doc.nodes.filter((n) => n.kind === 'group');
  const leafNodes = doc.nodes.filter((n) => n.kind !== 'group');

  return [...groupNodes, ...leafNodes].map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.layout.x, y: n.layout.y },
    parentId: n.parentId,
    style: {
      width: n.layout.width,
      height: n.layout.height,
      zIndex: n.kind === 'group' ? -1 : 1
    },
    selected: selectedElement?.type === 'node' && selectedElement.id === n.id,
    draggable: !readOnly && !isExport,
    selectable: !isExport,
    data: {
      id: n.id,
      label: n.label,
      kind: n.kind,
      parentId: n.parentId,
      noteCount: noteCountByNode.get(n.id) ?? 0,
      isExport
    }
  }));
}

export class CanvasRouteCache {
  private documentId: string | null = null;
  private sceneKey = '';
  private entries = new Map<string, CachedRoute>();

  project(input: RouteProjectionInput): RouteProjection {
    if (this.documentId !== input.documentId) {
      this.entries.clear();
      this.sceneKey = '';
      this.documentId = input.documentId;
    }

    const bounds = absoluteNodeBounds(input.liveNodes);
    const sceneKey = sceneGeometryKey(input.liveNodes, bounds);
    const sceneUnchanged = sceneKey === this.sceneKey;
    this.sceneKey = sceneKey;

    const obstacles = input.liveNodes
      .filter((n) => n.type !== 'group')
      .map((n) => bounds.get(n.id)!)
      .filter(Boolean);

    const next = new Map<string, CachedRoute>();
    const edges: RoutedCanvasEdge[] = [];

    for (const edge of input.edges) {
      const key = edgeRouteKey(edge, bounds);
      if (!key) continue;
      const source = bounds.get(edge.source)!;
      const target = bounds.get(edge.target)!;
      const prev = this.entries.get(edge.id);
      let route: RouteResult;
      if (sceneUnchanged && prev && prev.key === key) {
        route = prev.route;
      } else {
        route = routeEdge({ source, target, obstacles, label: edge.label });
      }
      next.set(edge.id, { key, route });
      const selected = input.selectedElement?.type === 'edge' && input.selectedElement.id === edge.id;
      edges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: route.sourceSide,
        targetHandle: route.targetSide,
        type: 'custom',
        label: edge.label,
        selected,
        selectable: !input.isExport,
        data: { route, isExport: input.isExport, label: edge.label }
      });
    }

    this.entries = next;
    return { edges, blockedRoutes: edges.filter((e) => e.data.route.unroutable) };
  }
}
