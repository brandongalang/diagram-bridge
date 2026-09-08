#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateAndNormalizeAuthor, validateAndNormalizeSummary } from '../commands/store.js';
import { DiagramStore } from '../commands/index.js';
import { validateDocument, validateOperations, canonicalJson, applyOps, diffDocuments, idSchema } from '../core/index.js';
import { snapshot } from '../render/index.js';
import { startServer } from '../server/index.js';
import { DATA_DIRECTORY, MAX_JSON_BYTES, enrichActionableError, fault, positiveInteger, readJsonFile, rejectInapplicableOptions, resolveWorkspace, workspaceConfig } from './workspace.js';
import { briefPull, documentChanged } from './preview.js';

const HELP = `Diagram Bridge — local diagrams for people and agents

Usage: diagram COMMAND [DOCUMENT_ID] [options]

  init [PATH]                     Initialize local diagram storage
  create TITLE [--from FILE]       Create a diagram or copy a JSON export
  list                            List saved diagrams
  read ID [--revision N]           Read a complete committed document
  pull ID [--since N] [--brief]    Read net diff and note activity (omits whole document with --brief)
  apply ID --file FILE             Apply one atomic operation batch (--dry-run previews without writing)
  history ID                      List committed revisions
  revert ID                       Restore the preceding revision as a commit
  export ID --output FILE          Write portable document JSON
  snapshot ID --output FILE.png    Render an exact committed revision to PNG
  serve [--port N]                 Run the local editor server until Ctrl-C
  open [ID] [--no-browser]         Open an already-running local editor
  schema [document|operations]     Print the JSON contract

Options:
  --workspace PATH                Explicit project workspace
  --base-revision N                Required for apply and revert
  --request-id ID                  Required for apply/revert; reuse on exact retry
  --dry-run                       Validate apply batch and return diff without writing
  --brief                         Concise pull summary separating layout vs content/notes
  --author NAME                   Revision author (default: agent)
  --summary TEXT                  Short explanation of a mutation
  --revision N                    Exact revision for read/export/snapshot
  --json                          Versioned JSON output (also the default)
  --help                          Show this help

Save browser edits, then ask your agent to pull. Pull returns immediately;
it never waits, advances a hidden cursor, or wakes another agent.

Agent loop:
  diagram pull ID --since 3 --brief --json
  diagram snapshot ID --revision 4 --output plan.png
  diagram apply ID --file edits.json --base-revision 4 --request-id unique-id --dry-run
  diagram apply ID --file edits.json --base-revision 4 --request-id unique-id

A batch file is an array of operations, or {"operations":[...]}.
Example: [{"type":"setTitle","title":"Classification plan"}]
Run diagram schema operations for every supported operation.
Errors are JSON on stderr. Exits: 0 success, 2 usage, 3 stale revision,
4 invalid data/baseline, 5 storage/runtime. JSON limit: 5 MiB.
`;

function emit(value: unknown) {
  const output = `${JSON.stringify({ apiVersion: 1, ...(value as object) }, null, 2)}\n`;
  if (Buffer.byteLength(output) > MAX_JSON_BYTES) throw fault('RESULT_TOO_LARGE', 'Result exceeds the 5 MiB output limit. Request a smaller revision range.', 4);
  process.stdout.write(output);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw fault('MISSING_ARGUMENT', `${name} is required. Run diagram --help.`, 2);
  return value;
}

