import { DiagramError } from './errors.js';
import { DEFAULT_DIMENSIONS, LIMITS, validateDocument, validateOperations } from './schema.js';
import type {
  DiagramDocument,
  DiagramNode,
  DiagramEdge,
  DiagramNote,
  Operation,
  NodeInput,
  Layout
} from './types.js';

export function applyOps(doc: DiagramDocument, operations: Operation[]): DiagramDocument {
  // Validate operations and document boundary
  validateDocument(doc);
  const validatedOps = validateOperations(operations);

  // Deep clone collections to guarantee purity
  let title = doc.title;
  const nodesMap = new Map<string, DiagramNode>(doc.nodes.map((n) => [n.id, { ...n, layout: { ...n.layout } }]));
  const edgesMap = new Map<string, DiagramEdge>(doc.edges.map((e) => [e.id, { ...e }]));
  const notesMap = new Map<string, DiagramNote>(
    doc.notes.map((n) => [n.id, { ...n, anchor: { ...n.anchor } }])
  );

  // Helper to calculate next unpositioned Y
  function getNextUnpositionedY(): number {
    let maxY = 0;
    for (const node of nodesMap.values()) {
      if (!node.parentId) {
        const bottom = node.layout.y + node.layout.height;
        if (bottom > maxY) {
          maxY = bottom;
        }
      }
    }
    return nodesMap.size > 0 ? maxY + 40 : 40;
  }

  let nextAutoY = getNextUnpositionedY();

  for (const op of validatedOps) {
    switch (op.type) {
      case 'setTitle': {
        if (!op.title || op.title.length > LIMITS.MAX_TITLE_LENGTH) {
          throw new DiagramError(
            'VALIDATION_ERROR',
            `Title must be between 1 and ${LIMITS.MAX_TITLE_LENGTH} characters`,
            4
          );
        }
        title = op.title;
        break;
      }

      case 'addNode': {
        const input: NodeInput = op.node;
        if (nodesMap.has(input.id)) {
          throw new DiagramError('INVALID_OPERATION', `Node with id '${input.id}' already exists`, 4);
        }

        const defaults = DEFAULT_DIMENSIONS[input.kind];
        const width = input.layout?.width ?? defaults.width;
        const height = input.layout?.height ?? defaults.height;

        let x: number;
        let y: number;

        if (input.layout?.x !== undefined && input.layout?.y !== undefined) {
          x = input.layout.x;
          y = input.layout.y;
        } else {
          x = input.layout?.x ?? 40;
          y = input.layout?.y ?? nextAutoY;
          nextAutoY = y + height + 40;
        }

        const layout: Layout = { x, y, width, height };

        const newNode: DiagramNode = {
          id: input.id,
          kind: input.kind,
          label: input.label,
          layout,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.ref ? { ref: input.ref } : {}),
        };

        nodesMap.set(newNode.id, newNode);
        break;
      }

      case 'updateNode': {
        const existing = nodesMap.get(op.id);
        if (!existing) {
          throw new DiagramError('INVALID_OPERATION', `Cannot update non-existent node '${op.id}'`, 4);
        }

        const patch = op.patch;
        if (patch.kind !== undefined) {
          existing.kind = patch.kind;
        }
        if (patch.label !== undefined) {
          existing.label = patch.label;
        }
        if (patch.ref !== undefined) {
          if (patch.ref === null) {
            delete existing.ref;
          } else {
            existing.ref = patch.ref;
          }
        }
        if (patch.layout !== undefined) {
          existing.layout = {
            x: patch.layout.x ?? existing.layout.x,
            y: patch.layout.y ?? existing.layout.y,
            width: patch.layout.width ?? existing.layout.width,
            height: patch.layout.height ?? existing.layout.height,
          };
        }
        if (patch.parentId !== undefined) {
          if (patch.parentId === null) {
            delete existing.parentId;
          } else {
            existing.parentId = patch.parentId;
          }
        }
        break;
      }

      case 'removeNode': {
        const targetNode = nodesMap.get(op.id);
        if (!targetNode) {
          throw new DiagramError('INVALID_OPERATION', `Cannot remove non-existent node '${op.id}'`, 4);
        }

        const cascade = Boolean(op.cascade);

        // Find incident edges
        const incidentEdges = Array.from(edgesMap.values()).filter(
          (e) => e.source === op.id || e.target === op.id
        );

        // Find child nodes
        const childNodes = Array.from(nodesMap.values()).filter((n) => n.parentId === op.id);

        if (!cascade && (incidentEdges.length > 0 || childNodes.length > 0)) {
          throw new DiagramError(
            'INVALID_OPERATION',
            `Cannot remove node '${op.id}' with incident edges or children without cascade: true`,
            4
          );
        }

        // Collect all nodes to remove (target + descendants if cascade)
        const nodesToRemove = new Map<string, DiagramNode>();
        nodesToRemove.set(targetNode.id, targetNode);

        if (cascade) {
          const queue = [...childNodes];
          while (queue.length > 0) {
            const child = queue.shift()!;
            nodesToRemove.set(child.id, child);
            const grandchildren = Array.from(nodesMap.values()).filter((n) => n.parentId === child.id);
            queue.push(...grandchildren);
          }
        }

        // Collect all edges connected to any of the nodes to remove
        const edgesToRemove = Array.from(edgesMap.values()).filter(
          (e) => nodesToRemove.has(e.source) || nodesToRemove.has(e.target)
        );

        // Remove edges and detach notes
        for (const edge of edgesToRemove) {
          edgesMap.delete(edge.id);
          for (const note of notesMap.values()) {
            if (note.anchor.type === 'edge' && note.anchor.id === edge.id) {
              note.anchor = {
                type: 'detached',
                previousType: 'edge',
                previousId: edge.id,
                previousLabel: edge.label ?? '',
              };
            }
          }
        }

        // Remove nodes and detach notes
        for (const node of nodesToRemove.values()) {
          nodesMap.delete(node.id);
          for (const note of notesMap.values()) {
            if (note.anchor.type === 'node' && note.anchor.id === node.id) {
              note.anchor = {
                type: 'detached',
                previousType: 'node',
                previousId: node.id,
                previousLabel: node.label,
              };
            }
          }
        }
        break;
      }

      case 'addEdge': {
        if (edgesMap.has(op.edge.id)) {
          throw new DiagramError('INVALID_OPERATION', `Edge with id '${op.edge.id}' already exists`, 4);
        }
        edgesMap.set(op.edge.id, { ...op.edge });
        break;
      }

      case 'updateEdge': {
        const existing = edgesMap.get(op.id);
        if (!existing) {
          throw new DiagramError('INVALID_OPERATION', `Cannot update non-existent edge '${op.id}'`, 4);
        }
        if (op.patch.source !== undefined) {
          existing.source = op.patch.source;
        }
        if (op.patch.target !== undefined) {
          existing.target = op.patch.target;
        }
        if (op.patch.label !== undefined) {
          if (op.patch.label === null) {
            delete existing.label;
          } else {
            existing.label = op.patch.label;
          }
        }
        break;
      }

      case 'removeEdge': {
        const existing = edgesMap.get(op.id);
        if (!existing) {
          throw new DiagramError('INVALID_OPERATION', `Cannot remove non-existent edge '${op.id}'`, 4);
        }
        edgesMap.delete(op.id);
        // Detach notes anchored to this edge
        for (const note of notesMap.values()) {
          if (note.anchor.type === 'edge' && note.anchor.id === op.id) {
            note.anchor = {
              type: 'detached',
              previousType: 'edge',
              previousId: existing.id,
              previousLabel: existing.label ?? '',
            };
          }
        }
        break;
      }

      case 'addNote': {
        if (notesMap.has(op.note.id)) {
          throw new DiagramError('INVALID_OPERATION', `Note with id '${op.note.id}' already exists`, 4);
        }
        notesMap.set(op.note.id, {
          ...op.note,
          anchor: { ...op.note.anchor },
        });
        break;
      }

      case 'updateNote': {
        const existing = notesMap.get(op.id);
        if (!existing) {
          throw new DiagramError('INVALID_OPERATION', `Cannot update non-existent note '${op.id}'`, 4);
        }
        if (op.patch.body !== undefined) {
          existing.body = op.patch.body;
        }
        if (op.patch.author !== undefined) {
          existing.author = op.patch.author;
        }
        if (op.patch.anchor !== undefined) {
          existing.anchor = { ...op.patch.anchor };
        }
        break;
      }

      case 'removeNote': {
        if (!notesMap.has(op.id)) {
          throw new DiagramError('INVALID_OPERATION', `Cannot remove non-existent note '${op.id}'`, 4);
        }
        notesMap.delete(op.id);
        break;
      }
    }
  }

  // Check limits
  if (nodesMap.size > LIMITS.MAX_NODES) {
    throw new DiagramError('VALIDATION_ERROR', `Node limit exceeded: ${nodesMap.size} > ${LIMITS.MAX_NODES}`, 4);
  }
  if (edgesMap.size > LIMITS.MAX_EDGES) {
    throw new DiagramError('VALIDATION_ERROR', `Edge limit exceeded: ${edgesMap.size} > ${LIMITS.MAX_EDGES}`, 4);
  }
  if (notesMap.size > LIMITS.MAX_NOTES) {
    throw new DiagramError('VALIDATION_ERROR', `Note limit exceeded: ${notesMap.size} > ${LIMITS.MAX_NOTES}`, 4);
  }

  // Build new document preserving revision and metadata
  const newDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: doc.documentId,
    revision: doc.revision,
    title,
    nodes: Array.from(nodesMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(edgesMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    notes: Array.from(notesMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    ...(doc.lineage ? { lineage: { ...doc.lineage } } : {}),
  };

  // Validate complete final document (size, shape, metadata, graph)
  return validateDocument(newDoc);
}
