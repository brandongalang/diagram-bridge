import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, RotateCcw, Clock, User, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../api/client.js';
import { usePanelFocus } from '../hooks/usePanelFocus.js';
import type { RevisionMeta } from '../types.js';

interface HistoryPanelProps {
  documentId: string;
  currentRevision: number;
  onClose: () => void;
  onRevert: (targetRevision: number) => void;
  disabled?: boolean;
}

interface HistoryRevisionEntriesProps {
  revisions: RevisionMeta[];
  currentRevision: number;
  selectedRev: number | null;
  onSelect: (revision: number | null) => void;
  onRevert: (revision: number) => void;
  disabled?: boolean;
}

export const HistoryRevisionEntries: React.FC<HistoryRevisionEntriesProps> = ({
  revisions,
  currentRevision,
  selectedRev,
  onSelect,
  onRevert,
  disabled = false
}) => {
  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <>
      {revisions.map((rev) => {
        const isCurrent = rev.revision === currentRevision;
        const isSelected = selectedRev === rev.revision;

        return (
          <div key={rev.revision} className={`history-item ${isSelected ? 'selected' : ''}`}>
            <button
              type="button"
              className="history-revision-button"
              aria-expanded={isCurrent ? undefined : isSelected}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={`Revision ${rev.revision}`}
              aria-describedby={`revision-${rev.revision}-summary`}
              onClick={() => onSelect(isSelected ? null : rev.revision)}
            >
              <span className="history-entry-heading">
                <span>
                  Revision {rev.revision} {isCurrent && '(current)'}
                </span>
                <time dateTime={rev.createdAt}>{formatDate(rev.createdAt)}</time>
              </span>
              <span className="history-entry-meta">
                <User size={11} color="#64748b" />
                <bdi>{rev.author}</bdi>
              </span>
              <span id={`revision-${rev.revision}-summary`} className="history-entry-summary">{rev.summary || 'Snapshot commit'}</span>
            </button>
            {isSelected && !isCurrent && (
              <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onRevert(rev.revision)}
                  disabled={disabled}
                  title={`Revert back to revision ${rev.revision}`}
                >
                  <RotateCcw size={12} />
                  <span>Revert to Rev {rev.revision}</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  documentId,
  currentRevision,
  onClose,
  onRevert,
  disabled = false
}) => {
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRev, setSelectedRev] = useState<number | null>(null);
  const loadGenerationRef = useRef(0);
  const { panelRef, closeButtonRef } = usePanelFocus(onClose);

  const loadHistory = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    setRevisions([]);
    setSelectedRev(null);

    api
      .getHistory(documentId)
      .then((res) => {
        if (generation !== loadGenerationRef.current) return;
        setRevisions(res.revisions || []);
        setLoading(false);
      })
      .catch((err) => {
        if (generation !== loadGenerationRef.current) return;
        setError(err.message || 'Failed to load history');
        setRevisions([]);
        setLoading(false);
      });
  }, [documentId]);

  useEffect(() => {
    loadHistory();
    return () => { loadGenerationRef.current++; };
  }, [loadHistory, currentRevision]);

  return (
    <aside ref={panelRef} className="history-panel" aria-label="Revision history panel">
      <div className="inspector-header">
        <div className="inspector-title">
          <Clock size={14} />
          <span>Revision History</span>
        </div>
        <button
          type="button"
          className="tool-rail-btn"
          ref={closeButtonRef}
          onClick={onClose}
          aria-label="Close history"
        >
          <X size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px', color: '#64748b', gap: '8px' }}>
            <Loader2 size={16} className="spin" />
            <span style={{ fontSize: '12px' }}>Loading revisions...</span>
          </div>
        )}

        {error && (
          <div className="history-error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={loadHistory}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && revisions.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>
            No revisions found.
          </div>
        )}

        {!loading && !error && (
          <HistoryRevisionEntries
            revisions={revisions}
            currentRevision={currentRevision}
            selectedRev={selectedRev}
            onSelect={setSelectedRev}
            onRevert={onRevert}
            disabled={disabled}
          />
        )}
      </div>
    </aside>
  );
};
