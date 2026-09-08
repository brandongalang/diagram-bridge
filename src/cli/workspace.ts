import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface WorkspaceConfig { schemaVersion: 1; workspaceId: string; port: number }
export const DATA_DIRECTORY = '.diagram-bridge';
export const MAX_JSON_BYTES = 5 * 1024 * 1024;

export function fault(code: string, message: string, exitCode = 5, details?: unknown): Error & { code: string; exitCode: number; details?: unknown } {
  return Object.assign(new Error(message), { code, exitCode, details });
}

const GLOBAL_OPTIONS = new Set(['workspace', 'json', 'help']);
const COMMAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  init: new Set(['workspace', 'port']),
  create: new Set(['from', 'author']),
  list: new Set(),
  read: new Set(['revision']),
  pull: new Set(['since', 'brief']),
  apply: new Set(['file', 'base-revision', 'request-id', 'author', 'summary', 'dry-run']),
  history: new Set(),
  revert: new Set(['base-revision', 'request-id', 'author', 'summary']),
  export: new Set(['output', 'revision']),
  snapshot: new Set(['output', 'revision']),
  serve: new Set(['port']),
  open: new Set(['no-browser']),
  schema: new Set(),
};

export function rejectInapplicableOptions(command: string, values: Record<string, unknown>): void {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    if (GLOBAL_OPTIONS.has(name) || allowed.has(name)) continue;
    throw fault('INVALID_ARGUMENT', `--${name} is not valid for ${command}.`, 2);
  }
}

export function enrichActionableError(error: Error & { code?: string; exitCode?: number; details?: unknown }): Error & { code: string; exitCode: number; details?: unknown } {
  const code = error.code ?? 'RUNTIME_ERROR';
  if (code !== 'STALE_REVISION_CONFLICT' && code !== 'INVALID_BASELINE') return error as Error & { code: string; exitCode: number; details?: unknown };
  const details = error.details !== null && typeof error.details === 'object' ? { ...(error.details as Record<string, unknown>) } : {};
  if (code === 'STALE_REVISION_CONFLICT') {
    details.actionableNextSteps ??= 'Pull the current head, inspect the diff, then apply a new batch with a fresh --request-id and --base-revision matching the returned headRevision.';
  } else {
    details.actionableNextSteps ??= 'Pull the document, then pass --since equal to a known committed revision at or below headRevision. Do not invent a baseline.';
    if (details.headRevision === undefined) {
      const match = /Current head is (\d+)/.exec(error.message);
      if (match) details.headRevision = Number(match[1]);
    }
  }
  return fault(code, error.message, error.exitCode ?? (code === 'STALE_REVISION_CONFLICT' ? 3 : 4), details);
}

export function resolveWorkspace(input?: string): string {
  if (input) {
    const root = resolve(input);
    if (!existsSync(join(root, DATA_DIRECTORY))) throw fault('WORKSPACE_NOT_FOUND', `Initialize this workspace first: diagram init ${JSON.stringify(root)}`, 2);
    return root;
  }
  let current = process.cwd();
  while (!existsSync(join(current, DATA_DIRECTORY))) {
    const parent = dirname(current);
    if (parent === current) throw fault('WORKSPACE_NOT_FOUND', 'Run diagram init in the project directory, or pass --workspace PATH.', 2);
    current = parent;
  }
  return current;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function workspaceConfig(root: string, explicitPort?: number): WorkspaceConfig {
  const directory = join(root, DATA_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, 'config.json');
  let config: WorkspaceConfig;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkspaceConfig;
      if (config.schemaVersion !== 1 || typeof config.workspaceId !== 'string' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Unsupported workspace configuration');
    } catch {
      throw fault('WORKSPACE_CONFIG_INVALID', `Cannot read workspace configuration at ${configPath}. Preserve the data directory and repair the config file.`, 5);
    }
  } else {
    const workspaceId = randomUUID();
    const port = 16000 + (Number.parseInt(workspaceId.slice(0, 8), 16) % 20000);
    config = { schemaVersion: 1, workspaceId, port };
    writeJsonAtomic(configPath, config);
  }
  if (explicitPort !== undefined) {
    if (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65535) throw fault('INVALID_PORT', 'Choose a port between 1024 and 65535.', 2);
    if (config.port !== explicitPort) {
      config = { ...config, port: explicitPort };
      writeJsonAtomic(configPath, config);
    }
  }
  return config;
}

export function positiveInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw fault('INVALID_ARGUMENT', `${field} must be a positive integer.`, 2);
  return Number(value);
}

export function readJsonFile(path: string): unknown {
  if (statSync(resolve(path)).size > MAX_JSON_BYTES) throw fault('INPUT_TOO_LARGE', 'JSON input exceeds the 5 MiB limit.', 4);
  const buffer = readFileSync(resolve(path));
  if (buffer.length > MAX_JSON_BYTES) throw fault('INPUT_TOO_LARGE', 'JSON input exceeds the 5 MiB limit.', 4);
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw fault('INVALID_JSON', `Invalid JSON in ${path}.`, 4); }
}
