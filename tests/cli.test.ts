import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('CLI headless planning loop, portable copy, exact retry, and explicit errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-cli-'));
  try {
    run(root, ['init', root]);
    const created = run(root, ['create', 'Classification plan', '--from', resolve('examples/classification/document.json')]);
    const id = created.document.documentId;
    assert.equal(created.document.revision, 1);
    const before = run(root, ['pull', id]);
    assert.equal(before.baseRevision, null);
    assert.equal(before.diff, null);
    const batch = join(root, 'edit.json');
    writeFileSync(batch, JSON.stringify({ operations: [
      { type: 'setTitle', title: 'Classification and checkpoints' },
      { type: 'addNote', note: { id: 'human-question', body: 'Persist the inference result before advancing?', author: 'human', anchor: { type: 'diagram' } } },
    ] }));
    const applyArgs = ['apply', id, '--file', batch, '--base-revision', '1', '--request-id', 'human-1'];
    const mutation = run(root, applyArgs);
    assert.equal(mutation.revision, 2);
    const retry = run(root, applyArgs);
    assert.equal(retry.replayed, true);
    assert.equal(retry.revision, 2);
    const pulled = run(root, ['pull', id, '--since', '1']);
    assert.equal(pulled.headRevision, 2);
    assert.equal(pulled.diff.notes.added[0].body, 'Persist the inference result before advancing?');
    assert.deepEqual(run(root, ['pull', id, '--since', '1']), pulled);
    assert.equal(run(root, ['pull', id, '--since', '999'], 4).error.code, 'INVALID_BASELINE');
    assert.equal(run(root, ['apply', id, '--file', batch, '--base-revision', '1', '--request-id', 'different'], 3).error.code, 'STALE_REVISION_CONFLICT');
    writeFileSync(batch, JSON.stringify([{ type: 'setTitle', title: 'Changed request payload' }]));
    assert.equal(run(root, applyArgs, 4).error.code, 'REQUEST_ID_REUSED');
    writeFileSync(batch, '{bad-json');
    assert.equal(run(root, ['apply', id, '--file', batch, '--base-revision', '2', '--request-id', 'invalid'], 4).error.code, 'INVALID_JSON');
    const output = join(root, 'export.json');
    run(root, ['export', id, '--revision', '2', '--output', output]);
    const exported = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(exported.revision, 2);
    const copy = run(root, ['create', 'Alternative', '--from', output]).document;
    assert.notEqual(copy.documentId, id);
    assert.equal(copy.revision, 1);
    assert.equal(copy.lineage.documentId, id);
    assert.deepEqual(copy.notes, exported.notes);
    assert.equal(run(root, ['revert', id, '--base-revision', '2', '--request-id', 'revert-2']).revision, 3);
    assert.equal(run(root, ['read', id]).document.title, 'Classification plan');
    assert.equal(run(root, ['history', id]).revisions.length, 3);
    assert.equal(run(root, ['list']).documents.length, 2);
    assert.equal(run(root, ['open', id, '--no-browser'], 5).error.code, 'SERVER_NOT_RUNNING');
    const schema = run(root, ['schema', 'operations']);
    assert.equal(schema.schema.type, 'array');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace isolation, no implicit server, and finite argument failures', () => {
  const roots = [mkdtempSync(join(tmpdir(), 'diagram-a-')), mkdtempSync(join(tmpdir(), 'diagram-b-'))];
  try {
    for (const root of roots) run(root, ['init', root]);
    run(roots[0], ['create', 'Only A']);
    assert.equal(run(roots[0], ['list']).documents.length, 1);
    assert.equal(run(roots[1], ['list']).documents.length, 0);
    assert.equal(run(roots[0], ['pull', 'unknown', '--since', '-1'], 2).error.code, 'INVALID_ARGUMENT');
    assert.equal(run(roots[0], ['nonsense'], 2).error.code, 'UNKNOWN_COMMAND');
    assert.equal(run(roots[0], ['apply', 'unknown'], 2).error.code, 'MISSING_ARGUMENT');
  } finally { roots.forEach(root => rmSync(root, { recursive: true, force: true })); }
});
