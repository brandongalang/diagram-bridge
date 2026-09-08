import { z } from 'zod';
import { DiagramError } from './errors.js';
import { assertNoPrototypePollution } from './canonical.js';
import type {
  DiagramDocument,
  DiagramNode,
  DiagramEdge,
  DiagramNote,
  Operation,
  NodeInput,
  Layout,
  Anchor,
  NodeKind
} from './types.js';

export const LIMITS = {
  MAX_NODES: 1000,
  MAX_EDGES: 2000,
  MAX_NOTES: 1000,
  MAX_OPERATIONS: 5000,
  MAX_JSON_BYTES: 5 * 1024 * 1024,
  MAX_LABEL_LENGTH: 2000,
  MAX_NOTE_BODY_LENGTH: 20000,
  MAX_TITLE_LENGTH: 200,
  MAX_ID_LENGTH: 100,
  COORD_MIN: -100000,
  COORD_MAX: 100000,
} as const;

export const DEFAULT_DIMENSIONS: Record<NodeKind, { width: number; height: number }> = {
  step: { width: 220, height: 88 },
  decision: { width: 220, height: 110 },
  datastore: { width: 220, height: 88 },
  group: { width: 700, height: 500 },
  text: { width: 260, height: 64 },
};

const ID_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;
const PROHIBITED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export const idSchema = z
  .string()
  .min(1)
  .max(LIMITS.MAX_ID_LENGTH)
  .regex(ID_REGEX, { message: 'ID must consist of 1-100 ASCII alphanumeric characters, dots, dashes, or underscores' })
  .refine((val) => !PROHIBITED_IDS.has(val), { message: 'Prototype-sensitive ID is prohibited' });

export const nodeKindSchema = z.enum(['step', 'decision', 'datastore', 'text', 'group']);

export const layoutSchema = z
  .object({
    x: z.number().finite().min(LIMITS.COORD_MIN).max(LIMITS.COORD_MAX),
    y: z.number().finite().min(LIMITS.COORD_MIN).max(LIMITS.COORD_MAX),
    width: z.number().finite().positive().max(LIMITS.COORD_MAX),
    height: z.number().finite().positive().max(LIMITS.COORD_MAX),
  })
  .strict();

export const partialLayoutSchema = z
  .object({
    x: z.number().finite().min(LIMITS.COORD_MIN).max(LIMITS.COORD_MAX).optional(),
    y: z.number().finite().min(LIMITS.COORD_MIN).max(LIMITS.COORD_MAX).optional(),
    width: z.number().finite().positive().max(LIMITS.COORD_MAX).optional(),
    height: z.number().finite().positive().max(LIMITS.COORD_MAX).optional(),
  })
  .strict();

export const diagramNodeSchema = z
  .object({
    id: idSchema,
    kind: nodeKindSchema,
    label: z.string().max(LIMITS.MAX_LABEL_LENGTH),
    layout: layoutSchema,
    parentId: idSchema.optional(),
    ref: z.string().max(200).optional(),
  })
  .strict();

export const nodeInputSchema = z
  .object({
    id: idSchema,
    kind: nodeKindSchema,
    label: z.string().max(LIMITS.MAX_LABEL_LENGTH),
    layout: partialLayoutSchema.optional(),
    parentId: idSchema.optional(),
    ref: z.string().max(200).optional(),
  })
  .strict();

export const diagramEdgeSchema = z
  .object({
    id: idSchema,
    source: idSchema,
    target: idSchema,
    label: z.string().max(LIMITS.MAX_LABEL_LENGTH).optional(),
  })
  .strict();

export const anchorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagram') }).strict(),
  z
    .object({
      type: z.union([z.literal('node'), z.literal('edge')]),
      id: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('detached'),
      previousType: z.union([z.literal('node'), z.literal('edge')]),
      previousId: idSchema,
      previousLabel: z.string().max(LIMITS.MAX_LABEL_LENGTH),
    })
    .strict(),
]);

