import React from 'react';
import {
  Workflow,
  GitFork,
  Database,
  Type,
  Layers,
  Maximize,
  Undo2,
  Redo2,
  History,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react';
import type { NodeKind } from '../types.js';

interface ToolRailProps {
  onAddNode: (kind: NodeKind) => void;
  onFitView: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isHistoryOpen: boolean;
  onToggleHistory: () => void;
  isInspectorOpen: boolean;
  onToggleInspector: () => void;
  disabled?: boolean;
}

export const ToolRail: React.FC<ToolRailProps> = ({
  onAddNode,
  onFitView,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isHistoryOpen,
  onToggleHistory,
  isInspectorOpen,
  onToggleInspector,
  disabled = false
}) => {
  return (
    <aside className="tool-rail" aria-label="Tool palette">
      <button
        type="button"
        className="tool-rail-btn"
        onClick={() => onAddNode('step')}
        disabled={disabled}
        title="Add Step node"
        aria-label="Add Step node"
      >
        <Workflow size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={() => onAddNode('decision')}
        disabled={disabled}
        title="Add Decision node"
        aria-label="Add Decision node"
      >
        <GitFork size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={() => onAddNode('datastore')}
        disabled={disabled}
        title="Add Datastore node"
        aria-label="Add Datastore node"
      >
        <Database size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={() => onAddNode('text')}
        disabled={disabled}
        title="Add Text note"
        aria-label="Add Text note"
      >
        <Type size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={() => onAddNode('group')}
        disabled={disabled}
        title="Add Group container"
        aria-label="Add Group container"
      >
        <Layers size={17} />
      </button>

      <div className="tool-rail-separator" role="separator" />

      <button
        type="button"
        className="tool-rail-btn"
        onClick={onUndo}
        disabled={disabled || !canUndo}
        title="Undo (Ctrl/Cmd+Z)"
        aria-label="Undo"
      >
        <Undo2 size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={onRedo}
        disabled={disabled || !canRedo}
        title="Redo (Ctrl/Cmd+Shift+Z)"
        aria-label="Redo"
      >
        <Redo2 size={17} />
      </button>
      <button
        type="button"
        className="tool-rail-btn"
        onClick={onFitView}
        title="Fit diagram to screen"
        aria-label="Fit diagram"
      >
        <Maximize size={17} />
      </button>

      <div className="tool-rail-separator" role="separator" />

      <button
        type="button"
        className={`tool-rail-btn ${isHistoryOpen ? 'active' : ''}`}
        onClick={onToggleHistory}
        title="Toggle revision history"
        aria-label="Toggle history"
      >
        <History size={17} />
      </button>
      <button
        type="button"
        className={`tool-rail-btn ${isInspectorOpen ? 'active' : ''}`}
        onClick={onToggleInspector}
        title={isInspectorOpen ? 'Collapse inspector' : 'Open inspector'}
        aria-label={isInspectorOpen ? 'Collapse inspector' : 'Open inspector'}
      >
        {isInspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
      </button>
    </aside>
  );
};
