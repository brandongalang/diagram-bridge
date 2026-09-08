import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type RunningServer } from '../src/server/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(REPO, 'src/cli/index.ts');
const WEB_INDEX = resolve(REPO, 'dist/web/index.html');
const ROUTE_MODULE = resolve(REPO, 'src/editor/routing/index.ts');
const BUILD_DIR = resolve(REPO, '.build');
const CLASSIFICATION = resolve(REPO, 'examples/classification/document.json');

const OVERALL_MS = 180_000;
const BUILD_WAIT_MS = 120_000;
const PAGE_MS = 30_000;
const POLL_WAIT_MS = 16_000;
const CLI_MS = 20_000;
const SNAPSHOT_MS = 60_000;

const CHECKPOINT_LABEL = 'Persist inference result';
const DIRTY_LABEL = 'DIRTY-LOCAL-ONLY';
const HUMAN_NOTE = 'Should we persist the inference result before advancing?';
const RETRY_LABEL = 'Retry after persist';
const RETRY_TARGET = 'node-db';
const CHECKPOINT_NUDGE = 80;

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 1100, height: 720 };

type Json = Record<string, unknown>;

function delay(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms));
}

function redact(value: string): string {
  return value.replace(/#token=[A-Za-z0-9]+/g, '#token=[redacted]').replace(/Bearer [A-Za-z0-9]+/g, 'Bearer [redacted]');
}

async function waitForPrereqs(): Promise<void> {
  const deadline = Date.now() + BUILD_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(WEB_INDEX) && existsSync(ROUTE_MODULE)) return;
    await delay(2000);
  }
  throw new Error(
    `Timed out waiting for editor assets. Missing ${existsSync(WEB_INDEX) ? '' : 'dist/web '} ${existsSync(ROUTE_MODULE) ? '' : 'src/editor/routing'}. Do not treat this rehearsal as passed.`
  );
}

function runCli(root: string, args: string[], expected = 0, timeoutMs = CLI_MS): Json {
  const child = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args, '--workspace', root, '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const stderr = redact(child.stderr ?? '');
  const stdout = redact(child.stdout ?? '');
  assert.equal(child.status, expected, `diagram ${args.join(' ')}\n${stderr}\n${stdout}`);
  if (expected !== 0) {
    assert.equal(child.stdout, '');
    return JSON.parse(child.stderr) as Json;
  }
  const result = JSON.parse(child.stdout) as Json;
  assert.equal(result.apiVersion, 1);
  return result;
}

