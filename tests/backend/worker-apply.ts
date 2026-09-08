import { DiagramStore } from '../../src/commands/index.js';

const workspaceRoot = process.argv[2];
const docId = process.argv[3];
const baseRevision = parseInt(process.argv[4], 10);
const requestId = process.argv[5];
const label = process.argv[6];

try {
  const store = new DiagramStore(workspaceRoot);
  const result = store.apply(docId, {
    baseRevision,
    requestId,
    author: 'worker',
    operations: [
      {
        type: 'addNode',
        node: {
          id: `node-${requestId}`,
          kind: 'step',
          label,
          layout: { x: 10, y: 10, width: 220, height: 88 },
        },
      },
    ],
  });
  store.close();
  console.log(JSON.stringify({ status: 'ok', revision: result.revision }));
  process.exit(0);
} catch (err: any) {
  console.error(JSON.stringify({ status: 'error', code: err.code, message: err.message, exitCode: err.exitCode }));
  process.exit(err.exitCode ?? 1);
}
