import { briefPull } from '../src/cli/preview.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('src/cli/index.ts');
function run(root: string, args: string[], expected = 0) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args, '--workspace', root, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, expected, `command ${args.join(' ')}\n${child.stderr}`);
  if (expected) { assert.equal(child.stdout, ''); return JSON.parse(child.stderr); }
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.apiVersion, 1);
  return result;
}

test('apply --dry-run validates without writes; same request-id then commits; stale preview stays stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-cli-preview-'));
  try {
    run(root, ['init', root]);
    const created = run(root, ['create', 'Classification plan', '--from', resolve('examples/classification/document.json')]);
    const id = created.document.documentId;
    const batch = join(root, 'edit.json');
    writeFileSync(batch, JSON.stringify([
      { type: 'setTitle', title: 'Classification and checkpoints' },
      { type: 'updateNode', id: 'node-checkpoint', patch: { layout: { x: 820, y: 270 } } },
      { type: 'addNote', note: { id: 'agent-preview-note', body: 'Preview then apply.', author: 'agent', anchor: { type: 'diagram' } } },
    ]));
    const previewArgs = ['apply', id, '--file', batch, '--base-revision', '1', '--request-id', 'preview-then-apply', '--dry-run'];
    assert.equal(run(root, [...previewArgs, '--author', '   '], 4).error.code, 'VALIDATION_ERROR');
    assert.equal(run(root, [...previewArgs, '--summary', 'x'.repeat(501)], 4).error.code, 'VALIDATION_ERROR');
    const preview = run(root, previewArgs);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.changed, true);
    assert.equal(preview.baseRevision, 1);
    assert.equal(preview.nextRevision, 2);
    assert.equal(preview.operationsCount, 3);
    assert.equal(preview.diff.title.after, 'Classification and checkpoints');
    assert.equal(run(root, ['read', id]).document.revision, 1);
    assert.equal(run(root, ['history', id]).revisions.length, 1);
    const committed = run(root, ['apply', id, '--file', batch, '--base-revision', '1', '--request-id', 'preview-then-apply']);
    assert.equal(committed.replayed, false);
    assert.equal(committed.revision, 2);
    const stale = run(root, previewArgs, 3);
    assert.equal(stale.error.code, 'STALE_REVISION_CONFLICT');
    assert.equal(stale.error.details.expectedRevision, 1);
    assert.equal(stale.error.details.currentRevision, 2);
    assert.match(stale.error.details.actionableNextSteps, /fresh --request-id/);
    assert.equal(run(root, previewArgs, 3).error.code, 'STALE_REVISION_CONFLICT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pull --brief separates layout, content, and notes without dropping the net diff', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-cli-brief-'));
  try {
    run(root, ['init', root]);
    const id = run(root, ['create', 'Classification plan', '--from', resolve('examples/classification/document.json')]).document.documentId;
    const batch = join(root, 'edit.json');
    writeFileSync(batch, JSON.stringify([
      { type: 'setTitle', title: 'Classification and checkpoints' },
      { type: 'updateNode', id: 'node-checkpoint', patch: { layout: { x: 820, y: 270 } } },
      { type: 'updateNode', id: 'node-db', patch: { label: 'Persisted classification state' } },
      { type: 'addNote', note: { id: 'human-question', body: 'Persist the inference result before advancing?', author: 'human', anchor: { type: 'diagram' } } },
    ]));
    run(root, ['apply', id, '--file', batch, '--base-revision', '1', '--request-id', 'brief-1']);
    const brief = run(root, ['pull', id, '--since', '1', '--brief']);
    assert.equal(brief.document, undefined);
    assert.equal(brief.counts.nodes, 6);
    assert.equal(brief.counts.notes, 4);
    assert.equal(brief.summary.hasChanges, true);
    assert.deepEqual(brief.summary.layout.changedNodes, [{ id: 'node-checkpoint', fields: ['layout'] }]);
    assert.equal(brief.summary.content.title.after, 'Classification and checkpoints');
    assert.deepEqual(brief.summary.content.nodesChanged, [{ id: 'node-db', fields: ['label'] }]);
    assert.deepEqual(brief.summary.notes.added, [{ id: 'human-question', author: 'human' }]);
    assert.equal(brief.summary.notes.activityCount, 1);
    assert.equal(brief.diff.notes.added[0].body, 'Persist the inference result before advancing?');
    assert.equal(brief.noteActivity[0].notes.added[0].id, 'human-question');
    assert.equal(brief.revisions.length, 1);
    const invalid = run(root, ['pull', id, '--since', '999', '--brief'], 4);
    assert.equal(invalid.error.code, 'INVALID_BASELINE');
    assert.equal(invalid.error.details.headRevision, 2);
    assert.match(invalid.error.details.actionableNextSteps, /known committed revision/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inapplicable flags fail instead of being ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-cli-flags-'));
  try {
    run(root, ['init', root]);
    const id = run(root, ['create', 'Only']).document.documentId;
    assert.equal(run(root, ['pull', id, '--file', 'unused.json'], 2).error.code, 'INVALID_ARGUMENT');
    assert.equal(run(root, ['apply', id, '--since', '1'], 2).error.code, 'INVALID_ARGUMENT');
    assert.equal(run(root, ['snapshot', id, '--dry-run'], 2).error.code, 'INVALID_ARGUMENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('brief output distinguishes an unknown baseline from no changes', () => {
  const result = briefPull({ document: {schemaVersion:1, documentId:'d', revision:1, title:'Plan', nodes:[], edges:[], notes:[]}, baseRevision:null, headRevision:1, diff:null, revisions:[], noteActivity:[] });
  assert.equal(result.summary.hasChanges, null);
  assert.match(result.summary.comparison!, /No baseline/);
});