function writeSmokeFixture(path: string): void {
  const nodes: Json[] = [
    {
      id: 'g-smoke',
      kind: 'group',
      label: 'Load envelope\n100 nodes / 150 edges',
      layout: { x: 0, y: 0, width: 3000, height: 2100 },
    },
  ];
  const cols = 9;
  const gapX = 320;
  const gapY = 180;
  for (let i = 0; i < 99; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const kinds = ['step', 'decision', 'datastore'] as const;
    nodes.push({
      id: `n-${String(i).padStart(2, '0')}`,
      kind: kinds[i % kinds.length],
      label: `Station ${i}\nmultiline label`,
      layout: { x: 40 + col * gapX, y: 40 + row * gapY, width: 220, height: kinds[i % kinds.length] === 'decision' ? 110 : 88 },
    });
  }
  const edges: Json[] = [];
  for (let i = 0; i < 99; i++) {
    if ((i % cols) < cols - 1 && i + 1 < 99) {
      edges.push({
        id: `e-h-${String(edges.length).padStart(3, '0')}`,
        source: `n-${String(i).padStart(2, '0')}`,
        target: `n-${String(i + 1).padStart(2, '0')}`,
        label: i % 7 === 0 ? 'forward' : undefined,
      });
    }
  }
  for (let i = 0; i < 99 && edges.length < 150; i++) {
    if (i + cols < 99) {
      edges.push({
        id: `e-v-${String(edges.length).padStart(3, '0')}`,
        source: `n-${String(i).padStart(2, '0')}`,
        target: `n-${String(i + cols).padStart(2, '0')}`,
        label: i % 11 === 0 ? 'down' : undefined,
      });
    }
  }
  assert.equal(nodes.length, 100);
  assert.equal(edges.length, 150);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    documentId: 'doc-smoke-100',
    revision: 1,
    title: 'Routing smoke',
    nodes,
    edges,
    notes: [
      { id: 'note-smoke-doc', body: 'Synthetic 100/150 envelope.', author: 'fixture', anchor: { type: 'diagram' } },
      { id: 'note-smoke-n', body: 'Anchored load note.', author: 'fixture', anchor: { type: 'node', id: 'n-00' } },
    ],
  }, null, 2)}\n`);
}

function editorHref(origin: string, documentId: string, token: string, query: Record<string, string> = {}): string {
  const url = new URL(origin);
  url.searchParams.set('document', documentId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.hash = `token=${token}`;
  return url.toString();
}

async function waitFor(page: Page, predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last}` : ''}`);
}

async function openDocument(page: Page, origin: string, documentId: string, token: string, query?: Record<string, string>): Promise<void> {
  await page.goto(editorHref(origin, documentId, token, query), { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
  await page.getByTestId('diagram-canvas').waitFor({ state: 'visible', timeout: PAGE_MS });
  await waitFor(page, async () => !page.url().includes('token='), 5000, 'auth fragment strip');
  assert.equal(new URL(page.url()).hash, '', 'capability token must be stripped from the address');
  const stored = await page.evaluate(() => Boolean(sessionStorage.getItem('diagram_bridge_token')));
  assert.equal(stored, true, 'sessionStorage must hold the capability without exposing it in the URL');
}

async function badgeText(page: Page): Promise<string> {
  return (await page.getByTestId('revision-badge').innerText()).replace(/\s+/g, ' ').trim();
}

async function viewportTransform(page: Page): Promise<string> {
  return page.locator('.react-flow__viewport').evaluate(el => (el as HTMLElement).style.transform);
}

async function selectNode(page: Page, id: string): Promise<void> {
  await page.getByTestId(`node-${id}`).click({ timeout: PAGE_MS });
  await page.locator('#node-label').waitFor({ state: 'visible', timeout: PAGE_MS });
}

async function fillReactControl(locator: ReturnType<Page['locator']>, value: string): Promise<void> {
  await locator.fill(value);
  await locator.press('Tab');
}

async function panCanvas(page: Page): Promise<void> {
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  assert.ok(box, 'canvas pane is measurable');
  await page.mouse.move(box.x + 80, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 200, { steps: 8 });
  await page.mouse.up();
}

function writeBatch(root: string, name: string, operations: unknown[]): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify({ operations }));
  return path;
}

async function main(): Promise<void> {
  const started = Date.now();
  const pageErrors: string[] = [];
  let workspace = '';
  let browser: Browser | undefined;
  let activePage: Page | undefined;
  let server: RunningServer | undefined;
  mkdirSync(BUILD_DIR, { recursive: true });

  try {
    await waitForPrereqs();
    workspace = mkdtempSync(join(tmpdir(), 'diagram-e2e-'));
    runCli(workspace, ['init', workspace]);

    const created = runCli(workspace, ['create', 'AI Classification Pipeline', '--from', CLASSIFICATION]);
    const createdDoc = created.document as { documentId: string; revision: number };
    const documentId = createdDoc.documentId;
    assert.equal(createdDoc.revision, 1);
    assert.match(documentId, /^[0-9a-f-]{36}$/i);

    const smokePath = join(workspace, 'smoke-100.json');
    writeSmokeFixture(smokePath);
    const smoke = runCli(workspace, ['create', 'Routing smoke', '--from', smokePath]);
    const smokeId = (smoke.document as { documentId: string }).documentId;

    server = await startServer({ root: workspace, ephemeral: true, port: 0 });
    const origin = server.url;
    let token = server.token;

    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    const page = await browser.newPage({ viewport: DESKTOP, reducedMotion: 'reduce' });
    activePage = page;
    page.setDefaultTimeout(PAGE_MS);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || url.protocol === 'data:') return route.continue();
      return route.abort('blockedbyclient');
    });

    await openDocument(page, origin, documentId, token);
    await page.getByTestId('node-node-checkpoint').waitFor({ state: 'visible' });

    await selectNode(page, 'node-checkpoint');
    await fillReactControl(page.locator('#node-label'), CHECKPOINT_LABEL);
    await waitFor(page, async () => (await page.getByTestId('node-node-checkpoint').innerText()).includes(CHECKPOINT_LABEL), 5000, 'canvas checkpoint label');
    await page.getByTestId('node-node-checkpoint').click();
    for (let i = 0; i < CHECKPOINT_NUDGE / 10; i++) await page.keyboard.press('Shift+ArrowRight');

    await page.getByTestId('edge-label-edge-retry').click();
    await fillReactControl(page.locator('#edge-label'), RETRY_LABEL);
    await page.locator('#edge-target').selectOption(RETRY_TARGET);

    await page.getByTestId('node-node-checkpoint').click();
    await page.locator('#node-label').waitFor({ state: 'visible' });
    const noteForm = page.locator('form').filter({
      has: page.getByPlaceholder('Add an explanatory note, checkpoint question, or intent...'),
    });
    await fillReactControl(
      noteForm.getByPlaceholder('Add an explanatory note, checkpoint question, or intent...'),
      HUMAN_NOTE
    );
    await noteForm.getByRole('button', { name: 'Done', exact: true }).click();
    const noteVisible = await page.locator('.note-body').filter({ hasText: HUMAN_NOTE }).waitFor({
      state: 'visible',
      timeout: 4000,
    }).then(() => true).catch(() => false);
    if (!noteVisible) {
      await page.screenshot({ path: join(BUILD_DIR, 'e2e-debug-note.png'), type: 'png' });
      const inspector = await page.locator('.inspector-panel, .editor-layout').first().innerText().catch(() => '');
      const toast = await page.locator('.notification-toast').allInnerTexts().catch(() => []);
      throw new Error(`Note did not appear.\nTOASTS: ${toast.join(' | ')}\nINSPECTOR:\n${inspector}`);
    }
    await waitFor(page, async () => (await badgeText(page)).includes('Unsaved'), 5000, 'unsaved badge');

    await page.getByTestId('save-button').click();
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 2 · Saved', 10_000, 'saved clean badge after one Save');

    console.log('Browser edits saved together at revision 2.');
    const pulled = runCli(workspace, ['pull', documentId, '--since', '1']);
    assert.equal(pulled.headRevision, 2);
    const diff = pulled.diff as {
      nodes: { changed: Array<{ id: string; after: { label: string; layout: { x: number } }; fields: string[] }> };
      edges: { changed: Array<{ id: string; after: { target: string; label?: string }; fields: string[] }> };
      notes: { added: Array<{ body: string; anchor: { type: string; id?: string } }> };
    };
    const checkpoint = diff.nodes.changed.find(change => change.id === 'node-checkpoint');
    assert.ok(checkpoint, 'pull must include the checkpoint node change');
    assert.equal(checkpoint.after.label, CHECKPOINT_LABEL);
    assert.ok(checkpoint.fields.includes('label'));
    assert.ok(checkpoint.fields.includes('layout'));
    assert.equal(checkpoint.after.layout.x, 800 + CHECKPOINT_NUDGE);
    const retry = diff.edges.changed.find(change => change.id === 'edge-retry');
    assert.ok(retry, 'pull must include the retry edge change');
    assert.equal(retry.after.target, RETRY_TARGET);
    assert.equal(retry.after.label, RETRY_LABEL);
    assert.ok(retry.fields.includes('target'));
    assert.ok(retry.fields.includes('label'));
    const note = diff.notes.added.find(item => item.body === HUMAN_NOTE);
    assert.ok(note, 'pull must include the anchored human note');
    assert.equal(note.anchor.type, 'node');
    assert.equal(note.anchor.id, 'node-checkpoint');
    const readBack = runCli(workspace, ['read', documentId]);
    const savedDoc = readBack.document as { revision: number; nodes: Array<{ id: string; label: string; layout: { x: number } }>; edges: Array<{ id: string; target: string; label?: string }> };
    assert.equal(savedDoc.revision, 2);
    assert.equal(savedDoc.nodes.find(node => node.id === 'node-checkpoint')?.label, CHECKPOINT_LABEL);

    await page.screenshot({ path: join(BUILD_DIR, 'e2e-desktop.png'), type: 'png', animations: 'disabled' });
    await page.setViewportSize(NARROW);
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
    await delay(400);
    await page.screenshot({ path: join(BUILD_DIR, 'e2e-narrow.png'), type: 'png', animations: 'disabled' });
    await page.setViewportSize(DESKTOP);

    await panCanvas(page);
    const panned = await viewportTransform(page);
    assert.ok(panned, 'viewport transform is present after pan');
    const pollNote = writeBatch(workspace, 'poll-note.json', [{
      type: 'addNote',
      note: { id: 'note-cli-poll', body: 'Remote clean poll note', author: 'agent', anchor: { type: 'diagram' } },
    }]);
    runCli(workspace, ['apply', documentId, '--file', pollNote, '--base-revision', '2', '--request-id', 'cli-clean-poll', '--author', 'agent']);
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 3 · Saved', POLL_WAIT_MS, 'clean polling refresh');
    await waitFor(page, async () => (await page.getByText('Document refreshed to Revision 3.', { exact: true }).count()) > 0, 2000, 'clean refresh toast');
    assert.equal(await viewportTransform(page), panned, 'clean polling must preserve the viewport');

    await selectNode(page, 'node-checkpoint');
    await fillReactControl(page.locator('#node-label'), DIRTY_LABEL);
    await waitFor(page, async () => (await badgeText(page)).includes('Unsaved'), 5000, 'dirty badge before stale write');
    const staleBatch = writeBatch(workspace, 'stale-while-dirty.json', [{
      type: 'addNote',
      note: { id: 'note-cli-stale', body: 'Committed while browser draft is dirty', author: 'agent', anchor: { type: 'diagram' } },
    }]);
    runCli(workspace, ['apply', documentId, '--file', staleBatch, '--base-revision', '3', '--request-id', 'cli-stale-dirty', '--author', 'agent']);
    await page.getByRole('alert').filter({ hasText: 'Remote Conflict' }).waitFor({ timeout: POLL_WAIT_MS });
    await page.getByText(/Revision 4 is available/).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#node-label').inputValue(), DIRTY_LABEL);

    await server.close();
    server = await startServer({ root: workspace, ephemeral: true, port: Number(new URL(origin).port) });
    assert.equal(server.url, origin);
    token = server.token;
    await page.goto(editorHref(origin, documentId, token), { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('diagram-canvas').waitFor({ state: 'visible' });
    await page.getByText('Recovered unsaved draft.', { exact: true }).waitFor({ timeout: PAGE_MS });
    await selectNode(page, 'node-checkpoint');
    assert.equal(await page.locator('#node-label').inputValue(), DIRTY_LABEL);
    await waitFor(page, async () => (await badgeText(page)).includes('Unsaved'), 5000, 'reloaded draft stays unsaved');

    await page.getByRole('alert').filter({ hasText: 'Remote Conflict' }).waitFor({ timeout: POLL_WAIT_MS });
    await page.getByRole('button', { name: 'Save as Copy' }).click();
    await waitFor(page, async () => (await badgeText(page)).includes('Saved'), 10_000, 'copy document saved');
    const listed = runCli(workspace, ['list']);
    const documents = listed.documents as Array<{ documentId: string; title: string; revision: number }>;
    const copy = documents.find(item => item.documentId !== documentId && item.title.includes('(Copy)'));
    assert.ok(copy, 'save-as-copy must create a second document');
    assert.equal(copy.revision, 1);
    const original = runCli(workspace, ['read', documentId]).document as { revision: number; title: string; nodes: Array<{ id: string; label: string }> };
    assert.equal(original.revision, 4);
    assert.equal(original.nodes.find(node => node.id === 'node-checkpoint')?.label, CHECKPOINT_LABEL);
    const copied = runCli(workspace, ['read', copy.documentId]).document as { revision: number; lineage?: { documentId: string }; nodes: Array<{ id: string; label: string }> };
    assert.equal(copied.revision, 1);
    assert.equal(copied.lineage?.documentId, documentId);
    assert.equal(copied.nodes.find(node => node.id === 'node-checkpoint')?.label, DIRTY_LABEL);

    await page.getByLabel('Select document').selectOption(documentId);
    await page.getByTestId('node-node-checkpoint').waitFor({ state: 'visible' });
    await waitFor(page, async () => (await badgeText(page)).includes('Unsaved'), 10000, 'original draft retained after copy');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard Changes', exact: true }).click();
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 4 · Saved', 10_000, 'original explicitly reloaded clean');

    console.log('Clean refresh, stale draft recovery, copy and discard verified.');
    const applyBodies: string[] = [];
    let failAfterCommit = true;
    await page.route('**/api/documents/*/apply', async route => {
      const body = route.request().postData() ?? '';
      applyBodies.push(body);
      const upstream = await route.fetch();
      if (failAfterCommit) {
        failAfterCommit = false;
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ apiVersion: 1, error: { code: 'LOST_RESPONSE', message: 'Response lost after the revision committed.' } }),
        });
        return;
      }
      await route.fulfill({ response: upstream });
    });

    await fillReactControl(
      page.getByPlaceholder('Add an explanatory note, checkpoint question, or intent...'),
      'Uncertain save replay probe'
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByTestId('save-button').click();
    await waitFor(page, async () => (await badgeText(page)).includes('Save failed'), 10_000, 'uncertain save error badge');
    const committedAfterLostResponse = runCli(workspace, ['read', documentId]).document as { revision: number };
    assert.equal(committedAfterLostResponse.revision, 5, 'server must commit before the intercepted failure');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('diagram-canvas').waitFor({ state: 'visible' });
    await page.getByText('Recovered draft. Retry Save to confirm the previous request.', { exact: true }).waitFor({ timeout: PAGE_MS });
    await page.getByTestId('save-button').click();
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 5 · Saved', 10_000, 'replayed uncertain save');
    assert.ok(applyBodies.length >= 2, 'uncertain save must retry the apply request');
    const firstApply = JSON.parse(applyBodies[0]) as { requestId: string; baseRevision: number; operations: unknown[] };
    const replayApply = JSON.parse(applyBodies[1]) as { requestId: string; baseRevision: number; operations: unknown[] };
    assert.equal(replayApply.requestId, firstApply.requestId);
    assert.equal(replayApply.baseRevision, firstApply.baseRevision);
    assert.deepEqual(replayApply.operations, firstApply.operations);
    const afterReplay = runCli(workspace, ['read', documentId]).document as { revision: number; notes: Array<{ body: string }> };
    assert.equal(afterReplay.revision, 5, 'exact request replay must not create a second revision');
    assert.equal(afterReplay.notes.filter(item => item.body === 'Uncertain save replay probe').length, 1);
    const history = runCli(workspace, ['history', documentId]).revisions as Array<{ revision: number }>;
    assert.equal(history.at(-1)?.revision, 5);

    console.log('Uncertain apply replay verified at revision 5.');
    const advance = writeBatch(workspace, 'advance-head.json', [{
      type: 'addNote',
      note: { id: 'note-after-pin', body: 'Persist the inference result before advancing so retries can reuse the saved result.', author: 'agent', anchor: { type: 'node', id: 'node-checkpoint' } },
    }, { type: 'updateNode', id: 'node-checkpoint', patch: { label: 'Persist result before advancing' } }]);
    runCli(workspace, ['apply', documentId, '--file', advance, '--base-revision', '5', '--request-id', 'cli-advance-head', '--author', 'agent']);
    const pinnedPath = join(BUILD_DIR, 'e2e-rev5-pinned.png');
    const snapshot = runCli(workspace, ['snapshot', documentId, '--revision', '5', '--output', pinnedPath], 0, SNAPSHOT_MS);
    assert.equal(snapshot.revision, 5);
    assert.equal(existsSync(pinnedPath), true);
    const exportPage = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
    exportPage.on('pageerror', error => pageErrors.push(error.message));
    await exportPage.goto(editorHref(origin, documentId, token, { revision: '5', export: '1' }), { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
    await exportPage.waitForFunction(() => {
      const w = window as unknown as { __DIAGRAM_READY__?: { revision: number }; __DIAGRAM_ERROR__?: string };
      return Boolean(w.__DIAGRAM_READY__ || w.__DIAGRAM_ERROR__);
    }, undefined, { timeout: PAGE_MS });
    const exportState = await exportPage.evaluate(() => {
      const w = window as unknown as { __DIAGRAM_READY__?: { revision: number; documentId: string }; __DIAGRAM_ERROR__?: string };
      return { ready: w.__DIAGRAM_READY__, error: w.__DIAGRAM_ERROR__ };
    });
    assert.equal(exportState.error, undefined, exportState.error ?? 'export revision error');
    assert.equal(exportState.ready?.revision, 5);
    assert.equal(exportState.ready?.documentId, documentId);
    await exportPage.close();
    const agentReply = runCli(workspace, ['read', documentId]).document as typeof savedDoc;
    assert.equal(agentReply.revision, 6);
    assert.equal(agentReply.nodes.find(n => n.id === 'node-checkpoint')?.label, 'Persist result before advancing');
    for (const previous of savedDoc.nodes) {
      const after = agentReply.nodes.find(n => n.id === previous.id);
      assert.deepEqual(after?.layout, previous.layout, 'Agent response must preserve manual positions');
      if (previous.id !== 'node-checkpoint') assert.deepEqual(after, previous);
    }

    await page.goto(editorHref(origin, smokeId, token), { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
    await page.getByTestId('diagram-canvas').waitFor({ state: 'visible' });
    await waitFor(page, async () => (await page.locator('.react-flow__node').count()) === 100, PAGE_MS, '100 rendered nodes');
    await waitFor(page, async () => (await page.locator('.react-flow__edge').count()) === 150, PAGE_MS, '150 rendered edges');
    const smokeExport = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
    smokeExport.on('pageerror', error => pageErrors.push(error.message));
    await smokeExport.goto(editorHref(origin, smokeId, token, { revision: '1', export: '1' }), { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
    await smokeExport.waitForFunction(() => {
      const w = window as unknown as { __DIAGRAM_READY__?: { bounds?: { width: number; height: number }; nodeCount: number; edgeCount: number }; __DIAGRAM_ERROR__?: string };
      return Boolean(w.__DIAGRAM_READY__ || w.__DIAGRAM_ERROR__);
    }, undefined, { timeout: PAGE_MS });
    const smokeReady = await smokeExport.evaluate(() => {
      const w = window as unknown as { __DIAGRAM_READY__?: { bounds?: { width: number; height: number }; nodeCount: number; edgeCount: number }; __DIAGRAM_ERROR__?: string };
      return { ready: w.__DIAGRAM_READY__, error: w.__DIAGRAM_ERROR__ };
    });
    assert.equal(smokeReady.error, undefined, smokeReady.error ?? 'smoke export error');
    assert.equal(smokeReady.ready?.nodeCount, 100);
    assert.equal(smokeReady.ready?.edgeCount, 150);
    const width = smokeReady.ready?.bounds?.width ?? 0;
    const height = smokeReady.ready?.bounds?.height ?? 0;
    assert.ok(width <= 4096 && height <= 4096 && width * height <= 16_000_000, `smoke bounds ${width}x${height} exceed snapshot limits`);
    await smokeExport.screenshot({ path: join(BUILD_DIR, 'e2e-smoke-export.png'), type: 'png', animations: 'disabled' });
    await smokeExport.close();

    await openDocument(page, origin, documentId, token);
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 6 · Saved', 10000, 'latest head before history restore');
    await page.getByRole('button', { name: 'Toggle history', exact: true }).click();
    await page.locator('.history-item').filter({ hasText: /^Revision 2\b/ }).click();
    await page.getByRole('button', { name: 'Revert to Rev 2', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revert to Rev 2', exact: true }).click();
    await waitFor(page, async () => (await badgeText(page)) === 'Rev 7 · Saved', 10000, 'specific history revision restored');
    const restored = runCli(workspace, ['read', documentId]).document as typeof savedDoc;
    assert.equal(restored.revision, 7);
    assert.deepEqual(restored.nodes, savedDoc.nodes);
    assert.deepEqual(restored.edges, savedDoc.edges);
    console.log('Specific history revision restored as revision 7.');

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
    assert.ok(Date.now() - started < OVERALL_MS, 'rehearsal exceeded the overall bound');
    process.stdout.write(`e2e rehearsal passed in ${Date.now() - started}ms\n`);
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      await activePage.screenshot({ path: join(BUILD_DIR, 'e2e-failure.png') });
      console.error((await activePage.locator('body').innerText()).slice(-2200));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => {
  process.stderr.write('e2e rehearsal exceeded the 180s overall timeout\n');
  process.exit(1);
}, OVERALL_MS);
timer.unref();

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
