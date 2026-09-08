export type Side = 'top' | 'right' | 'bottom' | 'left';

export type Point = {
  x: number;
  y: number;
};

export type Rect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LabelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RouteRequest = {
  source: Rect;
  target: Rect;
  obstacles: Rect[];
  label?: string;
  sourceSide?: Side;
  targetSide?: Side;
  /** Lateral port offset in lane units. Used by batch routing only. */
  lane?: number;
};

export type RouteResult = {
  points: Point[];
  sourceSide: Side;
  targetSide: Side;
  label: LabelBox | null;
  unroutable: boolean;
};

export const SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];

export const CLEARANCE = 14;
export const LEAD = 20;
export const MAX_LABEL_WIDTH = 200;
export const LABEL_PAD_X = 16;
export const LABEL_LINE_HEIGHT = 18;
export const CHAR_WIDTH = 7;
export const BEND_COST = 36;
export const SEARCH_MARGIN = 72;
export const MAX_EXPANSIONS = 18_000;
export const MAX_UNIQUE_COORDS = 220;
export const MAX_BODIES_IN_SEARCH = 64;
export const MAX_GRAPH_SEGMENT_TESTS = 80_000;
export const MAX_ABS_COORD = 1_000_000;
export const LANE_SPACING = 10;
export const EPS = 1e-4;
