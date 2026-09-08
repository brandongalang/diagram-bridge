import {
  bboxOf,
  centerOf,
  dirFromDelta,
  inflate,
  leadPoint,
  pathClearsBodies,
  pathIsOrthogonal,
  portOnSide,
  quantize,
  segmentHitsOpenRect,
  simplifyOrthogonal
} from './geometry.js';
import {
  BEND_COST,
  EPS,
  MAX_BODIES_IN_SEARCH,
  MAX_EXPANSIONS,
  MAX_GRAPH_SEGMENT_TESTS,
  MAX_UNIQUE_COORDS,
  SEARCH_MARGIN,
  type Point,
  type Rect,
  type Side
} from './types.js';

type HeapItem = { key: number; xi: number; yi: number; dir: number };

class MinHeap {
  private items: HeapItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapItem): void {
    this.items.push(item);
    this.up(this.items.length - 1);
  }

  pop(): HeapItem | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].key <= this.items[i].key) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      i = p;
    }
  }

  private down(i: number): void {
    const n = this.items.length;
    while (true) {
      let min = i;
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      if (l < n && this.items[l].key < this.items[min].key) min = l;
      if (r < n && this.items[r].key < this.items[min].key) min = r;
      if (min === i) break;
      [this.items[min], this.items[i]] = [this.items[i], this.items[min]];
      i = min;
    }
  }
}

function uniqueSorted(values: number[]): number[] {
  const q = values.map(quantize).filter((n) => Number.isFinite(n));
  q.sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of q) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - n) > EPS) out.push(n);
  }
  return out;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
}

function indexOfCoord(axis: number[], value: number): number {
  const q = quantize(value);
  for (let i = 0; i < axis.length; i += 1) {
    if (Math.abs(axis[i] - q) <= EPS) return i;
  }
  return -1;
}

function thinCoords(coords: number[], max: number, keep: number[]): number[] {
  if (coords.length <= max) return coords;
  const pinned = uniqueSorted(keep);
  if (pinned.length > max) return [];
  const reserved = pinned.map((n) => quantize(n));
  const extras = coords.filter((v) => reserved.every((p) => Math.abs(p - v) > EPS));
  const slots = max - pinned.length;
  const sampled: number[] = [];
  if (slots > 0 && extras.length > 0) {
    if (extras.length <= slots) {
      sampled.push(...extras);
    } else {
      const step = (extras.length - 1) / Math.max(1, slots - 1);
      for (let i = 0; i < slots; i += 1) {
        const v = extras[Math.round(i * step)];
        if (sampled.length === 0 || Math.abs(v - sampled[sampled.length - 1]) > EPS) {
          sampled.push(v);
        }
      }
    }
  }
  return uniqueSorted([...pinned, ...sampled]);
}

function coordBudget(bodyCount: number): number {
  if (bodyCount > 80) return 28;
  if (bodyCount > 32) return 48;
  return MAX_UNIQUE_COORDS;
}

function distToSegmentBox(p: Point, a: Point, b: Point): number {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const dx = p.x < minX ? minX - p.x : p.x > maxX ? p.x - maxX : 0;
  const dy = p.y < minY ? minY - p.y : p.y > maxY ? p.y - maxY : 0;
  return dx + dy;
}

function selectSearchBodies(source: Rect, target: Rect, bodies: Rect[]): Rect[] {
  const sc = centerOf(source);
  const tc = centerOf(target);
  const ranked = bodies
    .map((b) => ({ b, d: distToSegmentBox(centerOf(b), sc, tc) }))
    .sort((a, c) => a.d - c.d || a.b.id.localeCompare(c.b.id));
  const out: Rect[] = [];
  const seen = new Set<string>();
  const take = (r: Rect) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  take(source);
  take(target);
  for (const { b } of ranked) {
    if (out.length >= MAX_BODIES_IN_SEARCH) break;
    take(b);
  }
  return out;
}

function segmentBlocked(a: Point, b: Point, inflated: Rect[]): boolean {
  for (const r of inflated) {
    if (segmentHitsOpenRect(a, b, r)) return true;
  }
  return false;
}

function pointBlocked(p: Point, inflated: Rect[]): boolean {
  for (const r of inflated) {
    if (
      p.x > r.x + EPS &&
      p.x < r.x + r.width - EPS &&
      p.y > r.y + EPS &&
      p.y < r.y + r.height - EPS
    ) {
      return true;
    }
  }
  return false;
}

type Neigh = { xi: number; yi: number; dist: number };

