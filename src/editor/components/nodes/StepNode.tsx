import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Workflow, MessageSquare } from 'lucide-react';

export const StepNode = React.memo(({ data, selected }: NodeProps) => {
  const isExport = Boolean(data.isExport);
  const noteCount = (data.noteCount as number) || 0;
  const label = (data.label as string) || '';

  const handleStyle = isExport ? { opacity: 0, pointerEvents: 'none' as const } : undefined;

  return (
    <div
      data-testid={`node-${data.id}`}
      className={`drafting-node step-node ${selected ? 'selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '10px 14px',
        background: '#ffffff',
        border: `1.5px solid ${selected ? '#0f766e' : '#94a3b8'}`,
        borderRadius: '8px',
        boxShadow: selected
          ? '0 0 0 2px rgba(15,118,110,0.25), 0 4px 12px rgba(15,23,42,0.08)'
          : '0 2px 6px rgba(15,23,42,0.05)',
        color: '#0f172a',
        fontFamily: "'Manrope Variable', sans-serif",
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease'
      }}
    >
      {/* Handles are always mounted for geometry; visually hidden in export mode */}
      <Handle id="top" type="source" position={Position.Top} className="custom-handle" style={handleStyle} />
      <Handle id="left" type="source" position={Position.Left} className="custom-handle" style={handleStyle} />
      <Handle id="right" type="source" position={Position.Right} className="custom-handle" style={handleStyle} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="custom-handle" style={handleStyle} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '4px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <Workflow size={13} color="#64748b" />
          <span
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#64748b',
              fontWeight: 700
            }}
          >
            Step
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

      <div
        className="drafting-node-label"
        title={label}
        style={{
          fontSize: '14px',
          fontWeight: 600,
          lineHeight: 1.35,
          color: '#0f172a'
        }}
      >
        {label}
      </div>
    </div>
  );
});

StepNode.displayName = 'StepNode';
