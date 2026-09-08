import React, { useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  FileText,
  Workflow,
  GitFork,
  Database,
  Type,
  Layers,
  ArrowRight,
  ArrowLeftRight,
  Trash2,
  Plus,
  MessageSquare,
  AlertTriangle,
  RotateCw,
  Link2
} from 'lucide-react';
import type {
  DiagramDocument,
  DiagramNode,
  DiagramEdge,
  DiagramNote,
  SelectedElement,
  Anchor
} from '../types.js';

interface InspectorProps {
  isOpen: boolean;
  onToggle: () => void;
  selectedElement: SelectedElement;
  document: DiagramDocument;
  author: string;
  onUpdateNode: (id: string, patch: { label?: string; parentId?: string | null }) => void;
  onRemoveNode: (id: string, cascade: boolean) => void;
  onUpdateEdge: (id: string, patch: { label?: string | null; source?: string; target?: string }) => void;
  onRemoveEdge: (id: string) => void;
  onAddEdge: (source: string, target: string, label?: string) => void;
  onAddNote: (note: { body: string; author: string; anchor: Anchor }) => string | undefined;
  onUpdateNote: (id: string, patch: { body?: string; author?: string; anchor?: Anchor }) => void;
  onRemoveNote: (id: string) => void;
  onDeselect: () => void;
}

