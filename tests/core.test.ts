import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDocument,
  validateOperations,
  applyOps,
  diffDocuments,
  documentToOps,
  canonicalJson,
  DiagramError,
  type DiagramDocument,
  type Operation
} from '../src/core/index.js';

describe('Core Schema & Validation', () => {
  const baseDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: 'doc-1',
    revision: 1,
    title: 'Test Document',
    nodes: [
      { id: 'node-1', kind: 'step', label: 'Step 1', layout: { x: 10, y: 20, width: 220, height: 88 } },
      { id: 'node-2', kind: 'decision', label: 'Decision 1', layout: { x: 300, y: 20, width: 220, height: 110 } },
    ],
    edges: [
      { id: 'edge-1', source: 'node-1', target: 'node-2', label: 'Next' }
    ],
    notes: [
      { id: 'note-1', body: 'First note', author: 'agent', anchor: { type: 'node', id: 'node-1' } },
      { id: 'note-2', body: 'Global note', author: 'human', anchor: { type: 'diagram' } },
    ]
  };

  test('validates valid document and preserves stable sort order', () => {
    const validated = validateDocument(baseDoc);
    assert.equal(validated.documentId, 'doc-1');
    assert.equal(validated.nodes.length, 2);
    assert.equal(validated.nodes[0].id, 'node-1');
  });

  test('rejects unsupported schema version', () => {
    const invalidDoc = { ...baseDoc, schemaVersion: 2 };
    assert.throws(
      () => validateDocument(invalidDoc),
      (err: any) => err instanceof DiagramError && err.code === 'UNSUPPORTED_SCHEMA_VERSION'
    );
  });

  test('rejects prototype pollution attempts', () => {
    const maliciousDoc = JSON.parse(JSON.stringify(baseDoc));
    maliciousDoc['__proto__'] = { admin: true };
    assert.throws(
      () => validateDocument(maliciousDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    const maliciousOps = [
      { type: 'setTitle', title: 'Pollution', __proto__: { evil: true } }
    ];
    assert.throws(
      () => validateOperations(maliciousOps),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('rejects unexpected / extra properties strictly without silent stripping', () => {
    const extraDoc = {
      ...baseDoc,
      extraUnauthorizedField: 'malicious'
    };
    assert.throws(
      () => validateDocument(extraDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('enforces safe ASCII ID format', () => {
    const invalidIdDoc = {
      ...baseDoc,
      documentId: 'invalid id with spaces'
    };
    assert.throws(
      () => validateDocument(invalidIdDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('rejects prototype-sensitive IDs like constructor or __proto__', () => {
    const protoIdDoc = {
      ...baseDoc,
      documentId: 'constructor'
    };
    assert.throws(
      () => validateDocument(protoIdDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('rejects oversized JSON payload', () => {
    const hugeLabel = 'a'.repeat(3000);
    const hugeDoc = {
      ...baseDoc,
      nodes: [{ ...baseDoc.nodes[0], label: hugeLabel }]
    };
    assert.throws(
      () => validateDocument(hugeDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });
});

describe('Graph Invariants & Invariant Violations', () => {
  const baseDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: 'doc-inv',
    revision: 1,
    title: 'Invariants Doc',
    nodes: [
      { id: 'group-1', kind: 'group', label: 'Group 1', layout: { x: 0, y: 0, width: 700, height: 500 } },
      { id: 'step-1', kind: 'step', label: 'Step 1', parentId: 'group-1', layout: { x: 20, y: 20, width: 220, height: 88 } },
      { id: 'text-1', kind: 'text', label: 'Note label', layout: { x: 10, y: 600, width: 260, height: 64 } },
    ],
    edges: [],
    notes: []
  };

  test('allows directed cycles and self-loops for workflows', () => {
    const docWithLoop: DiagramDocument = {
      ...baseDoc,
      nodes: [
        { id: 'step-1', kind: 'step', label: 'Step 1', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-2', kind: 'step', label: 'Step 2', layout: { x: 300, y: 0, width: 220, height: 88 } }
      ],
      edges: [
        { id: 'edge-self', source: 'step-1', target: 'step-1', label: 'Self Retry' },
        { id: 'edge-forward', source: 'step-1', target: 'step-2', label: 'Forward' },
        { id: 'edge-backward', source: 'step-2', target: 'step-1', label: 'Backward Retry' }
      ]
    };
    const validated = validateDocument(docWithLoop);
    assert.equal(validated.edges.length, 3);
  });

  test('rejects edge connecting to group or text node', () => {
    const docWithGroupEdge: DiagramDocument = {
      ...baseDoc,
      edges: [{ id: 'edge-bad', source: 'step-1', target: 'group-1' }]
    };
    assert.throws(
      () => validateDocument(docWithGroupEdge),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    const docWithTextEdge: DiagramDocument = {
      ...baseDoc,
      edges: [{ id: 'edge-bad2', source: 'step-1', target: 'text-1' }]
    };
    assert.throws(
      () => validateDocument(docWithTextEdge),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('rejects edge connecting to non-existent node', () => {
    const docBadTarget: DiagramDocument = {
      ...baseDoc,
      edges: [{ id: 'edge-ghost', source: 'step-1', target: 'non-existent' }]
    };
    assert.throws(
      () => validateDocument(docBadTarget),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('rejects nested groups and invalid group parents', () => {
    const nestedDoc: DiagramDocument = {
      ...baseDoc,
      nodes: [
        { id: 'group-1', kind: 'group', label: 'Parent Group', layout: { x: 0, y: 0, width: 700, height: 500 } },
        { id: 'group-2', kind: 'group', label: 'Child Group', parentId: 'group-1', layout: { x: 10, y: 10, width: 300, height: 200 } },
      ]
    };
    assert.throws(
      () => validateDocument(nestedDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    const badParentKindDoc: DiagramDocument = {
      ...baseDoc,
      nodes: [
        { id: 'step-1', kind: 'step', label: 'Step', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-2', kind: 'step', label: 'Step child', parentId: 'step-1', layout: { x: 10, y: 10, width: 220, height: 88 } },
      ]
    };
    assert.throws(
      () => validateDocument(badParentKindDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });
});

describe('Pure applyOps & Detached Notes', () => {
  const initialDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: 'doc-ops',
    revision: 1,
    title: 'Operations Doc',
    nodes: [
      { id: 'step-1', kind: 'step', label: 'Ingestion', layout: { x: 0, y: 0, width: 220, height: 88 } },
      { id: 'step-2', kind: 'step', label: 'Inference', layout: { x: 300, y: 0, width: 220, height: 88 } }
    ],
    edges: [
      { id: 'edge-1', source: 'step-1', target: 'step-2', label: 'Payload' }
    ],
    notes: [
      { id: 'note-node', body: 'Review step 2', author: 'agent', anchor: { type: 'node', id: 'step-2' } },
      { id: 'note-edge', body: 'Retry edge note', author: 'human', anchor: { type: 'edge', id: 'edge-1' } }
    ]
  };

  test('applyOps is pure and does not modify inputs or revision', () => {
    const ops: Operation[] = [
      { type: 'setTitle', title: 'New Title' },
      { type: 'updateNode', id: 'step-1', patch: { label: 'Updated Ingestion' } }
    ];
    const initialClone = JSON.parse(JSON.stringify(initialDoc));
    const result = applyOps(initialDoc, ops);

    assert.deepEqual(initialDoc, initialClone, 'input document must not be mutated');
    assert.equal(result.revision, initialDoc.revision, 'pure applyOps must not alter revision');
    assert.equal(result.title, 'New Title');
    assert.equal(result.nodes.find(n => n.id === 'step-1')?.label, 'Updated Ingestion');
  });

  test('unpositioned added nodes receive deterministic non-overlapping placement below existing content', () => {
    const ops: Operation[] = [
      { type: 'addNode', node: { id: 'step-3', kind: 'step', label: 'Step 3' } },
      { type: 'addNode', node: { id: 'step-4', kind: 'decision', label: 'Decision 4' } }
    ];
    const result = applyOps(initialDoc, ops);
    const n3 = result.nodes.find(n => n.id === 'step-3')!;
    const n4 = result.nodes.find(n => n.id === 'step-4')!;

    // Initial content height is 88 (y=0, height=88)
    assert.equal(n3.layout.y, 88 + 40); // 128
    assert.equal(n3.layout.width, 220);
    assert.equal(n3.layout.height, 88);

    assert.equal(n4.layout.y, 128 + 88 + 40); // 256
    assert.equal(n4.layout.width, 220);
    assert.equal(n4.layout.height, 110);
  });

  test('removing node with incident edges fails without cascade', () => {
    const ops: Operation[] = [
      { type: 'removeNode', id: 'step-1' }
    ];
    assert.throws(
      () => applyOps(initialDoc, ops),
      (err: any) => err instanceof DiagramError && err.code === 'INVALID_OPERATION'
    );
  });

  test('removing node with cascade removes edges and detaches notes retaining prior ID and label', () => {
    const ops: Operation[] = [
      { type: 'removeNode', id: 'step-2', cascade: true }
    ];
    const result = applyOps(initialDoc, ops);

    // step-2 and edge-1 are removed
    assert.equal(result.nodes.find(n => n.id === 'step-2'), undefined);
    assert.equal(result.edges.find(e => e.id === 'edge-1'), undefined);

    // Notes must be detached, not deleted!
    const noteNode = result.notes.find(n => n.id === 'note-node')!;
    assert.equal(noteNode.anchor.type, 'detached');
    if (noteNode.anchor.type === 'detached') {
      assert.equal(noteNode.anchor.previousType, 'node');
      assert.equal(noteNode.anchor.previousId, 'step-2');
      assert.equal(noteNode.anchor.previousLabel, 'Inference');
    }

    const noteEdge = result.notes.find(n => n.id === 'note-edge')!;
    assert.equal(noteEdge.anchor.type, 'detached');
    if (noteEdge.anchor.type === 'detached') {
      assert.equal(noteEdge.anchor.previousType, 'edge');
      assert.equal(noteEdge.anchor.previousId, 'edge-1');
      assert.equal(noteEdge.anchor.previousLabel, 'Payload');
    }

    // Resulting document passes full validation
    assert.doesNotThrow(() => validateDocument(result));
  });

  test('removing edge detaches note anchored to that edge', () => {
    const ops: Operation[] = [
      { type: 'removeEdge', id: 'edge-1' }
    ];
    const result = applyOps(initialDoc, ops);
    const noteEdge = result.notes.find(n => n.id === 'note-edge')!;
    assert.equal(noteEdge.anchor.type, 'detached');
    if (noteEdge.anchor.type === 'detached') {
      assert.equal(noteEdge.anchor.previousType, 'edge');
      assert.equal(noteEdge.anchor.previousId, 'edge-1');
      assert.equal(noteEdge.anchor.previousLabel, 'Payload');
    }
  });

  test('explicit removeNote removes note permanently', () => {
    const ops: Operation[] = [
      { type: 'removeNote', id: 'note-node' }
    ];
    const result = applyOps(initialDoc, ops);
    assert.equal(result.notes.find(n => n.id === 'note-node'), undefined);
    assert.equal(result.notes.length, 1);
  });

  test('applyOps validates input document and operations boundary', () => {
    assert.throws(
      () => applyOps({} as any, []),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    assert.throws(
      () => applyOps(initialDoc, [{ type: 'invalidOp' } as any]),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('applyOps validates final complete document bounds (e.g. coordinates)', () => {
    const ops: Operation[] = [
      {
        type: 'updateNode',
        id: 'step-1',
        patch: { layout: { y: 200000 } }
      }
    ];
    assert.throws(
      () => applyOps(initialDoc, ops),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('applyOps supports explicit null removal for node ref and edge label', () => {
    const docWithRefAndLabel = applyOps(initialDoc, [
      { type: 'updateNode', id: 'step-1', patch: { ref: 'https://example.com' } },
      { type: 'updateEdge', id: 'edge-1', patch: { label: 'Has Label' } }
    ]);
    assert.equal(docWithRefAndLabel.nodes.find(n => n.id === 'step-1')?.ref, 'https://example.com');
    assert.equal(docWithRefAndLabel.edges.find(e => e.id === 'edge-1')?.label, 'Has Label');

    const clearedDoc = applyOps(docWithRefAndLabel, [
      { type: 'updateNode', id: 'step-1', patch: { ref: null } },
      { type: 'updateEdge', id: 'edge-1', patch: { label: null } }
    ]);
    assert.equal(clearedDoc.nodes.find(n => n.id === 'step-1')?.ref, undefined);
    assert.equal(clearedDoc.edges.find(e => e.id === 'edge-1')?.label, undefined);
  });
});

describe('Document Diff & documentToOps Roundtrip', () => {
  const beforeDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: 'doc-diff',
    revision: 1,
    title: 'Initial Flow',
    nodes: [
      { id: 'n1', kind: 'step', label: 'Step 1', layout: { x: 0, y: 0, width: 220, height: 88 } },
      { id: 'n2', kind: 'step', label: 'Step 2', layout: { x: 300, y: 0, width: 220, height: 88 } }
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', label: 'Old Edge' }
    ],
    notes: [
      { id: 'nt1', body: 'Old Note', author: 'agent', anchor: { type: 'node', id: 'n1' } }
    ]
  };

  const afterDoc: DiagramDocument = {
    schemaVersion: 1,
    documentId: 'doc-diff',
    revision: 1,
    title: 'Updated Flow',
    nodes: [
      { id: 'g1', kind: 'group', label: 'Main Group', layout: { x: 0, y: 0, width: 700, height: 500 } },
      { id: 'n1', kind: 'step', label: 'Step 1 Modified', parentId: 'g1', layout: { x: 50, y: 50, width: 220, height: 88 } },
      { id: 'n3', kind: 'decision', label: 'New Step 3', parentId: 'g1', layout: { x: 350, y: 50, width: 220, height: 110 } }
    ],
    edges: [
      { id: 'e2', source: 'n1', target: 'n3', label: 'New Edge' }
    ],
    notes: [
      { id: 'nt1', body: 'Updated Note Body', author: 'human', anchor: { type: 'node', id: 'n1' } },
      { id: 'nt2', body: 'Brand New Note', author: 'agent', anchor: { type: 'diagram' } }
    ]
  };

  test('diffDocuments detects title, entity addition/removal, and field modifications', () => {
    const diff = diffDocuments(beforeDoc, afterDoc);

    assert.equal(diff.title?.before, 'Initial Flow');
    assert.equal(diff.title?.after, 'Updated Flow');

    assert.equal(diff.nodes.added.length, 2); // g1, n3
    assert.equal(diff.nodes.removed.length, 1); // n2
    assert.equal(diff.nodes.changed.length, 1); // n1
    assert.deepEqual(diff.nodes.changed[0].fields, ['label', 'layout', 'parentId']);

    assert.equal(diff.edges.added.length, 1); // e2
    assert.equal(diff.edges.removed.length, 1); // e1

    assert.equal(diff.notes.added.length, 1); // nt2
    assert.equal(diff.notes.changed.length, 1); // nt1
  });

  test('documentToOps produces valid operations transforming before to after', () => {
    const ops = documentToOps(beforeDoc, afterDoc);
    const reconstructed = applyOps(beforeDoc, ops);

    assert.equal(reconstructed.title, afterDoc.title);
    assert.equal(canonicalJson(reconstructed.nodes), canonicalJson(afterDoc.nodes));
    assert.equal(canonicalJson(reconstructed.edges), canonicalJson(afterDoc.edges));
    assert.equal(canonicalJson(reconstructed.notes), canonicalJson(afterDoc.notes));
  });

  test('diffDocuments rejects comparisons of different documentId or schemaVersion', () => {
    const differentIdDoc: DiagramDocument = {
      ...afterDoc,
      documentId: 'doc-other',
    };
    assert.throws(
      () => diffDocuments(beforeDoc, differentIdDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );

    const differentVersionDoc = {
      ...afterDoc,
      schemaVersion: 2 as any,
    };
    assert.throws(
      () => diffDocuments(beforeDoc, differentVersionDoc),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });

  test('documentToOps regression: reparents a retained child out of a deleted group without cascade deleting it', () => {
    const beforeWithGroup: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-reparent',
      revision: 1,
      title: 'Group Reparent Before',
      nodes: [
        { id: 'group-del', kind: 'group', label: 'Group to Delete', layout: { x: 0, y: 0, width: 700, height: 500 } },
        { id: 'child-retained', kind: 'step', label: 'Surviving Child', parentId: 'group-del', layout: { x: 50, y: 50, width: 220, height: 88 } }
      ],
      edges: [],
      notes: []
    };

    const afterReparented: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-reparent',
      revision: 1,
      title: 'Group Reparent After',
      nodes: [
        { id: 'child-retained', kind: 'step', label: 'Surviving Child', layout: { x: 50, y: 50, width: 220, height: 88 } }
      ],
      edges: [],
      notes: []
    };

    const ops = documentToOps(beforeWithGroup, afterReparented);
    const result = applyOps(beforeWithGroup, ops);

    assert.equal(result.nodes.length, 1);
    const surviving = result.nodes.find(n => n.id === 'child-retained')!;
    assert.ok(surviving);
    assert.equal(surviving.parentId, undefined);
    assert.equal(result.nodes.find(n => n.id === 'group-del'), undefined);
    assert.equal(canonicalJson(result.nodes), canonicalJson(afterReparented.nodes));
  });

  test('documentToOps regression: reconnects a retained edge away from a deleted node without cascade deleting it', () => {
    const beforeEdge: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-reconnect',
      revision: 1,
      title: 'Reconnect Before',
      nodes: [
        { id: 'step-a', kind: 'step', label: 'Step A', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-del', kind: 'step', label: 'Step Del', layout: { x: 300, y: 0, width: 220, height: 88 } }
      ],
      edges: [
        { id: 'edge-surviving', source: 'step-a', target: 'step-del', label: 'Route' }
      ],
      notes: []
    };

    const afterEdge: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-reconnect',
      revision: 1,
      title: 'Reconnect After',
      nodes: [
        { id: 'step-a', kind: 'step', label: 'Step A', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-new', kind: 'step', label: 'Step New', layout: { x: 300, y: 150, width: 220, height: 88 } }
      ],
      edges: [
        { id: 'edge-surviving', source: 'step-a', target: 'step-new', label: 'Route' }
      ],
      notes: []
    };

    const ops = documentToOps(beforeEdge, afterEdge);
    const result = applyOps(beforeEdge, ops);

    assert.equal(result.nodes.length, 2);
    assert.equal(result.nodes.find(n => n.id === 'step-del'), undefined);
    assert.ok(result.nodes.find(n => n.id === 'step-new'));
    assert.equal(result.edges.length, 1);
    const survivingEdge = result.edges.find(e => e.id === 'edge-surviving')!;
    assert.ok(survivingEdge);
    assert.equal(survivingEdge.source, 'step-a');
    assert.equal(survivingEdge.target, 'step-new');
    assert.equal(canonicalJson(result), canonicalJson({ ...afterEdge, revision: beforeEdge.revision }));
  });

  test('documentToOps regression: clears optional ref and edge label with null patches', () => {
    const beforeWithOptionals: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-clear-opt',
      revision: 1,
      title: 'Optionals Before',
      nodes: [
        { id: 'step-1', kind: 'step', label: 'Step 1', ref: 'https://example.com/spec', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-2', kind: 'step', label: 'Step 2', layout: { x: 300, y: 0, width: 220, height: 88 } }
      ],
      edges: [
        { id: 'edge-1', source: 'step-1', target: 'step-2', label: 'Optional Edge Label' }
      ],
      notes: []
    };

    const afterCleared: DiagramDocument = {
      schemaVersion: 1,
      documentId: 'doc-clear-opt',
      revision: 1,
      title: 'Optionals Before',
      nodes: [
        { id: 'step-1', kind: 'step', label: 'Step 1', layout: { x: 0, y: 0, width: 220, height: 88 } },
        { id: 'step-2', kind: 'step', label: 'Step 2', layout: { x: 300, y: 0, width: 220, height: 88 } }
      ],
      edges: [
        { id: 'edge-1', source: 'step-1', target: 'step-2' }
      ],
      notes: []
    };

    const ops = documentToOps(beforeWithOptionals, afterCleared);
    const updateNodeOp = ops.find(o => o.type === 'updateNode' && o.id === 'step-1') as any;
    assert.ok(updateNodeOp);
    assert.equal(updateNodeOp.patch.ref, null);

    const updateEdgeOp = ops.find(o => o.type === 'updateEdge' && o.id === 'edge-1') as any;
    assert.ok(updateEdgeOp);
    assert.equal(updateEdgeOp.patch.label, null);

    const result = applyOps(beforeWithOptionals, ops);
    assert.equal(result.nodes.find(n => n.id === 'step-1')?.ref, undefined);
    assert.equal(result.edges.find(e => e.id === 'edge-1')?.label, undefined);
  });
});

describe('Canonical JSON', () => {
  test('serializes keys in deterministic sorted order', () => {
    const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
    assert.equal(canonicalJson(obj1), canonicalJson(obj2));
    assert.equal(canonicalJson(obj1), '{"a":2,"m":{"a":4,"b":3},"z":1}');
  });

  test('rejects non-finite numbers', () => {
    assert.throws(
      () => canonicalJson({ val: Infinity }),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => canonicalJson({ val: NaN }),
      (err: any) => err instanceof DiagramError && err.code === 'VALIDATION_ERROR'
    );
  });
});