function buildIncident(
  xs: number[],
  ys: number[],
  inflated: Rect[]
): Neigh[][][] | null {
  const incident: Neigh[][][] = Array.from({ length: xs.length }, () =>
    Array.from({ length: ys.length }, () => [])
  );
  let tests = 0;

  for (let yi = 0; yi < ys.length; yi += 1) {
    const y = ys[yi];
    const crossers = inflated.filter((r) => y > r.y + EPS && y < r.y + r.height - EPS);
    const free: number[] = [];
    for (let xi = 0; xi < xs.length; xi += 1) {
      if (!pointBlocked({ x: xs[xi], y }, inflated)) free.push(xi);
    }
    for (let i = 0; i < free.length - 1; i += 1) {
      tests += Math.max(1, crossers.length);
      if (tests > MAX_GRAPH_SEGMENT_TESTS) return null;
      const a = free[i];
      const b = free[i + 1];
      const pa = { x: xs[a], y };
      const pb = { x: xs[b], y };
      if (segmentBlocked(pa, pb, crossers)) continue;
      const dist = Math.abs(xs[b] - xs[a]);
      incident[a][yi].push({ xi: b, yi, dist });
      incident[b][yi].push({ xi: a, yi, dist });
    }
  }

  for (let xi = 0; xi < xs.length; xi += 1) {
    const x = xs[xi];
    const crossers = inflated.filter((r) => x > r.x + EPS && x < r.x + r.width - EPS);
    const free: number[] = [];
    for (let yi = 0; yi < ys.length; yi += 1) {
      if (!pointBlocked({ x, y: ys[yi] }, inflated)) free.push(yi);
    }
    for (let i = 0; i < free.length - 1; i += 1) {
      tests += Math.max(1, crossers.length);
      if (tests > MAX_GRAPH_SEGMENT_TESTS) return null;
      const a = free[i];
      const b = free[i + 1];
      const pa = { x, y: ys[a] };
      const pb = { x, y: ys[b] };
      if (segmentBlocked(pa, pb, crossers)) continue;
      const dist = Math.abs(ys[b] - ys[a]);
      incident[xi][a].push({ xi, yi: b, dist });
      incident[xi][b].push({ xi, yi: a, dist });
    }
  }

  return incident;
}

function segmentsClear(points: Point[], obstacles: Rect[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (segmentBlocked(points[i - 1], points[i], obstacles)) return false;
  }
  return true;
}

function finalizePath(points: Point[], bodies: Rect[]): Point[] | null {
  const simplified = simplifyOrthogonal(points);
  if (simplified.length < 2) return null;
  if (!pathIsOrthogonal(simplified)) return null;
  if (!pathClearsBodies(simplified, bodies)) return null;
  return simplified;
}

function tryFastPath(
  startPort: Point,
  startLead: Point,
  endLead: Point,
  endPort: Point,
  bodies: Rect[],
  inflated: Rect[]
): Point[] | null {
  if (pointBlocked(startLead, inflated) || pointBlocked(endLead, inflated)) return null;
  if (segmentBlocked(startPort, startLead, bodies) || segmentBlocked(endLead, endPort, bodies)) {
    return null;
  }

  const mids: Point[][] = [];
  if (Math.abs(startLead.x - endLead.x) <= EPS || Math.abs(startLead.y - endLead.y) <= EPS) {
    mids.push([startLead, endLead]);
  }

  const elbowA = { x: startLead.x, y: endLead.y };
  const elbowB = { x: endLead.x, y: startLead.y };
  if (!samePoint(elbowA, startLead) && !samePoint(elbowA, endLead)) {
    mids.push([startLead, elbowA, endLead]);
  }
  if (
    !samePoint(elbowB, startLead) &&
    !samePoint(elbowB, endLead) &&
    !samePoint(elbowA, elbowB)
  ) {
    mids.push([startLead, elbowB, endLead]);
  }

  const mx = quantize((startLead.x + endLead.x) / 2);
  const my = quantize((startLead.y + endLead.y) / 2);
  mids.push(
    [startLead, { x: mx, y: startLead.y }, { x: mx, y: endLead.y }, endLead],
    [startLead, { x: startLead.x, y: my }, { x: endLead.x, y: my }, endLead]
  );

  for (const mid of mids) {
    if (!segmentsClear(mid, inflated)) continue;
    const path = finalizePath([startPort, ...mid, endPort], bodies);
    if (path) return path;
  }
  return null;
}