function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(fault('BROWSER_OPEN_FAILED', 'The browser could not open. Use the URL returned by open --no-browser.')));
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, strict: true, options: {
      workspace: { type: 'string' }, from: { type: 'string' }, file: { type: 'string' }, output: { type: 'string' },
      revision: { type: 'string' }, since: { type: 'string' }, 'base-revision': { type: 'string' }, 'request-id': { type: 'string' },
      author: { type: 'string' }, summary: { type: 'string' }, port: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, 'no-browser': { type: 'boolean' },
      'dry-run': { type: 'boolean' }, brief: { type: 'boolean' },
    } });
  } catch (error) { throw fault('INVALID_ARGUMENT', (error as Error).message, 2); }
  const { values, positionals } = parsed;
  const [command, argument, ...extra] = positionals;
  if (values.help || !command || command === 'help') { process.stdout.write(HELP); return; }
  if (extra.length) throw fault('INVALID_ARGUMENT', 'Unexpected extra arguments. Quote multi-word titles.', 2);
  if (command === 'schema') {
    rejectInapplicableOptions('schema', values);
    if (argument && !['document', 'operations'].includes(argument)) throw fault('INVALID_ARGUMENT', 'Schema must be document or operations.', 2);
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [resolve(here, '../schemas'), resolve(here, '../../schemas')];
    const schemaRoot = roots.find(path => existsSync(join(path, 'diagram-document.json')));
    if (!schemaRoot) throw fault('SCHEMA_MISSING', 'Packaged JSON schemas are missing.');
    const document = JSON.parse(readFileSync(join(schemaRoot, 'diagram-document.json'), 'utf8'));
    const operations = JSON.parse(readFileSync(join(schemaRoot, 'operations.json'), 'utf8'));
    emit(argument ? { schema: argument === 'document' ? document : operations } : { document, operations });
    return;
  }
  if (command === 'init') {
    rejectInapplicableOptions('init', values);
    const root = resolve(argument ?? values.workspace ?? '.');
    const config = workspaceConfig(root, positiveInteger(values.port, 'port'));
    const store = new DiagramStore(root);
    store.close();
    emit({ workspace: root, workspaceId: config.workspaceId, dataDirectory: join(root, DATA_DIRECTORY), port: config.port });
    return;
  }
  const commands = ['create', 'list', 'read', 'pull', 'apply', 'history', 'revert', 'export', 'snapshot', 'serve', 'open'];
  if (!commands.includes(command)) throw fault('UNKNOWN_COMMAND', `Unknown command: ${command}. Run diagram --help.`, 2);
  if (['list', 'serve'].includes(command) && argument) throw fault('INVALID_ARGUMENT', `${command} does not accept a document argument.`, 2);
  rejectInapplicableOptions(command, values);
  const root = resolveWorkspace(values.workspace);
  if (command === 'serve') {
    if (values.port) workspaceConfig(root, positiveInteger(values.port, 'port'));
    const server = await startServer({ root });
    emit({ url: server.url, workspaceId: server.workspaceId, message: 'Server running. Use diagram open to open an editor; Ctrl-C stops this server.' });
    await new Promise<void>(accept => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void server.close().then(accept); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }
  if (command === 'open') {
    const path = join(root, DATA_DIRECTORY, 'server.json');
    if (!existsSync(path)) throw fault('SERVER_NOT_RUNNING', 'Start the local server with diagram serve in a terminal, then run diagram open again.');
    const config = workspaceConfig(root);
    const server = JSON.parse(readFileSync(path, 'utf8')) as { url: string; token: string; workspaceId: string };
    if (server.url !== `http://127.0.0.1:${config.port}` || server.workspaceId !== config.workspaceId || !/^[a-f0-9]{64}$/.test(server.token)) throw fault('SERVER_NOT_RUNNING', 'The local server configuration is stale. Restart diagram serve.');
    try {
      const response = await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(3000) });
      const result = await response.json() as { workspaceId?: string };
      if (!response.ok || result.workspaceId !== config.workspaceId) throw new Error('Wrong workspace');
    } catch { throw fault('SERVER_NOT_RUNNING', 'The local editor server is unavailable. Start diagram serve, then retry.'); }
    if (argument) { const store = new DiagramStore(root); try { store.read(argument); } finally { store.close(); } }
    const url = `${server.url}/${argument ? `?document=${encodeURIComponent(argument)}` : ''}#token=${server.token}`;
    if (!values['no-browser']) await openBrowser(url);
    emit({ url, workspaceId: config.workspaceId });
    return;
  }
  if (command === 'snapshot') {
    emit(await snapshot({ root, documentId: required(argument, 'Document ID'), revision: positiveInteger(values.revision, 'revision'), output: required(values.output, '--output') }));
    return;
  }
  const store = new DiagramStore(root);
  try {
    if (command === 'create') {
      const from = values.from ? validateDocument(readJsonFile(values.from)) : undefined;
      emit({ document: store.create(required(argument, 'Title'), from, values.author ?? 'agent') });
      return;
    }
    if (command === 'list') { emit({ documents: store.list() }); return; }
    const id = required(argument, 'Document ID');
    if (command === 'read') { emit({ document: store.read(id, positiveInteger(values.revision, 'revision')) }); return; }
    if (command === 'pull') {
      try {
        const pulled = store.pull(id, positiveInteger(values.since, 'since'));
        emit(values.brief ? briefPull(pulled) : pulled);
      } catch (error) {
        throw enrichActionableError(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (command === 'history') { emit({ revisions: store.history(id) }); return; }
    if (command === 'export') {
      const document = store.read(id, positiveInteger(values.revision, 'revision'));
      const path = resolve(required(values.output, '--output'));
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${canonicalJson(document)}\n`, { mode: 0o600 });
      renameSync(temp, path);
      emit({ path, documentId: document.documentId, revision: document.revision });
      return;
    }
    const request = {
      baseRevision: positiveInteger(required(values['base-revision'], '--base-revision'), 'base-revision')!,
      requestId: values['dry-run'] && command === 'apply' ? values['request-id'] : required(values['request-id'], '--request-id'),
      author: values.author ?? 'agent',
      summary: values.summary,
    };
    if (command === 'revert') {
      try { emit(store.revert(id, { ...request, requestId: request.requestId! })); }
      catch (error) { throw enrichActionableError(error instanceof Error ? error : new Error(String(error))); }
      return;
    }
    const operations = validateOperations(readOperations(required(values.file, '--file')));
    if (values['dry-run']) {
      validateAndNormalizeAuthor(request.author);
      validateAndNormalizeSummary(request.summary, 'Apply operations');
      emit(previewApply(store, id, request.baseRevision, operations, request.requestId));
      return;
    }
    try { emit(store.apply(id, { ...request, requestId: request.requestId!, operations })); }
    catch (error) { throw enrichActionableError(error instanceof Error ? error : new Error(String(error))); }
  } finally { store.close(); }
}

function readOperations(path: string): unknown {
  const input = readJsonFile(path);
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    if (Object.keys(input).length !== 1 || !('operations' in input)) throw fault('INVALID_BATCH', 'Batch must be an operations array or an object containing only operations.', 4);
    return (input as { operations: unknown }).operations;
  }
  return input;
}

function previewApply(store: DiagramStore, id: string, baseRevision: number, operations: ReturnType<typeof validateOperations>, requestId?: string) {
  if (requestId !== undefined) {
    const parsed = idSchema.safeParse(requestId);
    if (!parsed.success) throw fault('VALIDATION_ERROR', `Invalid requestId '${requestId}'`, 4);
  }
  let current;
  try { current = store.read(id); }
  catch (error) { throw enrichActionableError(error instanceof Error ? error : new Error(String(error))); }
  if (current.revision !== baseRevision) {
    throw enrichActionableError(fault(
      'STALE_REVISION_CONFLICT',
      `Mutation rejected: base revision is stale. Expected ${baseRevision}, current head is ${current.revision}`,
      3,
      { documentId: id, expectedRevision: baseRevision, currentRevision: current.revision }
    ));
  }
  const next = applyOps(current, operations);
  const diff = diffDocuments(current, next);
  const changed = documentChanged(diff);
  const nextRevision = changed ? current.revision + 1 : current.revision;
  if (changed) validateDocument({ ...next, revision: nextRevision });
  return {
    dryRun: true,
    documentId: id,
    baseRevision,
    nextRevision,
    changed,
    diff,
    operationsCount: operations.length,
  };
}

main().catch(error => {
  const e = enrichActionableError(error instanceof Error ? error : new Error(String(error)));
  const fields = e as Error & { code?: string; exitCode?: number; details?: unknown };
  process.stderr.write(`${JSON.stringify({ apiVersion: 1, error: { code: fields.code ?? 'RUNTIME_ERROR', message: e.message, ...(fields.details === undefined ? {} : { details: fields.details }) } })}\n`);
  process.exitCode = fields.exitCode ?? 5;
});
