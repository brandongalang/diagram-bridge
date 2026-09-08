import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHandoff } from '../src/editor/handoff.js';
import type { DiagramDocument } from '../src/core/types.js';
const document: DiagramDocument = { schemaVersion: 1, documentId: 'doc-one', revision: 4, title: 'Plan', nodes: [], edges: [], notes: [] };
const context = { workspacePath: "/tmp/a project/owner's plan", cliPath: '/tmp/cli path/cli.js' };
test('first handoff pins an exact revision and safely quotes paths', () => {
  const text = buildHandoff(document, context);
  assert.ok(text.includes("read 'doc-one' --revision 4"));
  assert.ok(text.includes("'/tmp/a project/owner'\"'\"'s plan'"));
  assert.ok(text.includes('--dry-run'));
  assert.ok(!text.includes('token='));
});
test('later handoffs request the diff from the last copied revision', () => {
  assert.ok(buildHandoff(document, context, 2).includes("pull 'doc-one' --since 2 --brief"));
  assert.ok(buildHandoff(document, context, 8).includes('read'));
});