export const diagramNoteSchema = z
  .object({
    id: idSchema,
    body: z.string().max(LIMITS.MAX_NOTE_BODY_LENGTH),
    author: z.string().min(1).max(100),
    anchor: anchorSchema,
  })
  .strict();

export const lineageSchema = z
  .object({
    documentId: idSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export const diagramDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentId: idSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(LIMITS.MAX_TITLE_LENGTH),
    nodes: z.array(diagramNodeSchema).max(LIMITS.MAX_NODES),
    edges: z.array(diagramEdgeSchema).max(LIMITS.MAX_EDGES),
    notes: z.array(diagramNoteSchema).max(LIMITS.MAX_NOTES),
    lineage: lineageSchema.optional(),
  })
  .strict();

export const operationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('addNode'),
      node: nodeInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('updateNode'),
      id: idSchema,
      patch: z
        .object({
          kind: nodeKindSchema.optional(),
          label: z.string().max(LIMITS.MAX_LABEL_LENGTH).optional(),
          ref: z.string().max(200).nullable().optional(),
          layout: partialLayoutSchema.optional(),
          parentId: idSchema.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeNode'),
      id: idSchema,
      cascade: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('addEdge'),
      edge: diagramEdgeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('updateEdge'),
      id: idSchema,
      patch: z
        .object({
          source: idSchema.optional(),
          target: idSchema.optional(),
          label: z.string().max(LIMITS.MAX_LABEL_LENGTH).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeEdge'),
      id: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('addNote'),
      note: diagramNoteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('updateNote'),
      id: idSchema,
      patch: z
        .object({
          body: z.string().max(LIMITS.MAX_NOTE_BODY_LENGTH).optional(),
          author: z.string().min(1).max(100).optional(),
          anchor: anchorSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeNote'),
      id: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('setTitle'),
      title: z.string().min(1).max(LIMITS.MAX_TITLE_LENGTH),
    })
    .strict(),
]);

export const operationsSchema = z.array(operationSchema).max(LIMITS.MAX_OPERATIONS);

export function validateGraphInvariants(doc: DiagramDocument): void {
  // Check unique IDs
  const nodeMap = new Map<string, DiagramNode>();
  for (const node of doc.nodes) {
    if (nodeMap.has(node.id)) {
      throw new DiagramError('VALIDATION_ERROR', `Duplicate node id: ${node.id}`, 4);
    }
    nodeMap.set(node.id, node);
  }

  const edgeMap = new Map<string, DiagramEdge>();
  for (const edge of doc.edges) {
    if (edgeMap.has(edge.id)) {
      throw new DiagramError('VALIDATION_ERROR', `Duplicate edge id: ${edge.id}`, 4);
    }
    edgeMap.set(edge.id, edge);

    // Validate endpoints
    const sourceNode = nodeMap.get(edge.source);
    if (!sourceNode) {
      throw new DiagramError('VALIDATION_ERROR', `Edge ${edge.id} source '${edge.source}' does not exist`, 4);
    }
    const targetNode = nodeMap.get(edge.target);
    if (!targetNode) {
      throw new DiagramError('VALIDATION_ERROR', `Edge ${edge.id} target '${edge.target}' does not exist`, 4);
    }

    // Group and text nodes cannot be edge endpoints
    if (sourceNode.kind === 'group' || sourceNode.kind === 'text') {
      throw new DiagramError(
        'VALIDATION_ERROR',
        `Edge ${edge.id} source '${edge.source}' cannot be of kind '${sourceNode.kind}'`,
        4
      );
    }
    if (targetNode.kind === 'group' || targetNode.kind === 'text') {
      throw new DiagramError(
        'VALIDATION_ERROR',
        `Edge ${edge.id} target '${edge.target}' cannot be of kind '${targetNode.kind}'`,
        4
      );
    }
  }

  // Validate group hierarchy (one level, no nesting, acyclic, parents must be group)
  for (const node of doc.nodes) {
    if (node.parentId) {
      if (node.id === node.parentId) {
        throw new DiagramError('VALIDATION_ERROR', `Node ${node.id} cannot be its own parent`, 4);
      }
      const parent = nodeMap.get(node.parentId);
      if (!parent) {
        throw new DiagramError('VALIDATION_ERROR', `Node ${node.id} parentId '${node.parentId}' does not exist`, 4);
      }
      if (parent.kind !== 'group') {
        throw new DiagramError(
          'VALIDATION_ERROR',
          `Node ${node.id} parentId '${node.parentId}' must be a group, got '${parent.kind}'`,
          4
        );
      }
      if (parent.parentId) {
        throw new DiagramError(
          'VALIDATION_ERROR',
          `Nested groups not supported: parent '${parent.id}' already has a parent`,
          4
        );
      }
      if (node.kind === 'group') {
        throw new DiagramError('VALIDATION_ERROR', `Group node '${node.id}' cannot be nested inside another group`, 4);
      }
    }
  }

  // Validate notes and anchors
  const noteIds = new Set<string>();
  for (const note of doc.notes) {
    if (noteIds.has(note.id)) {
      throw new DiagramError('VALIDATION_ERROR', `Duplicate note id: ${note.id}`, 4);
    }
    noteIds.add(note.id);

    if (note.anchor.type === 'node') {
      if (!nodeMap.has(note.anchor.id)) {
        throw new DiagramError('VALIDATION_ERROR', `Note ${note.id} anchor node '${note.anchor.id}' does not exist`, 4);
      }
    } else if (note.anchor.type === 'edge') {
      if (!edgeMap.has(note.anchor.id)) {
        throw new DiagramError('VALIDATION_ERROR', `Note ${note.id} anchor edge '${note.anchor.id}' does not exist`, 4);
      }
    }
  }
}

export function validateDocument(value: unknown): DiagramDocument {
  if (value === null || typeof value !== 'object') {
    throw new DiagramError('VALIDATION_ERROR', 'Document must be a non-null object', 4);
  }

  // Size guard
  const jsonStr = JSON.stringify(value);
  if (new TextEncoder().encode(jsonStr).byteLength > LIMITS.MAX_JSON_BYTES) {
    throw new DiagramError('VALIDATION_ERROR', `Document exceeds maximum size of 5 MiB`, 4);
  }

  // Prototype pollution guard
  assertNoPrototypePollution(value);

  // Check schemaVersion explicitly
  if ('schemaVersion' in value && (value as Record<string, unknown>).schemaVersion !== 1) {
    throw new DiagramError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Unsupported schemaVersion: ${(value as Record<string, unknown>).schemaVersion}`,
      4
    );
  }

  const result = diagramDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new DiagramError('VALIDATION_ERROR', 'Document validation failed', 4, result.error.format());
  }

  const doc = result.data as DiagramDocument;
  validateGraphInvariants(doc);

  // Return stably sorted entities
  return {
    ...doc,
    nodes: [...doc.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...doc.edges].sort((a, b) => a.id.localeCompare(b.id)),
    notes: [...doc.notes].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateOperations(value: unknown): Operation[] {
  if (!Array.isArray(value)) {
    throw new DiagramError('VALIDATION_ERROR', 'Operations must be an array', 4);
  }

  const jsonStr = JSON.stringify(value);
  if (new TextEncoder().encode(jsonStr).byteLength > LIMITS.MAX_JSON_BYTES) {
    throw new DiagramError('VALIDATION_ERROR', `Operations payload exceeds maximum size of 5 MiB`, 4);
  }

  assertNoPrototypePollution(value);

  const result = operationsSchema.safeParse(value);
  if (!result.success) {
    throw new DiagramError('VALIDATION_ERROR', 'Operations validation failed', 4, result.error.format());
  }

  return result.data as Operation[];
}
