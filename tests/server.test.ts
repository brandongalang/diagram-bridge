import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../src/server/index.js';
import { DiagramStore } from '../src/commands/index.js';
import { validateDocument } from '../src/core/index.js';

test('HTTP adapter shares atomic commands and enforces loopback capability/origin/path boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'diagram-http-'));
  const webRoot = join(root, 'web');
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<html><body>Editor fixture</body></html>');
  const store = new DiagramStore(root);
  const doc = store.create('Server test', validateDocument(JSON.parse(readFileSync(resolve('examples/classification/document.json'), 'utf8'))));
  const server = await startServer({ root, port: 0, ephemeral: true, webRoot });
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.url, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(server.url)).status, 200);
    assert.equal((await fetch(`${server.url}/api/bootstrap`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/bootstrap`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(`${server.url}/api/documents`, { method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'No origin' }) })).status, 403);
    const bootstrap = await (await fetch(`${server.url}/api/bootstrap`, { headers })).json();
    assert.equal(bootstrap.documents[0].documentId, doc.documentId);
    assert.equal(bootstrap.workspacePath, root);
    assert.ok(bootstrap.cliPath.endsWith("/dist/cli.js"));
    const save = await fetch(`${server.url}/api/documents/${doc.documentId}/apply`, { method: 'POST', headers, body: JSON.stringify({
      baseRevision: 1, requestId: 'browser-save', author: 'human', operations: [
        { type: 'setTitle', title: 'Saved graph and notes' },
        { type: 'addNote', note: { id: 'browser-note', author: 'human', body: '<img src=x onerror=alert(1)>', anchor: { type: 'diagram' } } },
      ],
    }) });
    assert.equal(save.status, 200);
    assert.equal((await save.json()).revision, 2);
    assert.equal(store.pull(doc.documentId, 1).diff?.notes.added[0].body, '<img src=x onerror=alert(1)>');
    assert.equal(store.read(doc.documentId).title, 'Saved graph and notes');
    const stale = await fetch(`${server.url}/api/documents/${doc.documentId}/apply`, { method: 'POST', headers, body: JSON.stringify({ baseRevision: 1, requestId: 'stale', operations: [{ type: 'setTitle', title: 'Overwrite' }] }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'STALE_REVISION_CONFLICT');
    const invalid = await fetch(`${server.url}/api/documents/${doc.documentId}/apply`, { method: 'POST', headers, body: JSON.stringify({ baseRevision: 2, requestId: 'invalid', operations: [{ type: 'setTitle', title: 'Partial change' }, { type: 'addEdge', edge: { id: 'dangling', source: 'missing', target: 'missing' } }] }) });
    assert.equal(invalid.status, 400);
    assert.equal(store.read(doc.documentId).revision, 2);
    const traversal = await new Promise<number>(accept => {
      const req = request(`${server.url}/`, { path: '/assets/%2e%2e/%2e%2e/.diagram-bridge/config.json' }, response => { response.resume(); accept(response.statusCode!); });
      req.end();
    });
    assert.equal(traversal, 400);
    const hostileHost = await new Promise<number>(accept => {
      const req = request(`${server.url}/health`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); accept(response.statusCode!); });
      req.end();
    });
    assert.equal(hostileHost, 403);
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