export function findOrthogonalPath(
  source: Rect,
  target: Rect,
  bodies: Rect[],
  sourceSide: Side,
  targetSide: Side,
  lane = 0
): Point[] | null {
  const startPort = portOnSide(source, sourceSide, lane);
  const endPort = portOnSide(target, targetSide, lane);
  const startLead = leadPoint(source, sourceSide, lane);
  const endLead = leadPoint(target, targetSide, lane);
  const inflatedAll = bodies.map((b) => inflate(b));

  if (segmentBlocked(startPort, startLead, bodies) || segmentBlocked(endLead, endPort, bodies)) {
    return null;
  }
  if (pointBlocked(startLead, inflatedAll) || pointBlocked(endLead, inflatedAll)) {
    return null;
  }

  const fast = tryFastPath(startPort, startLead, endLead, endPort, bodies, inflatedAll);
  if (fast) return fast;

  const searchBodies = selectSearchBodies(source, target, bodies);
  const inflated = searchBodies.map((b) => inflate(b));
  const budget = coordBudget(searchBodies.length);
  const keepX = [startLead.x, endLead.x, startPort.x, endPort.x];
  const keepY = [startLead.y, endLead.y, startPort.y, endPort.y];
  const box = bboxOf(searchBodies, SEARCH_MARGIN);
  const xsUse = thinCoords(
    uniqueSorted([
      box.minX,
      box.maxX,
      ...keepX,
      ...inflated.flatMap((r) => [r.x, r.x + r.width])
    ]),
    budget,
    keepX
  );
  const ysUse = thinCoords(
    uniqueSorted([
      box.minY,
      box.maxY,
      ...keepY,
      ...inflated.flatMap((r) => [r.y, r.y + r.height])
    ]),
    budget,
    keepY
  );
  if (xsUse.length === 0 || ysUse.length === 0) return null;

  const sx = indexOfCoord(xsUse, startLead.x);
  const sy = indexOfCoord(ysUse, startLead.y);
  const tx = indexOfCoord(xsUse, endLead.x);
  const ty = indexOfCoord(ysUse, endLead.y);
  if (sx < 0 || sy < 0 || tx < 0 || ty < 0) return null;

  const startDir = dirFromDelta(startLead.x - startPort.x, startLead.y - startPort.y);
  const incident = buildIncident(xsUse, ysUse, inflated);
  if (!incident) return null;
  const heap = new MinHeap();
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const encode = (xi: number, yi: number, dir: number) => (xi * 1024 + yi) * 8 + (dir + 1);

  const startKey = encode(sx, sy, startDir);
  gScore.set(startKey, 0);
  heap.push({
    key: Math.abs(xsUse[sx] - xsUse[tx]) + Math.abs(ysUse[sy] - ysUse[ty]),
    xi: sx,
    yi: sy,
    dir: startDir
  });

  let expansions = 0;
  let bestGoal: HeapItem | null = null;

  while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
    const cur = heap.pop()!;
    expansions += 1;
    const ck = encode(cur.xi, cur.yi, cur.dir);
    const cg = gScore.get(ck);
    if (cg === undefined) continue;

    if (cur.xi === tx && cur.yi === ty) {
      bestGoal = cur;
      break;
    }

    for (const n of incident[cur.xi][cur.yi]) {
      const ndx = xsUse[n.xi] - xsUse[cur.xi];
      const ndy = ysUse[n.yi] - ysUse[cur.yi];
      const ndir = dirFromDelta(ndx, ndy);
      const ng = cg + n.dist + (ndir === cur.dir ? 0 : BEND_COST);
      const nk = encode(n.xi, n.yi, ndir);
      const prev = gScore.get(nk);
      if (prev !== undefined && prev <= ng) continue;
      gScore.set(nk, ng);
      cameFrom.set(nk, ck);
      const h = Math.abs(xsUse[n.xi] - xsUse[tx]) + Math.abs(ysUse[n.yi] - ysUse[ty]);
      heap.push({ key: ng + h + ndir * 1e-6, xi: n.xi, yi: n.yi, dir: ndir });
    }
  }

  if (!bestGoal) return null;

  const decode = (key: number): HeapItem => {
    const dir = (key % 8) - 1;
    const rest = Math.floor(key / 8);
    const yi = rest % 1024;
    const xi = Math.floor(rest / 1024);
    return { key, xi, yi, dir };
  };

  const mid: Point[] = [];
  let walkKey: number | undefined = encode(bestGoal.xi, bestGoal.yi, bestGoal.dir);
  let guard = 0;
  while (walkKey !== undefined && guard < MAX_EXPANSIONS) {
    const node = decode(walkKey);
    mid.push({ x: xsUse[node.xi], y: ysUse[node.yi] });
    walkKey = cameFrom.get(walkKey);
    guard += 1;
  }
  mid.reverse();

  return finalizePath([startPort, startLead, ...mid, endLead, endPort], bodies);
}
