import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  applyNodeChanges,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type Connection,
  type OnNodeDrag,
  type OnNodesChange
} from '@xyflow/react';
import { nodeTypes } from './nodes/nodeTypes.js';
import { edgeTypes } from './edges/edgeTypes.js';
import type {
  DiagramDocument,
  SelectedElement
} from '../types.js';
import '../canvas.css';
import { routeEdge } from '../routing/index.js';

interface CanvasProps {
  document: DiagramDocument;
  selectedElement: SelectedElement;
  onSelectElement: (element: SelectedElement) => void;
  onUpdateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  onConnect: (connection: Connection) => void;
  isExport?: boolean;
  readOnly?: boolean;
  fitViewTrigger?: number;
  onAddFirstNode?: () => void;
}

function buildRfNodes(
  doc: DiagramDocument,
  selectedElement: SelectedElement,
  readOnly: boolean,
  isExport: boolean
): Node[] {
  // In React Flow, group parent nodes must appear before child nodes
  const groupNodes = doc.nodes.filter((n) => n.kind === 'group');
  const leafNodes = doc.nodes.filter((n) => n.kind !== 'group');
  const sorted = [...groupNodes, ...leafNodes];

  return sorted.map((n) => {
    const isSelected = selectedElement?.type === 'node' && selectedElement.id === n.id;
    const notes = doc.notes.filter(
      (nt) => nt.anchor.type === 'node' && nt.anchor.id === n.id
    );

    return {
      id: n.id,
      type: n.kind,
      position: { x: n.layout.x, y: n.layout.y },
      parentId: n.parentId,
      style: {
        width: n.layout.width,
        height: n.layout.height,
        zIndex: n.kind === 'group' ? -1 : 1
      },
      selected: isSelected,
      draggable: !readOnly && !isExport,
      selectable: !isExport,
      data: {
        id: n.id,
        label: n.label,
        kind: n.kind,
        parentId: n.parentId,
        noteCount: notes.length,
        isExport
      }
    };
  });
}

