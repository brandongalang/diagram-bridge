import {
  CLEARANCE,
  EPS,
  LANE_SPACING,
  LEAD,
  type Point,
  type Rect,
  type Side
} from './types.js';

export function quantize(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function cloneRect(r: Rect): Rect {
  return { id: r.id, x: r.x, y: r.y, width: r.width, height: r.height };
}

export function rectValid(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > EPS &&
    r.height > EPS
  );
}

export function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function inflate(r: Rect, pad: number = CLEARANCE): Rect {
  return {
    id: r.id,
    x: r.x - pad,
    y: r.y - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2
  };
}

export function sameGeometry(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.width - b.width) < EPS &&
    Math.abs(a.height - b.height) < EPS
  );
}

export function isSelfLoop(source: Rect, target: Rect): boolean {
  return source.id === target.id;
}

export function bodiesOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x + EPS < b.x + b.width &&
    b.x + EPS < a.x + a.width &&
    a.y + EPS < b.y + b.height &&
    b.y + EPS < a.y + a.height
  );
}

export function outwardNormal(side: Side): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'right':
      return { x: 1, y: 0 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
  }
}

export function portOnSide(rect: Rect, side: Side, lane = 0): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const maxAlong =
    side === 'top' || side === 'bottom'
      ? Math.max(0, rect.width / 2 - 8)
      : Math.max(0, rect.height / 2 - 8);
  const shift = Math.max(-maxAlong, Math.min(maxAlong, lane * LANE_SPACING));
  switch (side) {
    case 'top':
      return { x: quantize(cx + shift), y: quantize(rect.y) };
    case 'bottom':
      return { x: quantize(cx + shift), y: quantize(rect.y + rect.height) };
    case 'left':
      return { x: quantize(rect.x), y: quantize(cy + shift) };
    case 'right':
      return { x: quantize(rect.x + rect.width), y: quantize(cy + shift) };
  }
}

export function leadPoint(rect: Rect, side: Side, lane = 0, lead = LEAD): Point {
  const port = portOnSide(rect, side, lane);
  const n = outwardNormal(side);
  return { x: quantize(port.x + n.x * lead), y: quantize(port.y + n.y * lead) };
}

export function pointInOpenRect(p: Point, r: Rect): boolean {
  return p.x > r.x + EPS && p.x < r.x + r.width - EPS && p.y > r.y + EPS && p.y < r.y + r.height - EPS;
}

export function closedRectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

/** True if an axis-aligned segment enters a rectangle's open interior. Endpoint contact on the border is allowed. */
export function segmentHitsOpenRect(a: Point, b: Point, r: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const rx1 = r.x;
  const rx2 = r.x + r.width;
  const ry1 = r.y;
  const ry2 = r.y + r.height;

  if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS) {
    return pointInOpenRect(a, r);
  }

  if (Math.abs(a.y - b.y) <= EPS) {
    const y = a.y;
    if (y <= ry1 + EPS || y >= ry2 - EPS) return false;
    return maxX > rx1 + EPS && minX < rx2 - EPS;
  }

  if (Math.abs(a.x - b.x) <= EPS) {
    const x = a.x;
    if (x <= rx1 + EPS || x >= rx2 - EPS) return false;
    return maxY > ry1 + EPS && minY < ry2 - EPS;
  }

  return true;
}

export function firstNonzeroDelta(points: Point[]): Point | null {
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) return { x: dx, y: dy };
  }
  return null;
}

export function lastNonzeroDelta(points: Point[]): Point | null {
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) return { x: dx, y: dy };
  }
  return null;
}

export function simplifyOrthogonal(points: Point[]): Point[] {
  if (points.length <= 2) return points.map((p) => ({ x: quantize(p.x), y: quantize(p.y) }));
  const out: Point[] = [{ x: quantize(points[0].x), y: quantize(points[0].y) }];
  for (let i = 1; i < points.length; i += 1) {
    const cur = { x: quantize(points[i].x), y: quantize(points[i].y) };
    const prev = out[out.length - 1];
    if (Math.abs(cur.x - prev.x) <= EPS && Math.abs(cur.y - prev.y) <= EPS) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const colinear =
        (Math.abs(a.x - prev.x) <= EPS && Math.abs(prev.x - cur.x) <= EPS) ||
        (Math.abs(a.y - prev.y) <= EPS && Math.abs(prev.y - cur.y) <= EPS);
      if (colinear) {
        const abx = prev.x - a.x;
        const aby = prev.y - a.y;
        const bcx = cur.x - prev.x;
        const bcy = cur.y - prev.y;
        const reversal = abx * bcx + aby * bcy < -EPS;
        if (!reversal) {
          out[out.length - 1] = cur;
          continue;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

export function preferredSourceSide(source: Rect, target: Rect): Side {
  const s = centerOf(source);
  const t = centerOf(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function preferredTargetSide(source: Rect, target: Rect): Side {
  const s = centerOf(source);
  const t = centerOf(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
  return dy >= 0 ? 'top' : 'bottom';
}

export function uniqueRects(rects: Rect[]): Rect[] {
  const seen = new Set<string>();
  const out: Rect[] = [];
  for (const r of rects) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(cloneRect(r));
  }
  return out;
}

export function bboxOf(rects: Rect[], extra = 0): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return {
    minX: minX - extra,
    minY: minY - extra,
    maxX: maxX + extra,
    maxY: maxY + extra
  };
}

export function dirFromDelta(dx: number, dy: number): number {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

export function dirDelta(dir: number): Point {
  switch (dir) {
    case 0:
      return { x: 1, y: 0 };
    case 1:
      return { x: 0, y: 1 };
    case 2:
      return { x: -1, y: 0 };
    default:
      return { x: 0, y: -1 };
  }
}

export function pathIsOrthogonal(points: Point[]): boolean {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    if (Math.abs(dx) > EPS && Math.abs(dy) > EPS) return false;
  }
  return true;
}

export function pathClearsBodies(points: Point[], bodies: Rect[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    for (const body of bodies) {
      if (segmentHitsOpenRect(points[i - 1], points[i], body)) return false;
    }
  }
  return true;
}

export function polylineToSvgPath(points: Point[]): string {
  if (points.length === 0) return '';
  const head = `M ${points[0].x} ${points[0].y}`;
  const tail = points
    .slice(1)
    .map((p) => `L ${p.x} ${p.y}`)
    .join(' ');
  return tail ? `${head} ${tail}` : head;
}
