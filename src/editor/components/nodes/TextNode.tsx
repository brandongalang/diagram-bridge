import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { MessageSquare } from 'lucide-react';

export const TextNode = React.memo(({ data, selected }: NodeProps) => {
  const noteCount = (data.noteCount as number) || 0;
  const label = (data.label as string) || '';

  return (
    <div
      data-testid={`node-${data.id}`}
      className={`drafting-node text-node ${selected ? 'selected' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '10px 14px',
        background: '#f8fafc',
        border: `1.5px dashed ${selected ? '#0f766e' : '#cbd5e1'}`,
        borderRadius: '6px',
        color: '#475569',
        fontFamily: "'Manrope Variable', sans-serif",
        fontSize: '13px',
        fontStyle: 'italic',
        lineHeight: 1.4,
        wordBreak: 'break-word',
        boxShadow: selected ? '0 0 0 2px rgba(15,118,110,0.2)' : 'none',
        transition: 'border-color 0.15s ease',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      {noteCount > 0 && (
        <div
          className="drafting-note-badge"
          title={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
          aria-label={`${noteCount} note${noteCount > 1 ? 's' : ''}`}
          style={{
            position: 'absolute',
            top: '4px',
            right: '6px'
          }}
        >
          <MessageSquare size={10} />
          <span>{noteCount}</span>
        </div>
      )}
      <div
        className="drafting-node-label"
        title={label}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {label}
      </div>
    </div>
  );
});

TextNode.displayName = 'TextNode';