const CanvasInner: React.FC<CanvasProps> = ({
  document: doc,
  selectedElement,
  onSelectElement,
  onUpdateNodePosition,
  onConnect,
  isExport = false,
  readOnly = false,
  fitViewTrigger,
  onAddFirstNode
}) => {
  const { fitView, fitBounds } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const readyTimeoutRef = useRef<any>(null);
  const isDraggingRef = useRef(false);
  const lastDocIdRef = useRef<string | null>(null);

  // Local nodes state for smooth 60fps dragging and selection changes
  const [nodes, setNodes] = useState<Node[]>(() =>
    buildRfNodes(doc, selectedElement, readOnly, isExport)
  );

  // Sync nodes from doc when doc changes and user is not actively dragging
  useEffect(() => {
    if (isDraggingRef.current) return;
    setNodes(buildRfNodes(doc, selectedElement, readOnly, isExport));
  }, [doc, selectedElement, readOnly, isExport]);

  // Viewport handling: On document switch, fit intentionally.
  // On clean refresh (same docId, new revision), preserve manual viewport.
  useEffect(() => {
    if (!doc.documentId || !nodesInitialized) return;

    if (lastDocIdRef.current !== doc.documentId) {
      lastDocIdRef.current = doc.documentId;
      fitView({ padding: isExport ? 0.12 : 0.2, duration: 200 });
    }
  }, [doc.documentId, fitView, isExport, nodesInitialized]);

  // Trigger fitView when fitViewTrigger changes
  useEffect(() => {
    if (fitViewTrigger !== undefined && fitViewTrigger > 0) {
      fitView({ padding: 0.2, duration: 200 });
    }
  }, [fitViewTrigger, fitView]);

  // Use live positions so connectors follow the nodes throughout a drag.
  const nodeBoundsMap = useMemo(() => {
    const byId = new Map(nodes.map(n => [n.id, n]));
    return new Map(nodes.map(n => {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      return [n.id, {
        id: n.id,
        x: n.position.x + (parent?.position.x ?? 0),
        y: n.position.y + (parent?.position.y ?? 0),
        width: Number(n.style?.width ?? 220),
        height: Number(n.style?.height ?? 88)
      }];
    }));
  }, [nodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const obstacles = nodes.filter(n => n.type !== 'group').map(n => nodeBoundsMap.get(n.id)!);
    return doc.edges.flatMap(e => {
      const source = nodeBoundsMap.get(e.source)!;
      const target = nodeBoundsMap.get(e.target)!;
      if (!source || !target) return [];
      const route = routeEdge({ source, target, obstacles, label: e.label });
      return {
        id: e.id, source: e.source, target: e.target,
        sourceHandle: route.sourceSide, targetHandle: route.targetSide,
        type: 'custom', label: e.label,
        selected: selectedElement?.type === 'edge' && selectedElement.id === e.id,
        selectable: !isExport,
        data: { route, isExport, label: e.label,
          onSelectEdge: (id: string) => {
            if (!isExport) onSelectElement({ type: 'edge', id });
          }
        }
      };
    });
  }, [doc.edges, nodes, nodeBoundsMap, selectedElement, isExport, onSelectElement]);
  const blockedRoutes = rfEdges.filter(e => (e.data?.route as ReturnType<typeof routeEdge>).unroutable);

  // onNodesChange handler for local drag state and selection; ignores built-in delete
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      if (readOnly || isExport) {
        const measurements = changes.filter(c => c.type === 'dimensions');
        if (measurements.length) setNodes(nds => applyNodeChanges(measurements, nds));
        return;
      }
      // Strip remove changes to prevent silent deletion
      const safeChanges = changes.filter((c) => c.type !== 'remove');
      setNodes((nds) => applyNodeChanges(safeChanges, nds));

      for (const c of changes) {
        if (c.type === 'select' && c.selected) {
          onSelectElement({ type: 'node', id: c.id });
        }
      }
    },
    [readOnly, isExport, onSelectElement]
  );

  const handleNodeDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_, node) => {
      isDraggingRef.current = false;
      if (readOnly || isExport) return;
      onUpdateNodePosition(node.id, {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y)
      });
    },
    [readOnly, isExport, onUpdateNodePosition]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || isExport) return;
      if (!connection.source || !connection.target) return;
      // Invariant: edges cannot connect to group or text nodes
      const sourceNode = doc.nodes.find((n) => n.id === connection.source);
      const targetNode = doc.nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;
      if (sourceNode.kind === 'group' || sourceNode.kind === 'text') return;
      if (targetNode.kind === 'group' || targetNode.kind === 'text') return;

      onConnect(connection);
    },
    [readOnly, isExport, doc.nodes, onConnect]
  );

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || isExport || selectedElement?.type !== 'node') return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
    };
    const direction = delta[event.key];
    if (!direction) return;
    const node = doc.nodes.find(n => n.id === selectedElement.id);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    onUpdateNodePosition(node.id, {
      x: Math.round(node.layout.x + direction[0] * step),
      y: Math.round(node.layout.y + direction[1] * step)
    });
  };

  // Export readiness contract: use useNodesInitialized, font loading, DOM count verification, fitView
  useEffect(() => {
    if (!isExport) return;

    let active = true;
    let pollCount = 0;
    const maxPolls = 100;

    const verifyAndSignalReady = () => {
      if (!active) return;
      pollCount++;

      // 1. Ensure React Flow has initialized nodes
      if (!nodesInitialized && doc.nodes.length > 0) {
        if (pollCount < maxPolls) {
          readyTimeoutRef.current = setTimeout(verifyAndSignalReady, 50);
          return;
        }
      }

      // 2. Ensure actual DOM node and edge counts match document
      const domNodes = document.querySelectorAll('.react-flow__node').length;
      const domEdges = document.querySelectorAll('.react-flow__edge').length;

      if (domNodes !== doc.nodes.length || domEdges !== doc.edges.length) {
        if (pollCount < maxPolls) {
          readyTimeoutRef.current = setTimeout(verifyAndSignalReady, 50);
          return;
        }
      }

      if (domNodes !== doc.nodes.length || domEdges !== doc.edges.length || (!nodesInitialized && doc.nodes.length > 0)) {
        (window as any).__DIAGRAM_ERROR__ = 'The canvas could not render every node and connection.';
        return;
      }
      if (blockedRoutes.length) {
        (window as any).__DIAGRAM_ERROR__ = 'Some connections have no clear route. Move overlapping nodes apart before exporting.';
        return;
      }

      // 3. Compute bounds from schema
      const gMap = new Map(
        doc.nodes.filter((n) => n.kind === 'group').map((n) => [n.id, n])
      );
      const boxes = doc.nodes.map((n) => {
        const parent = n.parentId ? gMap.get(n.parentId) : undefined;
        return {
          x: n.layout.x + (parent?.layout.x ?? 0),
          y: n.layout.y + (parent?.layout.y ?? 0),
          width: n.layout.width,
          height: n.layout.height
        };
      });

      for (const edge of rfEdges) {
        const route = edge.data?.route as ReturnType<typeof routeEdge>;
        for (const point of route.points) boxes.push({ ...point, width: 0, height: 0 });
        if (route.label) boxes.push(route.label);
      }
      const minX = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
      const minY = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
      const maxX = boxes.length ? Math.max(...boxes.map((b) => b.x + b.width)) : 600;
      const maxY = boxes.length ? Math.max(...boxes.map((b) => b.y + b.height)) : 400;

      const totalWidth = Math.max(1000, Math.ceil(maxX - minX + 240));
      const totalHeight = Math.max(700, Math.ceil(maxY - minY + 240));

      if (totalWidth > 4096 || totalHeight > 4096 || totalWidth * totalHeight > 16_000_000) {
        (window as any).__DIAGRAM_ERROR__ =
          'This diagram exceeds the 4096px / 16-megapixel snapshot limit.';
        return;
      }

      // Fit view cleanly to viewport
      void fitBounds({ x: minX, y: minY, width: maxX - minX || 600, height: maxY - minY || 400 }, { padding: 0.12, duration: 0 });

      // In next frame, verify DOM once more and commit __DIAGRAM_READY__
      requestAnimationFrame(() => {
        if (!active) return;
        const finalNodes = document.querySelectorAll('.react-flow__node').length;
        const finalEdges = document.querySelectorAll('.react-flow__edge').length;

        if (finalNodes !== doc.nodes.length || finalEdges !== doc.edges.length) {
          if (pollCount < maxPolls) {
            readyTimeoutRef.current = setTimeout(verifyAndSignalReady, 50);
            return;
          }
        }

        (window as any).__DIAGRAM_READY__ = {
          documentId: doc.documentId,
          revision: doc.revision,
          nodeCount: doc.nodes.length,
          edgeCount: doc.edges.length,
          bounds: {
            x: minX,
            y: minY,
            width: totalWidth,
            height: totalHeight
          }
        };
      });
    };

    if (document.fonts) {
      document.fonts.ready.then(() => {
        readyTimeoutRef.current = setTimeout(verifyAndSignalReady, 50);
      });
    } else {
      readyTimeoutRef.current = setTimeout(verifyAndSignalReady, 50);
    }

    return () => {
      active = false;
      if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
    };
  }, [isExport, doc, nodesInitialized, fitBounds, rfEdges]);

  return (
    <div
      data-testid="diagram-canvas"
      onKeyDownCapture={handleCanvasKeyDown}
      className={`canvas-container ${isExport ? 'export-canvas' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        background: isExport ? '#ffffff' : '#f8fafc',
        position: 'relative'
      }}
    >
      {!isExport && blockedRoutes.length > 0 && (
        <div className="routing-warning" role="status">
          {blockedRoutes.length} connection{blockedRoutes.length === 1 ? '' : 's'} cannot be routed. Move overlapping nodes apart.
        </div>
      )}
      {!isExport && doc.nodes.length === 0 && <div className="canvas-empty">
        <h1>Start with a step</h1>
        <p>Add a step, connect it to another node, and leave notes for your agent.</p>
        <button type="button" className="btn btn-primary" onClick={onAddFirstNode}>Add first step</button>
        <p className="field-hint">Save your diagram, then use Agent handoff to continue the conversation.</p>
      </div>}
      {!isExport && doc.nodes.length > 0 && <div className="canvas-hint">Drag canvas to pan · Scroll to zoom · Arrow keys move the selected node</div>}
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, node) => {
          if (!isExport) onSelectElement({ type: 'node', id: node.id });
        }}
        onEdgeClick={(_, edge) => {
          if (!isExport) onSelectElement({ type: 'edge', id: edge.id });
        }}
        onPaneClick={() => {
          if (!isExport) onSelectElement(null);
        }}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        minZoom={0.1}
        maxZoom={2.5}
        nodesDraggable={!readOnly && !isExport}
        nodesConnectable={!readOnly && !isExport}
        elementsSelectable={!isExport}
        panOnDrag={!isExport}
        zoomOnScroll={!isExport}
        deleteKeyCode={null}
        nodesFocusable={!isExport}
        edgesFocusable={!isExport}
      >
        {!isExport && (
          <>
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1.5}
              color="#cbd5e1"
            />
            <Controls
              showInteractive={false}
              style={{
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: '0 2px 8px rgba(15,23,42,0.08)',
                border: '1px solid #cbd5e1'
              }}
            />
          </>
        )}
      </ReactFlow>
    </div>
  );
};

export const Canvas: React.FC<CanvasProps> = (props) => {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
};
