import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEARANCE,
  LEAD,
  MAX_LABEL_WIDTH,
  polylineToSvgPath,
  routeEdge,
  routeEdges,
  type Point,
  type Rect,
  type RouteResult,
  type Side
} from '../src/editor/routing/index.js';

const EPS = 1e-3;

function box(id: string, x: number, y: number, width = 120, height = 64): Rect {
  return { id, x, y, width, height };
}

function firstDelta(points: Point[]): Point {
  for (let i = 1; i < points.length; i += 1) {
    const x = points[i].x - points[i - 1].x;
    const y = points[i].y - points[i - 1].y;
    if (Math.abs(x) > EPS || Math.abs(y) > EPS) return { x, y };
  }
  return { x: 0, y: 0 };
}

function lastDelta(points: Point[]): Point {
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const x = points[i].x - points[i - 1].x;
    const y = points[i].y - points[i - 1].y;
    if (Math.abs(x) > EPS || Math.abs(y) > EPS) return { x, y };
  }
  return { x: 0, y: 0 };
}

function normal(side: Side): Point {
  if (side === 'top') return { x: 0, y: -1 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'bottom') return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

/** Independent open-interior hit test used by assertions, not the router implementation. */
function segmentEntersBody(a: Point, b: Point, r: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (Math.abs(a.y - b.y) <= EPS) {
    if (a.y <= r.y + EPS || a.y >= r.y + r.height - EPS) return false;
    return maxX > r.x + EPS && minX < r.x + r.width - EPS;
  }
  if (Math.abs(a.x - b.x) <= EPS) {
    if (a.x <= r.x + EPS || a.x >= r.x + r.width - EPS) return false;
    return maxY > r.y + EPS && minY < r.y + r.height - EPS;
  }
  return true;
}

function assertOrthogonal(points: Point[]): void {
  assert.ok(points.length >= 2, 'expected a polyline');
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    assert.ok(Math.abs(dx) <= EPS || Math.abs(dy) <= EPS, `non-orthogonal segment ${i}`);
  }
}

function assertClearsBodies(points: Point[], bodies: Rect[]): void {
  for (let i = 1; i < points.length; i += 1) {
    for (const body of bodies) {
      assert.equal(
        segmentEntersBody(points[i - 1], points[i], body),
        false,
        `segment ${i} enters ${body.id}`
      );
    }
  }
}

function assertPortDirections(result: RouteResult, source: Rect, target: Rect): void {
  const first = firstDelta(result.points);
  const last = lastDelta(result.points);
  const out = normal(result.sourceSide);
  const inward = { x: -normal(result.targetSide).x, y: -normal(result.targetSide).y };
  assert.ok(dot(first, out) > 0, `first segment must leave via ${result.sourceSide}`);
  assert.ok(dot(last, inward) > 0, `last segment must approach via ${result.targetSide}`);
  const start = result.points[0];
  const end = result.points[result.points.length - 1];
  const portX = (side: Side, r: Rect) =>
    side === 'left' ? r.x : side === 'right' ? r.x + r.width : r.x + r.width / 2;
  const portY = (side: Side, r: Rect) =>
    side === 'top' ? r.y : side === 'bottom' ? r.y + r.height : r.y + r.height / 2;
  assert.ok(Math.abs(start.x - portX(result.sourceSide, source)) < 12);
  assert.ok(Math.abs(start.y - portY(result.sourceSide, source)) < 12);
  assert.ok(Math.abs(end.x - portX(result.targetSide, target)) < 12);
  assert.ok(Math.abs(end.y - portY(result.targetSide, target)) < 12);
  const lead = result.points[1];
  assert.ok(Math.hypot(lead.x - start.x, lead.y - start.y) >= LEAD - 1, 'visible outward lead');
}

function assertRoutable(result: RouteResult, source: Rect, target: Rect, obstacles: Rect[]): void {
  assert.equal(result.unroutable, false);
  assertOrthogonal(result.points);
  assertPortDirections(result, source, target);
  assertClearsBodies(result.points, [source, target, ...obstacles]);
}

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

