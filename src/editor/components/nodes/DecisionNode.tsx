import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitFork, MessageSquare } from 'lucide-react';

export const DecisionNode = React.memo(({ data, selected }: NodeProps) => {
  const isExport = Boolean(data.isExport);
  const noteCount = (data.noteCount as number) || 0;
  const label = (data.label as string) || '';

  const handleStyle = isExport ? { opacity: 0, pointerEvents: 'none' as const } : undefined;

  return (
    <div
      data-testid={`node-${data.id}`}
      className={`drafting-node decision-node ${selected ? 'selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        fontFamily: "'Manrope Variable', sans-serif"
      }}
    >
      {/* Functional Flowchart Diamond Geometry */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'visible'
        }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <polygon
          points="50,0 100,50 50,100 0,50"
          fill="#f0fdfa"
          stroke={selected ? '#0f766e' : '#0d9488'}
          strokeWidth={selected ? 2.5 : 1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Handles are positioned at the 4 diamond vertices */}
      <Handle id="top" type="source" position={Position.Top} className="custom-handle" style={handleStyle} />
      <Handle id="left" type="source" position={Position.Left} className="custom-handle" style={handleStyle} />
      <Handle id="right" type="source" position={Position.Right} className="custom-handle" style={handleStyle} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="custom-handle" style={handleStyle} />

      {/* Centered content inside the diamond */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px 24px',
          boxSizing: 'border-box'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginBottom: '3px'
          }}
        >
          <GitFork size={12} color="#0f766e" />
          <span
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#0f766e',
              fontWeight: 700
            }}
          >
            Decision
          </span>
          {noteCount > 0 && (
            <div
              className="drafting-note-badge"
              title={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
              aria-label={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
              style={{ marginLeft: '4px' }}
            >
              <MessageSquare size={9} />
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
            lineHeight: 1.3,
            color: '#0f172a',
            textAlign: 'center'
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
});

DecisionNode.displayName = 'DecisionNode';
