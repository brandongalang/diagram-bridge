import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DiagramStore } from '../commands/index.js';
import { canonicalJson } from '../core/index.js';
import { startServer } from '../server/index.js';
import { fault } from '../cli/workspace.js';

export interface SnapshotOptions { root: string; documentId: string; revision?: number; output: string; timeoutMs?: number }

export async function snapshot(options: SnapshotOptions) {
  const store = new DiagramStore(options.root);
  let document;
  try { document = store.read(options.documentId, options.revision); } finally { store.close(); }
  const groupMap = new Map(document.nodes.filter(node => node.kind === 'group').map(node => [node.id, node]));
  const boxes = document.nodes.map(node => {
    const parent = node.parentId ? groupMap.get(node.parentId) : undefined;
    return { x: node.layout.x + (parent?.layout.x ?? 0), y: node.layout.y + (parent?.layout.y ?? 0), width: node.layout.width, height: node.layout.height };
  });
  const minX = boxes.length ? Math.min(...boxes.map(box => box.x)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map(box => box.y)) : 0;
  const maxX = boxes.length ? Math.max(...boxes.map(box => box.x + box.width)) : 600;
  const maxY = boxes.length ? Math.max(...boxes.map(box => box.y + box.height)) : 400;
  const width = Math.max(1000, Math.ceil(maxX - minX + 240));
  const height = Math.max(700, Math.ceil(maxY - minY + 240));
  if (width > 4096 || height > 4096 || width * height > 16_000_000) throw fault('DIAGRAM_TOO_LARGE', 'This diagram exceeds the 4096px / 16-megapixel snapshot limit. Reduce its layout bounds or export the structured JSON.', 4, { width, height });

  const destination = resolve(options.output);
  if (!destination.toLowerCase().endsWith('.png')) throw fault('INVALID_OUTPUT', 'Snapshot output must end in .png.', 2);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const server = await startServer({ root: options.root, ephemeral: true, port: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void browser?.close(); }, timeoutMs);
  try {
    browser = await chromium.launch({ headless: true, timeout: Math.min(timeoutMs, 15_000) });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.setDefaultTimeout(timeoutMs);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === server.url || url.protocol === 'data:' ? route.continue() : route.abort('blockedbyclient');
    });
    await page.goto(`${server.url}/?document=${encodeURIComponent(document.documentId)}&revision=${document.revision}&export=1#token=${server.token}`, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForFunction(() => {
      const state = window as unknown as { __DIAGRAM_READY__?: unknown; __DIAGRAM_ERROR__?: string };
      return Boolean(state.__DIAGRAM_READY__ || state.__DIAGRAM_ERROR__);
    }, undefined, { timeout: timeoutMs });
    const state = await page.evaluate(() => {
      const w = window as unknown as { __DIAGRAM_READY__?: { documentId: string; revision: number; nodeCount: number; edgeCount: number }; __DIAGRAM_ERROR__?: string };
      return { ready: w.__DIAGRAM_READY__, error: w.__DIAGRAM_ERROR__ };
    });
    if (state.error || errors.length) throw fault('RENDER_FAILED', state.error ?? errors.join('; '));
    if (state.ready?.documentId !== document.documentId || state.ready.revision !== document.revision || state.ready.nodeCount !== document.nodes.length || state.ready.edgeCount !== document.edges.length) throw fault('RENDER_REVISION_MISMATCH', 'The renderer did not load the requested document revision.');
    const renderedNodes = await page.locator('.react-flow__node').count();
    const renderedEdges = await page.locator('.react-flow__edge').count();
    if (renderedNodes !== document.nodes.length || renderedEdges !== document.edges.length) throw fault('RENDER_INCOMPLETE', 'The canvas did not render every node and connection.', 5, { expectedNodes: document.nodes.length, renderedNodes, expectedEdges: document.edges.length, renderedEdges });
    await page.screenshot({ path: temporary, type: 'png', animations: 'disabled' });
    if (timedOut) throw fault('RENDER_TIMEOUT', `Snapshot exceeded ${timeoutMs}ms.`);
    renameSync(temporary, destination);
    return { documentId: document.documentId, revision: document.revision, contentHash: createHash('sha256').update(canonicalJson(document)).digest('hex'), path: destination, width, height };
  } catch (error) {
    if (timedOut) throw fault('RENDER_TIMEOUT', `Snapshot exceeded ${timeoutMs}ms. Saved content is intact.`);
    if (String(error).includes("Executable doesn't exist")) throw fault('BROWSER_MISSING', 'Install the image renderer with: npx playwright install chromium');
    throw error;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await server.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