describe('routeEdge', () => {
  test('forward edge is orthogonal, deterministic, and clears bodies', () => {
    const source = box('s', 0, 40);
    const target = box('t', 320, 40);
    const a = routeEdge({ source, target, obstacles: [], label: 'Next' });
    const b = routeEdge({ source, target, obstacles: [], label: 'Next' });
    assertRoutable(a, source, target, []);
    assert.deepEqual(a, b);
    assert.ok(a.label);
    assert.ok(a.label.width <= MAX_LABEL_WIDTH);
    assert.equal(a.sourceSide, 'right');
    assert.equal(a.targetSide, 'left');
  });

  test('reverse, vertical, and self-loop edges stay outside node interiors', () => {
    const left = box('left', 0, 80);
    const right = box('right', 360, 80);
    const reverse = routeEdge({ source: right, target: left, obstacles: [] });
    assertRoutable(reverse, right, left, []);
    assert.equal(reverse.sourceSide, 'left');
    assert.equal(reverse.targetSide, 'right');

    const top = box('top', 80, 0);
    const bottom = box('bottom', 80, 280);
    const vertical = routeEdge({ source: top, target: bottom, obstacles: [] });
    assertRoutable(vertical, top, bottom, []);
    assert.equal(vertical.sourceSide, 'bottom');
    assert.equal(vertical.targetSide, 'top');

    const node = box('loop', 40, 40, 140, 80);
    const loop = routeEdge({ source: node, target: node, obstacles: [], label: 'retry' });
    assertRoutable(loop, node, node, []);
    assert.notEqual(loop.sourceSide, loop.targetSide);
    const xs = loop.points.map((p) => p.x);
    const ys = loop.points.map((p) => p.y);
    const crossesInterior =
      xs.some((x) => x > node.x + 1 && x < node.x + node.width - 1) &&
      ys.some((y) => y > node.y + 1 && y < node.y + node.height - 1) &&
      loop.points.some(
        (p) =>
          p.x > node.x + 1 &&
          p.x < node.x + node.width - 1 &&
          p.y > node.y + 1 &&
          p.y < node.y + node.height - 1
      );
    assert.equal(crossesInterior, false, 'self-loop must not cut across the node');
  });

  test('all four source and target sides keep outward/inward stubs off the body interior', () => {
    const source = box('s', 200, 200, 100, 80);
    const target = box('t', 520, 200, 100, 80);
    for (const sourceSide of SIDES) {
      const routed = routeEdge({ source, target, obstacles: [], sourceSide });
      assertRoutable(routed, source, target, []);
      assert.equal(routed.sourceSide, sourceSide);
    }
    for (const targetSide of SIDES) {
      const routed = routeEdge({ source, target, obstacles: [], targetSide });
      assertRoutable(routed, source, target, []);
      assert.equal(routed.targetSide, targetSide);
    }
  });

  test('a node in the direct path forces a visible detour', () => {
    const source = box('s', 0, 80);
    const target = box('t', 420, 80);
    const blocker = box('wall', 180, 64, 80, 96);
    const routed = routeEdge({ source, target, obstacles: [blocker], label: 'via' });
    assertRoutable(routed, source, target, [blocker]);
    const straight = routed.points.every((p) => Math.abs(p.y - routed.points[0].y) <= EPS);
    assert.equal(straight, false, 'must leave the blocked midline');
    assert.ok(routed.points.length >= 4);
  });

  test('multiple obstacles produce a detour that still clears every body', () => {
    const source = box('s', 0, 200);
    const target = box('t', 520, 200);
    const obstacles = [box('o1', 180, 160, 90, 140), box('o2', 320, 120, 90, 200)];
    const routed = routeEdge({ source, target, obstacles, label: 'hop' });
    assertRoutable(routed, source, target, obstacles);
    assert.ok(routed.label);
    const labelBox = routed.label!;
    for (const body of [source, target, ...obstacles]) {
      const overlap =
        labelBox.x < body.x + body.width &&
        labelBox.x + labelBox.width > body.x &&
        labelBox.y < body.y + body.height &&
        labelBox.y + labelBox.height > body.y;
      assert.equal(overlap, false, `label overlaps ${body.id}`);
    }
  });

  test('overlapping source and target is unroutable and never a straight cut', () => {
    const source = box('s', 0, 0, 120, 80);
    const target = box('t', 40, 20, 120, 80);
    const routed = routeEdge({ source, target, obstacles: [] });
    assert.equal(routed.unroutable, true);
    assert.deepEqual(routed.points, []);
    assert.equal(routed.label, null);
  });

  test('identical rectangles with different ids are unroutable overlap, not a self-loop', () => {
    const source = box('alpha', 40, 40, 120, 80);
    const target = box('beta', 40, 40, 120, 80);
    const routed = routeEdge({ source, target, obstacles: [], label: 'retry' });
    assert.equal(routed.unroutable, true);
    assert.deepEqual(routed.points, []);
    assert.equal(routed.label, null);
  });

  test('a thin obstacle across the source stub does not cross even when the middle is free', () => {
    const source = box('s', 0, 80, 120, 64);
    const target = box('t', 400, 80, 120, 64);
    const needle = box('needle', 126, 100, 8, 24);
    const forced = routeEdge({
      source,
      target,
      obstacles: [needle],
      sourceSide: 'right'
    });
    assert.equal(forced.unroutable, true);
    assert.deepEqual(forced.points, []);

    const free = routeEdge({ source, target, obstacles: [needle] });
    assertRoutable(free, source, target, [needle]);
    assert.notEqual(free.sourceSide, 'right');
  });

  test('after coordinate thinning every final segment stays orthogonal and body-safe', () => {
    const source = box('s', 0, 400, 100, 60);
    const target = box('t', 2200, 400, 100, 60);
    const obstacles: Rect[] = [box('wall', 1000, 390, 50, 80)];
    for (let i = 0; i < 230; i += 1) {
      const x = 140 + ((i * 13) % 1900) + (i % 7);
      const y = i % 2 === 0 ? 40 + (i % 11) * 17 : 560 + (i % 9) * 15;
      obstacles.push(box(`o-${i}`, x, y, 22, 18));
    }
    const routed = routeEdge({ source, target, obstacles, label: 'thin' });
    assertRoutable(routed, source, target, obstacles);
    assertOrthogonal(routed.points);
    assertClearsBodies(routed.points, [source, target, ...obstacles]);
  });

  test('honors explicit sides when they are routable', () => {
    const source = box('s', 0, 0);
    const target = box('t', 300, 200);
    const routed = routeEdge({
      source,
      target,
      obstacles: [],
      sourceSide: 'bottom',
      targetSide: 'right'
    });
    assertRoutable(routed, source, target, []);
    assert.equal(routed.sourceSide, 'bottom');
    assert.equal(routed.targetSide, 'right');
  });

  test('does not mutate inputs', () => {
    const source = box('s', 0, 0);
    const target = box('t', 240, 0);
    const obstacles = [box('o', 90, -10, 40, 80)];
    const snapshot = JSON.stringify({ source, target, obstacles });
    routeEdge({ source, target, obstacles, label: 'keep' });
    assert.equal(JSON.stringify({ source, target, obstacles }), snapshot);
  });

  test('includes a sample route for root / CustomEdge integration', () => {
    const source = box('infer', 80, 120, 220, 88);
    const target = box('store', 480, 120, 220, 88);
    const sample = routeEdge({
      source,
      target,
      obstacles: [],
      label: 'persist'
    });
    assertRoutable(sample, source, target, []);
    const svg = polylineToSvgPath(sample.points);
    assert.match(svg, /^M /);
    assert.match(svg, / L /);
    // Stable sample for the canvas agent: world-space polyline + handle sides.
    assert.equal(sample.sourceSide, 'right');
    assert.equal(sample.targetSide, 'left');
    assert.deepEqual(sample.points[0], { x: 300, y: 164 });
    assert.deepEqual(sample.points[sample.points.length - 1], { x: 480, y: 164 });
  });

  test('bounded 100-obstacle / 150-edge case finishes without hanging', () => {
    const obstacles: Rect[] = [];
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        obstacles.push(box(`n-${row}-${col}`, col * 160, row * 110, 90, 50));
      }
    }
    const requests = [];
    let n = 0;
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 9 && n < 150; col += 1) {
        requests.push({
          source: obstacles[row * 10 + col],
          target: obstacles[row * 10 + col + 1],
          obstacles,
          label: n % 7 === 0 ? 'step' : undefined
        });
        n += 1;
      }
    }
    for (let col = 0; col < 10 && n < 150; col += 1) {
      for (let row = 0; row < 9 && n < 150; row += 1) {
        requests.push({
          source: obstacles[row * 10 + col],
          target: obstacles[(row + 1) * 10 + col],
          obstacles
        });
        n += 1;
      }
    }
    while (n < 150) {
      requests.push({
        source: obstacles[n % 100],
        target: obstacles[(n * 7) % 100],
        obstacles
      });
      n += 1;
    }

    const started = performance.now();
    const results = routeEdges(requests);
    const elapsedMs = performance.now() - started;
    assert.equal(results.length, 150);
    const routed = results.filter((r) => !r.unroutable);
    assert.ok(routed.length >= 100, `expected most edges to route, got ${routed.length}`);
    for (const r of routed.slice(0, 20)) {
      assertOrthogonal(r.points);
    }
    assert.ok(elapsedMs < 30_000, `router exceeded bound: ${elapsedMs}ms`);
    (globalThis as { __routingLargeCaseMs?: number }).__routingLargeCaseMs = elapsedMs;
  });

  test('staggered 100-node / 150-edge case finishes and stays orthogonal', () => {
    const obstacles: Rect[] = [];
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        obstacles.push(
          box(
            `st-${row}-${col}`,
            col * 170 + (row % 3) * 19,
            row * 120 + (col % 2) * 27,
            90,
            50
          )
        );
      }
    }
    const requests = [];
    let n = 0;
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 9 && n < 150; col += 1) {
        requests.push({
          source: obstacles[row * 10 + col],
          target: obstacles[row * 10 + col + 1],
          obstacles
        });
        n += 1;
      }
    }
    for (let col = 0; col < 10 && n < 150; col += 1) {
      for (let row = 0; row < 9 && n < 150; row += 1) {
        requests.push({
          source: obstacles[row * 10 + col],
          target: obstacles[(row + 1) * 10 + col],
          obstacles
        });
        n += 1;
      }
    }
    while (n < 150) {
      requests.push({
        source: obstacles[n % 100],
        target: obstacles[(n * 11 + 3) % 100],
        obstacles
      });
      n += 1;
    }

    const started = performance.now();
    const results = routeEdges(requests);
    const elapsedMs = performance.now() - started;
    assert.equal(results.length, 150);
    const routed = results.filter((r) => !r.unroutable);
    assert.ok(routed.length >= 90, `expected most staggered edges to route, got ${routed.length}`);
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (r.unroutable) continue;
      assertOrthogonal(r.points);
      assertClearsBodies(r.points, [requests[i].source, requests[i].target, ...obstacles]);
    }
    assert.ok(elapsedMs < 30_000, `staggered router exceeded bound: ${elapsedMs}ms`);
    (globalThis as { __routingStaggeredCaseMs?: number }).__routingStaggeredCaseMs = elapsedMs;
  });

  test('1000-body graph construction stays bounded for long edges', () => {
    const nodes: Rect[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const col = i % 40;
      const row = Math.floor(i / 40);
      nodes.push(
        box(`w-${i}`, col * 140 + (row % 4) * 11, row * 100 + (col % 3) * 13, 70, 40)
      );
    }
    const requests = [
      { source: nodes[0], target: nodes[39], obstacles: nodes },
      { source: nodes[0], target: nodes[999], obstacles: nodes },
      { source: nodes[20], target: nodes[980], obstacles: nodes },
      { source: nodes[400], target: nodes[439], obstacles: nodes },
      { source: nodes[50], target: nodes[850], obstacles: nodes }
    ];
    const started = performance.now();
    const results = routeEdges(requests);
    const elapsedMs = performance.now() - started;
    assert.equal(results.length, 5);
    for (const r of results.filter((x) => !x.unroutable)) {
      assertOrthogonal(r.points);
    }
    assert.ok(elapsedMs < 8_000, `1000-body case exceeded bound: ${elapsedMs}ms`);
    (globalThis as { __routingThousandBodyMs?: number }).__routingThousandBodyMs = elapsedMs;
  });

  test('extreme coordinates stay finite and unroutable rather than searching forever', () => {
    const source = box('s', 0, 0);
    const target = box('t', 1e12, 0);
    const routed = routeEdge({ source, target, obstacles: [] });
    assert.equal(routed.unroutable, true);
    assert.deepEqual(routed.points, []);
  });
});

describe('constants', () => {
  test('clearance and lead match the routing contract', () => {
    assert.equal(CLEARANCE, 14);
    assert.equal(LEAD, 20);
  });
});


test('places a readable label outside the bodies when the connecting gap is narrow', () => {
  const source = { id: 'a', x: 0, y: 0, width: 220, height: 88 };
  const target = { id: 'b', x: 290, y: 0, width: 220, height: 88 };
  const result = routeEdge({ source, target, obstacles: [source, target], label: 'Enriched input' });
  assert.ok(result.label);
  assert.ok(result.label.width >= 100);
  assert.ok(result.label.y + result.label.height < 0 || result.label.y > 88);
});
