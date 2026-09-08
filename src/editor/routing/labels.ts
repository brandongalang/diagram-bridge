import { closedRectsOverlap } from './geometry.js';
import {
  CHAR_WIDTH,
  EPS,
  LABEL_LINE_HEIGHT,
  LABEL_PAD_X,
  MAX_LABEL_WIDTH,
  type LabelBox,
  type Point,
  type Rect
} from './types.js';

export function estimateLabelBox(label: string): { width: number; height: number } {
  const trimmed = label.trim();
  const raw = trimmed.length * CHAR_WIDTH + LABEL_PAD_X;
  const width = Math.max(24, Math.min(MAX_LABEL_WIDTH, raw));
  const height = raw > MAX_LABEL_WIDTH ? LABEL_LINE_HEIGHT * 2 + 8 : LABEL_LINE_HEIGHT + 8;
  return { width, height };
}

function segmentLength(a: Point, b: Point): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
}

function overlapsAny(box: LabelBox, bodies: Rect[]): boolean {
  const asRect: Rect = { id: 'label', ...box };
  return bodies.some((b) => closedRectsOverlap(asRect, b, 2));
}

function candidatesForSegment(
  a: Point,
  b: Point,
  size: { width: number; height: number }
): LabelBox[] {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const horizontal = Math.abs(a.y - b.y) <= EPS;
  const boxes: LabelBox[] = [];
  const { width, height } = size;
  if (horizontal) {
    boxes.push(
      { x: mid.x - width / 2, y: mid.y - height - 8, width, height },
      { x: mid.x - width / 2, y: mid.y + 8, width, height },
      { x: mid.x - width / 2, y: mid.y - height / 2, width, height }
    );
  } else {
    boxes.push(
      { x: mid.x + 8, y: mid.y - height / 2, width, height },
      { x: mid.x - width - 8, y: mid.y - height / 2, width, height },
      { x: mid.x - width / 2, y: mid.y - height / 2, width, height }
    );
  }
  return boxes;
}

export function placeLabel(points: Point[], bodies: Rect[], label?: string): LabelBox | null {
  if (!label || label.trim().length === 0 || points.length < 2) return null;
  const size = estimateLabelBox(label);
  const segments: { a: Point; b: Point; len: number; i: number }[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const len = segmentLength(a, b);
    if (len > EPS) segments.push({ a, b, len, i });
  }
  segments.sort((x, y) => y.len - x.len || x.i - y.i);

  for (const seg of segments) {
    const horizontal = Math.abs(seg.a.y - seg.b.y) <= EPS;
    const narrowWidth = Math.floor(seg.len - 8);
    const sizes = horizontal && narrowWidth >= 40 && narrowWidth < size.width
      ? [size, { width: narrowWidth, height: LABEL_LINE_HEIGHT * 2 + 8 }]
      : [size];
    const nearbyBodies = horizontal ? bodies.filter(body =>
      body.y <= seg.a.y && body.y + body.height >= seg.a.y &&
      body.x < (seg.a.x + seg.b.x) / 2 + size.width / 2 &&
      body.x + body.width > (seg.a.x + seg.b.x) / 2 - size.width / 2
    ) : [];
    const outside: LabelBox[] = nearbyBodies.length ? [
      { x: (seg.a.x + seg.b.x) / 2 - size.width / 2,
        y: Math.min(...nearbyBodies.map(body => body.y)) - size.height - 8, ...size },
      { x: (seg.a.x + seg.b.x) / 2 - size.width / 2,
        y: Math.max(...nearbyBodies.map(body => body.y + body.height)) + 8, ...size }
    ] : [];
    const candidates = [
      ...candidatesForSegment(seg.a, seg.b, size), ...outside,
      ...sizes.slice(1).flatMap(candidate => candidatesForSegment(seg.a, seg.b, candidate))
    ];
    for (const box of candidates) {
      if (!overlapsAny(box, bodies)) {
        return {
          x: Math.round(box.x * 1000) / 1000,
          y: Math.round(box.y * 1000) / 1000,
          width: box.width,
          height: box.height
        };
      }
    }
  }
  return null;
}