export const Inspector: React.FC<InspectorProps> = ({
  isOpen,
  onToggle,
  selectedElement,
  document: doc,
  author,
  onUpdateNode,
  onRemoveNode,
  onUpdateEdge,
  onRemoveEdge,
  onAddEdge,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
  onDeselect
}) => {
  const [composingNoteId, setComposingNoteId] = useState<string | null>(null);
  const [newNoteAuthor, setNewNoteAuthor] = useState(author);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [originalNoteBody, setOriginalNoteBody] = useState('');

  // Node connection helpers
  const [targetNodeId, setTargetNodeId] = useState<string>('');
  const [newEdgeLabel, setNewEdgeLabel] = useState<string>('');
  const [cascadeDelete, setCascadeDelete] = useState<boolean>(true);

  useEffect(() => {
    setComposingNoteId(null);
    setEditingNoteId(null);
  }, [doc.documentId, selectedElement?.type, selectedElement?.id]);

  const composingNote = doc.notes.find(note => note.id === composingNoteId);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="tool-rail-btn inspector-reopen"
        onClick={onToggle}
        title="Open Inspector"
        aria-label="Open Inspector"
      >
        <ChevronLeft size={16} />
      </button>
    );
  }

  // Find selected node or edge
  const selectedNode =
    selectedElement?.type === 'node'
      ? doc.nodes.find((n) => n.id === selectedElement.id)
      : null;

  const selectedEdge =
    selectedElement?.type === 'edge'
      ? doc.edges.find((e) => e.id === selectedElement.id)
      : null;

  // Filter notes relevant to current selection
  const relevantNotes = doc.notes.filter((nt) => {
    if (selectedNode) {
      return nt.anchor.type === 'node' && nt.anchor.id === selectedNode.id;
    }
    if (selectedEdge) {
      return nt.anchor.type === 'edge' && nt.anchor.id === selectedEdge.id;
    }
    return nt.anchor.type === 'diagram';
  });

  const detachedNotes = doc.notes.filter((nt) => nt.anchor.type === 'detached');

  const availableGroups = doc.nodes.filter(
    (n) => n.kind === 'group' && (!selectedNode || n.id !== selectedNode.id)
  );

  const connectableNodes = doc.nodes.filter(
    (n) => n.kind !== 'group' && n.kind !== 'text'
  );

  const composeNote = (body: string) => {
    if (composingNote) {
      if (body.length === 0) {
        onRemoveNote(composingNote.id);
        setComposingNoteId(null);
      } else onUpdateNote(composingNote.id, { body });
      return;
    }
    if (!body.trim()) return;
    const anchor: Anchor = selectedNode ? { type: 'node', id: selectedNode.id }
      : selectedEdge ? { type: 'edge', id: selectedEdge.id } : { type: 'diagram' };
    const id = onAddNote({ body, author: newNoteAuthor.trim() || author || 'human', anchor });
    if (id) setComposingNoteId(id);
  };

  const handleCreateNote = (event: React.FormEvent) => {
    event.preventDefault();
    setComposingNoteId(null);
  };

  const handleConnectNode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !targetNodeId) return;
    onAddEdge(selectedNode.id, targetNodeId, newEdgeLabel.trim() || undefined);
    setTargetNodeId('');
    setNewEdgeLabel('');
  };

  const getNodeIcon = (kind: string) => {
    switch (kind) {
      case 'step':
        return <Workflow size={14} color="#0f766e" />;
      case 'decision':
        return <GitFork size={14} color="#0d9488" />;
      case 'datastore':
        return <Database size={14} color="#4338ca" />;
      case 'text':
        return <Type size={14} color="#475569" />;
      case 'group':
        return <Layers size={14} color="#64748b" />;
      default:
        return <FileText size={14} />;
    }
  };

  return (
    <aside className="inspector-panel" aria-label="Properties and notes inspector">
      <div className="inspector-header">
        <div className="inspector-title">
          {selectedNode && (
            <>
              {getNodeIcon(selectedNode.kind)}
              <span>{selectedNode.kind} Node</span>
            </>
          )}
          {selectedEdge && (
            <>
              <ArrowRight size={14} color="#0f766e" />
              <span>Edge</span>
            </>
          )}
          {!selectedNode && !selectedEdge && (
            <>
              <FileText size={14} color="#0f766e" />
              <span>Diagram Notes</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {(selectedNode || selectedEdge) && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onDeselect}
              title="Deselect element to view diagram notes"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="tool-rail-btn"
            onClick={onToggle}
            title="Collapse inspector"
            aria-label="Collapse inspector"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-content">
        {/* Node Properties */}
        {selectedNode && (
          <div className="inspector-section">
            <label htmlFor="node-label" className="inspector-label">
              Label
            </label>
            <textarea
              id="node-label"
              maxLength={2000}
              className="inspector-textarea"
              value={selectedNode.label}
              onChange={(e) => onUpdateNode(selectedNode.id, { label: e.target.value })}
              placeholder="Enter node label..."
              rows={3}
            />

            {selectedNode.kind !== 'group' && (
              <>
                <label htmlFor="node-group" className="inspector-label" style={{ marginTop: '8px' }}>
                  Parent Group
                </label>
                <select
                  id="node-group"
                  className="inspector-select"
                  value={selectedNode.parentId || ''}
                  onChange={(e) =>
                    onUpdateNode(selectedNode.id, {
                      parentId: e.target.value ? e.target.value : null
                    })
                  }
                >
                  <option value="">(None - Root level)</option>
                  {availableGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label} ({g.id})
                    </option>
                  ))}
                </select>
              </>
            )}

            {/* Keyboard Connection tool */}
            {selectedNode.kind !== 'group' && selectedNode.kind !== 'text' && (
              <form onSubmit={handleConnectNode} style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Link2 size={12} color="#64748b" />
                  <span className="inspector-label">Connect To Node</span>
                </div>
                <select
                  className="inspector-select"
                  aria-label="Connect to node"
                  value={targetNodeId}
                  onChange={(e) => setTargetNodeId(e.target.value)}
                >
                  <option value="">Select target node...</option>
                  {connectableNodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label} ({n.kind})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="inspector-input"
                  placeholder="Optional edge label..."
                  aria-label="New connection label"
                  maxLength={2000}
                  value={newEdgeLabel}
                  onChange={(e) => setNewEdgeLabel(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  disabled={!targetNodeId}
                >
                  <Plus size={12} />
                  Connect
                </button>
              </form>
            )}

            <div style={{ marginTop: '14px', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <input
                  type="checkbox"
                  id="cascade-delete"
                  checked={cascadeDelete}
                  onChange={(e) => setCascadeDelete(e.target.checked)}
                />
                <label htmlFor="cascade-delete" className="field-hint">
                  Cascade delete connected edges
                </label>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                style={{ width: '100%' }}
                onClick={() => onRemoveNode(selectedNode.id, cascadeDelete)}
              >
                <Trash2 size={12} />
                Delete Node
              </button>
            </div>
          </div>
        )}

        {/* Edge Properties */}
        {selectedEdge && (
          <div className="inspector-section">
            <label htmlFor="edge-label" className="inspector-label">
              Edge Label
            </label>
            <input
              id="edge-label"
              maxLength={2000}
              type="text"
              className="inspector-input"
              value={selectedEdge.label || ''}
              onChange={(e) =>
                onUpdateEdge(selectedEdge.id, {
                  label: e.target.value.trim() ? e.target.value : null
                })
              }
              placeholder="e.g. success, fallback, retry"
            />

            <label htmlFor="edge-source" className="inspector-label" style={{ marginTop: '8px' }}>
              Source Node
            </label>
            <select
              id="edge-source"
              className="inspector-select"
              value={selectedEdge.source}
              onChange={(e) => onUpdateEdge(selectedEdge.id, { source: e.target.value })}
            >
              {connectableNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.id})
                </option>
              ))}
            </select>

            <label htmlFor="edge-target" className="inspector-label" style={{ marginTop: '8px' }}>
              Target Node
            </label>
            <select
              id="edge-target"
              className="inspector-select"
              value={selectedEdge.target}
              onChange={(e) => onUpdateEdge(selectedEdge.id, { target: e.target.value })}
            >
              {connectableNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.id})
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: '8px' }}
              onClick={() =>
                onUpdateEdge(selectedEdge.id, {
                  source: selectedEdge.target,
                  target: selectedEdge.source
                })
              }
              title="Reverse edge direction"
            >
              <ArrowLeftRight size={12} />
              Swap Direction
            </button>

            <div style={{ marginTop: '14px', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                style={{ width: '100%' }}
                onClick={() => onRemoveEdge(selectedEdge.id)}
              >
                <Trash2 size={12} />
                Delete Edge
              </button>
            </div>
          </div>
        )}

        {/* Notes Section */}
        <div className="inspector-section" style={{ borderTop: '1px solid #e2e8f0', paddingTop: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="inspector-label">
              {selectedNode
                ? `Notes on this Node (${relevantNotes.length})`
                : selectedEdge
                ? `Notes on this Edge (${relevantNotes.length})`
                : `Diagram Notes (${relevantNotes.length})`}
            </span>
          </div>

          {/* Add Note Form */}
          <form onSubmit={handleCreateNote} style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
            <textarea
              className="inspector-textarea"
              value={composingNote?.body || ''}
              onChange={(e) => composeNote(e.target.value)}
              placeholder="Add an explanatory note, checkpoint question, or intent..."
              aria-label="New note"
              dir="auto"
              maxLength={20000}
              rows={2}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                className="inspector-input"
                style={{ flex: 1, minWidth: 0 }}
                value={newNoteAuthor}
                onChange={(e) => {
                  setNewNoteAuthor(e.target.value);
                  if (composingNote) onUpdateNote(composingNote.id, { author: e.target.value.trim() || author || 'human' });
                }}
                aria-label="Note author"
                maxLength={100}
                placeholder="author"
              />
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={!composingNote}
              >
                <Plus size={12} />
                Done
              </button>
            </div>
          </form>

          <p className="field-hint">Notes are kept in your local draft as you type. Save includes them with the diagram.</p>

          {/* Notes List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {relevantNotes.filter(note => note.id !== composingNoteId).map((note) => (
              <div key={note.id} className="note-card" data-testid={`note-${note.id}`}>
                <div className="note-card-header">
                  <bdi className="note-author">{note.author}</bdi>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setEditingNoteId(note.id);
                        setOriginalNoteBody(note.body);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      aria-label="Delete note"
                      onClick={() => onRemoveNote(note.id)}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>

                {editingNoteId === note.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <textarea
                      className="inspector-textarea"
                      value={note.body}
                      onChange={(e) => onUpdateNote(note.id, { body: e.target.value })}
                      aria-label="Edit note"
                      dir="auto"
                      maxLength={20000}
                      rows={2}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '4px' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => { onUpdateNote(note.id, { body: originalNoteBody }); setEditingNoteId(null); }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setEditingNoteId(null)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="note-body" dir="auto">{note.body}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Detached Notes Section (Preserved Intent) */}
        {!selectedNode && !selectedEdge && detachedNotes.length > 0 && (
          <div className="inspector-section" style={{ borderTop: '1px solid #fde68a', paddingTop: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#92400e' }}>
              <AlertTriangle size={14} />
              <span className="inspector-label" style={{ color: '#92400e' }}>
                Detached Notes ({detachedNotes.length})
              </span>
            </div>
            <p className="field-hint" style={{ margin: '4px 0 8px 0' }}>
              Preserved from removed nodes or connections so questions and rationale are not lost.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {detachedNotes.map((note) => {
                const anchor = note.anchor as Extract<Anchor, { type: 'detached' }>;
                return (
                  <div key={note.id} className="note-card detached">
                    <div className="note-card-header">
                      <bdi className="note-author">{note.author}</bdi>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            onUpdateNote(note.id, {
                              anchor: { type: 'diagram' }
                            })
                          }
                          title="Reattach this note to the diagram"
                        >
                          <RotateCw size={10} />
                          Reattach
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          aria-label="Delete note"
                          onClick={() => onRemoveNote(note.id)}
                          title="Delete note permanently"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    </div>
                    <div className="note-context">
                      Was anchored to {anchor.previousType} &quot;{anchor.previousLabel}&quot;
                    </div>
                    <div className="note-body" dir="auto">{note.body}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
