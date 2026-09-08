import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database, MessageSquare } from 'lucide-react';

export const DatastoreNode = React.memo(({ data, selected }: NodeProps) => {
  const isExport = Boolean(data.isExport);
  const noteCount = (data.noteCount as number) || 0;
  const label = (data.label as string) || '';

  const handleStyle = isExport ? { opacity: 0, pointerEvents: 'none' as const } : undefined;

  return (
    <div
      data-testid={`node-${data.id}`}
      className={`drafting-node datastore-node ${selected ? 'selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        fontFamily: "'Manrope Variable', sans-serif"
      }}
    >
      {/* Functional Flowchart / Architecture Database Cylinder Geometry */}
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
        {/* Cylinder Body */}
        <path
          d="M 0,14 L 0,86 A 50,14 0 0,0 100,86 L 100,14"
          fill="#f5f3ff"
          stroke={selected ? '#0f766e' : '#6366f1'}
          strokeWidth={selected ? 2.5 : 1.5}
          vectorEffect="non-scaling-stroke"
        />
        {/* Cylinder Top Ellipse */}
        <ellipse
          cx="50"
          cy="14"
          rx="50"
          ry="14"
          fill="#e0e7ff"
          stroke={selected ? '#0f766e' : '#6366f1'}
          strokeWidth={selected ? 2.5 : 1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Handles at 4 sides */}
      <Handle id="top" type="source" position={Position.Top} className="custom-handle" style={handleStyle} />
      <Handle id="left" type="source" position={Position.Left} className="custom-handle" style={handleStyle} />
      <Handle id="right" type="source" position={Position.Right} className="custom-handle" style={handleStyle} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="custom-handle" style={handleStyle} />

      {/* Centered content inside cylinder */}
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
          padding: '24px 16px 10px 16px',
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
          <Database size={12} color="#4338ca" />
          <span
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#4338ca',
              fontWeight: 700
            }}
          >
            Datastore
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

DatastoreNode.displayName = 'DatastoreNode';
