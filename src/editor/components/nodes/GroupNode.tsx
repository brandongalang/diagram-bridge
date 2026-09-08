import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { Layers, MessageSquare } from 'lucide-react';

export const GroupNode = React.memo(({ data, selected }: NodeProps) => {
  const noteCount = (data.noteCount as number) || 0;
  const label = (data.label as string) || '';

  return (
    <div
      data-testid={`node-${data.id}`}
      className={`drafting-node group-node ${selected ? 'selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: 'rgba(241, 245, 249, 0.45)',
        border: `1.5px dashed ${selected ? '#0f766e' : '#94a3b8'}`,
        borderRadius: '10px',
        padding: '10px 14px',
        fontFamily: "'Manrope Variable', sans-serif",
        position: 'relative',
        pointerEvents: 'all',
        boxShadow: selected ? '0 0 0 2px rgba(15,118,110,0.2)' : 'none',
        transition: 'border-color 0.15s ease'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Layers size={13} color="#64748b" />
          <span
            className="drafting-node-label"
            title={label}
            style={{
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#475569'
            }}
          >
            {label}
          </span>
        </div>
        {noteCount > 0 && (
          <div
            className="drafting-note-badge"
            title={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
            aria-label={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
          >
            <MessageSquare size={10} />
            <span>{noteCount}</span>
          </div>
        )}
      </div>
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
