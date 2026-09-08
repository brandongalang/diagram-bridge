import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const repository = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'diagram-package-'));
const prefix = join(temporary, 'install');
const workspace = join(temporary, 'workspace');
mkdirSync(workspace);
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temporary, '--json'], {
    cwd: repository,
    timeout: 30000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const tarballName = (Array.isArray(packed) ? packed[0] : packed)?.filename;
  assert.equal(typeof tarballName, 'string');
  assert.ok(tarballName.length > 0);
  const tarball = join(temporary, tarballName);
  execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', tarball], { timeout: 60000, stdio: 'pipe' });
  const installed = join(prefix, 'node_modules', 'diagram-bridge');
  assert.ok(existsSync(join(installed, 'README.md')));
  assert.ok(existsSync(join(installed, 'LICENSE')));
  assert.ok(existsSync(join(installed, 'docs/agent-usage.md')));
  const cli = join(installed, 'dist', 'cli.js');
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: temporary, timeout: 45000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(run('schema', 'document').schema);
  run('init', workspace);
  const first = run('create', 'Packaged classification', '--from', join(installed, 'examples/checkpoint-workflow.json'), '--workspace', workspace).document;
  const operations = join(temporary, 'edits.json');
  writeFileSync(operations, JSON.stringify([{ type: 'setTitle', title: 'Packaged revision two' }]));
  const second = run('apply', first.documentId, '--file', operations, '--workspace', workspace, '--base-revision', '1', '--request-id', 'package-smoke').document;
  assert.equal(second.revision, 2);
  const pull = run('pull', first.documentId, '--since', '1', '--workspace', workspace);
  assert.equal(pull.headRevision, 2);
  const png = join(temporary, 'snapshot.png');
  const image = run('snapshot', first.documentId, '--revision', '1', '--output', png, '--workspace', workspace);
  assert.equal(image.revision, 1);
  assert.deepEqual([...readFileSync(png).subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  console.log(JSON.stringify({ installedOutsideCheckout: true, applyRevision: second.revision, imageRevision: image.revision, pngBytes: readFileSync(png).length }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
