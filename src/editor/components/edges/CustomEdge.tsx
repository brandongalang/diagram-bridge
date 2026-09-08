import React, { useId } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import type { routeEdge } from '../../routing/index.js';

type EdgeData = {
  route: ReturnType<typeof routeEdge>;
  isExport?: boolean;
  onSelectEdge?: (id: string) => void;
};

export const CustomEdge = React.memo(({ id, label, selected, data, sourceX, sourceY, targetX, targetY }: EdgeProps) => {
  const markerId = `arrow-${useId().replace(/:/g, '')}`;
  const edge = data as EdgeData | undefined;
  const route = edge?.route;
  const color = selected ? '#0f766e' : '#475569';
  const select = () => edge?.onSelectEdge?.(id);
  if (!route || route.unroutable) {
    return <g data-route-blocked="true" onClick={select}>
      <title>No clear route. Move overlapping nodes apart.</title>
      {[[sourceX, sourceY], [targetX, targetY]].map(([x, y], i) =>
        <circle key={i} cx={x} cy={y} r={5} fill="#fffbeb" stroke="#b45309" strokeWidth={2} />)}
    </g>;
  }
  const path = route.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  return <>
    <defs>
      <marker id={markerId} viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
        <path d="M 0 -4 L 10 0 L 0 4 Z" fill={color} />
      </marker>
    </defs>
    <BaseEdge id={id} path={path} markerEnd={`url(#${markerId})`} interactionWidth={24}
      style={{ stroke: color, strokeWidth: selected ? 2.5 : 1.75, strokeLinejoin: 'round' }} />
    {label && route.label && <EdgeLabelRenderer>
      <button type="button" className="edge-label nodrag nopan" data-testid={`edge-label-${id}`}
        tabIndex={edge?.isExport ? -1 : 0} onClick={select}
        title={typeof label === 'string' ? label : undefined}
        style={{ left: route.label.x, top: route.label.y, width: route.label.width, height: route.label.height,
          color: selected ? '#0f766e' : undefined, borderColor: selected ? '#0f766e' : undefined }}>
        {label}
      </button>
    </EdgeLabelRenderer>}
  </>;
});
CustomEdge.displayName = 'CustomEdge';
