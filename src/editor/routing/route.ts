import {
  bodiesOverlap,
  firstNonzeroDelta,
  isSelfLoop,
  lastNonzeroDelta,
  outwardNormal,
  pathClearsBodies,
  pathIsOrthogonal,
  preferredSourceSide,
  preferredTargetSide,
  rectValid,
  uniqueRects
} from './geometry.js';
import { placeLabel } from './labels.js';
import { findOrthogonalPath } from './pathfind.js';
import {
  EPS,
  MAX_ABS_COORD,
  SIDES,
  type Point,
  type Rect,
  type RouteRequest,
  type RouteResult,
  type Side
} from './types.js';

function finiteRect(r: Rect): boolean {
  if (!rectValid(r)) return false;
  return (
    Math.abs(r.x) <= MAX_ABS_COORD &&
    Math.abs(r.y) <= MAX_ABS_COORD &&
    Math.abs(r.x + r.width) <= MAX_ABS_COORD &&
    Math.abs(r.y + r.height) <= MAX_ABS_COORD
  );
}

function fail(sourceSide: Side, targetSide: Side): RouteResult {
  return {
    points: [],
    sourceSide,
    targetSide,
    label: null,
    unroutable: true
  };
}

function directionOk(delta: Point, expected: Point): boolean {
  const mag = Math.abs(delta.x) + Math.abs(delta.y);
  if (mag <= EPS) return false;
  const nx = delta.x / mag;
  const ny = delta.y / mag;
  return nx * expected.x + ny * expected.y > 0.5;
}

function pathRespectsPorts(points: Point[], sourceSide: Side, targetSide: Side): boolean {
  const first = firstNonzeroDelta(points);
  const last = lastNonzeroDelta(points);
  if (!first || !last) return false;
  const out = outwardNormal(sourceSide);
  const inward = outwardNormal(targetSide);
  return directionOk(first, out) && directionOk(last, { x: -inward.x, y: -inward.y });
}

function candidatePairs(
  source: Rect,
  target: Rect,
  sourceSide?: Side,
  targetSide?: Side
): [Side, Side][] {
  const self = isSelfLoop(source, target);
  const sourceOrder: Side[] = sourceSide
    ? [sourceSide]
    : self
      ? ['right', 'bottom', 'left', 'top']
      : [preferredSourceSide(source, target), ...SIDES];
  const targetOrder: Side[] = targetSide
    ? [targetSide]
    : self
      ? ['top', 'left', 'bottom', 'right']
      : [preferredTargetSide(source, target), ...SIDES];

  const seen = new Set<string>();
  const pairs: [Side, Side][] = [];
  for (const s of sourceOrder) {
    for (const t of targetOrder) {
      if (self && s === t) continue;
      const key = `${s}:${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([s, t]);
    }
  }
  return pairs;
}

function frozenRequest(input: RouteRequest): RouteRequest {
  return {
    source: { ...input.source },
    target: { ...input.target },
    obstacles: input.obstacles.map((o) => ({ ...o })),
    label: input.label,
    sourceSide: input.sourceSide,
    targetSide: input.targetSide,
    lane: input.lane
  };
}

export function routeEdge(input: RouteRequest): RouteResult {
  const req = frozenRequest(input);
  const fallbackS = req.sourceSide ?? preferredSourceSide(req.source, req.target);
  const fallbackT = req.targetSide ?? preferredTargetSide(req.source, req.target);

  if (!finiteRect(req.source) || !finiteRect(req.target)) {
    return fail(fallbackS, fallbackT);
  }
  for (const o of req.obstacles) {
    if (!finiteRect(o)) return fail(fallbackS, fallbackT);
  }

  const self = isSelfLoop(req.source, req.target);
  if (!self && bodiesOverlap(req.source, req.target)) {
    return fail(fallbackS, fallbackT);
  }

  const obstacleBodies = uniqueRects(
    req.obstacles.filter((o) => o.id !== req.source.id && o.id !== req.target.id)
  );
  const bodies = uniqueRects([req.source, ...(self ? [] : [req.target]), ...obstacleBodies]);

  const pairs = candidatePairs(req.source, req.target, req.sourceSide, req.targetSide);
  const lane = req.lane ?? 0;

  for (const [sourceSide, targetSide] of pairs) {
    const points = findOrthogonalPath(req.source, req.target, bodies, sourceSide, targetSide, lane);
    if (!points || points.length < 2) continue;
    if (!pathIsOrthogonal(points)) continue;
    if (!pathClearsBodies(points, bodies)) continue;
    if (!pathRespectsPorts(points, sourceSide, targetSide)) continue;
    const label = placeLabel(points, bodies, req.label);
    return {
      points,
      sourceSide,
      targetSide,
      label,
      unroutable: false
    };
  }

  return fail(fallbackS, fallbackT);
}

export function routeEdges(requests: RouteRequest[]): RouteResult[] {
  const lanes = new Map<string, number>();
  return requests.map((req) => {
    const sourceKey = `${req.source.id}:${req.sourceSide ?? preferredSourceSide(req.source, req.target)}`;
    const next = lanes.get(sourceKey) ?? 0;
    lanes.set(sourceKey, next + 1);
    const offset = next === 0 ? 0 : Math.ceil(next / 2) * (next % 2 === 0 ? 1 : -1);
    return routeEdge({ ...req, lane: req.lane ?? offset });
  });
}
