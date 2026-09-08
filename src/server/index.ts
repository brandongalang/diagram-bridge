import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { DiagramStore } from '../commands/index.js';
import { validateDocument, validateOperations } from '../core/index.js';
import type { ApplyRequest, DiagramDocument } from '../core/types.js';
import { DATA_DIRECTORY, MAX_JSON_BYTES, fault, positiveInteger, workspaceConfig, writeJsonAtomic } from '../cli/workspace.js';

export interface RunningServer { url: string; token: string; workspaceId: string; close: () => Promise<void> }
export interface ServerOptions { root: string; port?: number; ephemeral?: boolean; webRoot?: string }

function bundledWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const directory of [join(here, 'web'), resolve(here, '../../dist/web')]) {
    if (existsSync(join(directory, 'index.html'))) return directory;
  }
  throw fault('EDITOR_NOT_BUILT', 'Editor assets are missing. Run npm run build before serving or rendering.');
}

function envelope(error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  const fields = e as Error & { code?: string; exitCode?: number; details?: unknown };
  return { apiVersion: 1, error: { code: fields.code ?? 'RUNTIME_ERROR', message: e.message, ...(fields.details === undefined ? {} : { details: fields.details }) } };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw fault('RESULT_TOO_LARGE', 'Result exceeds the 5 MiB limit. Request a smaller revision range.', 4);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fault('CONTENT_TYPE', 'Use application/json.', 4);
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_JSON_BYTES) throw fault('INPUT_TOO_LARGE', 'JSON input exceeds the 5 MiB limit.', 4);
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault('INVALID_JSON', 'The request body must be valid JSON.', 4); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_BODY', 'The request body must be an object.', 4);
  return value as Record<string, unknown>;
}

function requestFields(value: Record<string, unknown>): Omit<ApplyRequest, 'operations'> {
  const keys = ['baseRevision', 'requestId', 'author', 'summary', 'operations'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw fault('INVALID_BODY', 'Unknown request field.', 4);
  if (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 1 || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 200) throw fault('INVALID_BODY', 'baseRevision and requestId are required.', 4);
  if (value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 200)) throw fault('INVALID_BODY', 'Invalid author.', 4);
  if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 2000)) throw fault('INVALID_BODY', 'Invalid summary.', 4);
  return { baseRevision: Number(value.baseRevision), requestId: value.requestId, author: typeof value.author === 'string' ? value.author : 'human', summary: value.summary as string | undefined };
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const config = workspaceConfig(options.root);
  const webRoot = options.webRoot ?? bundledWebRoot();
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(`Bearer ${token}`);
  const store = new DiagramStore(options.root);
  let origin = '';
  const runtimePath = join(options.root, DATA_DIRECTORY, 'server.json');

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { apiVersion: 1, error: { code: 'FORBIDDEN_ORIGIN', message: 'Only this local editor origin is allowed.' } });
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (rawPath.includes('..') || rawPath.includes('\\') || rawPath.includes('\0')) return json(res, 400, { apiVersion: 1, error: { code: 'INVALID_PATH', message: 'Invalid path.' } });
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true, workspaceId: config.workspaceId });
      if (url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) return json(res, 401, { apiVersion: 1, error: { code: 'UNAUTHORIZED', message: 'Open this editor with diagram open to refresh access.' } });
        if (req.method !== 'GET' && req.headers.origin !== origin) return json(res, 403, { apiVersion: 1, error: { code: 'FORBIDDEN_ORIGIN', message: 'Mutation requests require the editor origin.' } });
        if (url.pathname === '/api/bootstrap' && req.method === 'GET') return json(res, 200, { apiVersion: 1, workspaceId: config.workspaceId, documents: store.list(), workspacePath: resolve(options.root), cliPath: existsSync(join(dirname(fileURLToPath(import.meta.url)), 'cli.js')) ? join(dirname(fileURLToPath(import.meta.url)), 'cli.js') : resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js') });
        if (url.pathname === '/api/documents') {
          if (req.method === 'GET') return json(res, 200, { apiVersion: 1, documents: store.list() });
          if (req.method === 'POST') {
            const data = await body(req);
            if (Object.keys(data).some(key => !['title', 'document'].includes(key)) || typeof data.title !== 'string') throw fault('INVALID_BODY', 'A title and optional document are required.', 4);
            const from: DiagramDocument | undefined = data.document === undefined ? undefined : validateDocument(data.document);
            return json(res, 201, { apiVersion: 1, document: store.create(data.title, from, 'human') });
          }
        }
        const match = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_.-]+)(?:\/(head|history|pull|apply|revert))?$/);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET') {
            if (!action) return json(res, 200, { apiVersion: 1, document: store.read(id, positiveInteger(url.searchParams.get('revision') ?? undefined, 'revision')) });
            if (action === 'head') return json(res, 200, { apiVersion: 1, revision: store.read(id).revision });
            if (action === 'history') return json(res, 200, { apiVersion: 1, revisions: store.history(id) });
            if (action === 'pull') return json(res, 200, { apiVersion: 1, ...store.pull(id, positiveInteger(url.searchParams.get('since') ?? undefined, 'since')) });
          }
          if (req.method === 'POST' && (action === 'apply' || action === 'revert')) {
            const data = await body(req);
            const fields = requestFields(data);
            const result = action === 'apply' ? store.apply(id, { ...fields, operations: validateOperations(data.operations) }) : store.revert(id, fields);
            return json(res, 200, { apiVersion: 1, ...result });
          }
        }
        return json(res, 404, { apiVersion: 1, error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { apiVersion: 1, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
      const relative = rawPath === '/' ? 'index.html' : rawPath.slice(1);
      if (relative !== 'index.html' && !relative.startsWith('assets/') && relative !== 'favicon.svg') return json(res, 404, { apiVersion: 1, error: { code: 'NOT_FOUND', message: 'File not found.' } });
      const path = resolve(webRoot, relative);
      if (!path.startsWith(resolve(webRoot) + '/') || !existsSync(path) || !statSync(path).isFile()) return json(res, 404, { apiVersion: 1, error: { code: 'NOT_FOUND', message: 'File not found.' } });
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': relative === 'index.html' ? 'no-store' : 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(path));
    } catch (error) {
      if (res.headersSent) return res.end();
      const code = (error as { code?: string }).code;
      const status = code === 'STALE_REVISION_CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : (error as { exitCode?: number }).exitCode === 4 || (error as { exitCode?: number }).exitCode === 2 ? 400 : 500;
      json(res, status, envelope(error));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? config.port, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw fault('SERVER_START_FAILED', 'Could not determine server address.');
    origin = `http://127.0.0.1:${address.port}`;
    if (!options.ephemeral) writeJsonAtomic(runtimePath, { url: origin, token, workspaceId: config.workspaceId, pid: process.pid });
  } catch (error) {
    store.close();
    if ((error as { code?: string }).code === 'EADDRINUSE') throw fault('PORT_IN_USE', `Port ${options.port ?? config.port} is occupied. Stop the other server or explicitly choose --port. Existing drafts remain associated with the original port.`);
    throw error;
  }
  let closed = false;
  return {
    url: origin, token, workspaceId: config.workspaceId,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>(accept => server.close(() => accept()));
      store.close();
      if (!options.ephemeral && existsSync(runtimePath)) {
        try { if ((JSON.parse(readFileSync(runtimePath, 'utf8')) as { token: string }).token === token) unlinkSync(runtimePath); } catch { /* Another server may have replaced its runtime file. */ }
      }
    },
  };
}
