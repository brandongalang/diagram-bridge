import React, { useRef, useState } from 'react';
import {
  Save,
  Check,
  AlertCircle,
  Loader2,
  FolderPlus,
  FileCode2,
  Download,
  Copy,
  RotateCcw,
  Send
} from 'lucide-react';
import type { DocumentSummary, SaveStatus } from '../types.js';

export const REVISION_AUTHOR_MAX_LENGTH = 100;

export function revisionAuthorError(author: string): string | null {
  const trimmed = author.trim();
  if (trimmed.length < 1 || trimmed.length > REVISION_AUTHOR_MAX_LENGTH) {
    return `Author must be between 1 and ${REVISION_AUTHOR_MAX_LENGTH} characters.`;
  }
  return null;
}

export function resolveAuthorForNewRequest(
  fieldAuthor: string
): { ok: true; author: string } | { ok: false; error: string } {
  const error = revisionAuthorError(fieldAuthor);
  if (error) return { ok: false, error };
  return { ok: true, author: fieldAuthor.trim() };
}

interface TopBarProps {
  title: string;
  onTitleChange: (newTitle: string) => void;
  revision: number;
  saveStatus: SaveStatus;
  onSave: () => void;
  documents: DocumentSummary[];
  currentDocumentId: string;
  onSelectDocument: (docId: string) => void;
  onCreateDocument: () => void;
  onSaveAsCopy: () => void;
  onDownloadDraft: () => void;
  onDiscardChanges: () => void;
  hasUnsavedEdits: boolean;
  author: string;
  onAuthorChange: (author: string) => void;
  disabled?: boolean;
  onHandoff?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  title,
  onTitleChange,
  revision,
  saveStatus,
  onSave,
  documents,
  currentDocumentId,
  onSelectDocument,
  onCreateDocument,
  onSaveAsCopy,
  onDownloadDraft,
  onDiscardChanges,
  hasUnsavedEdits,
  author,
  onAuthorChange,
  disabled = false,
  onHandoff
}) => {
  const originalTitle = useRef(title);
  const cancelledTitle = useRef(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  const authorIssue = revisionAuthorError(author);

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
    if (cancelledTitle.current) { cancelledTitle.current = false; return; }
    if (titleValue.trim() && titleValue.trim() !== title) {
      onTitleChange(titleValue.trim());
    } else {
      setTitleValue(title);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      cancelledTitle.current = true;
      setTitleValue(originalTitle.current);
      if (originalTitle.current !== title) onTitleChange(originalTitle.current);
      setIsEditingTitle(false);
      e.currentTarget.blur();
    }
  };

  return (
    <header className="topbar" aria-label="Editor header">
      <div className="topbar-left">
        <div className="brand-badge" title="Diagram Bridge (Drafting Desk)">
          <div className="brand-icon">
            <FileCode2 size={14} />
          </div>
          <span style={{ display: 'none' }}>Diagram Bridge</span>
        </div>

        {/* Document Selector */}
        <select
          className="inspector-select document-select"
          value={currentDocumentId}
          onChange={(e) => onSelectDocument(e.target.value)}
          disabled={disabled}
          aria-label="Select document"
        >
          {documents.map((d) => (
            <option key={d.documentId} value={d.documentId}>
              {d.title} (r{d.revision})
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn btn-sm"
          onClick={onCreateDocument}
          disabled={disabled}
          title="Create a new diagram document"
          aria-label="New diagram"
        >
          <FolderPlus size={13} />
          <span>New</span>
        </button>

        <div className="topbar-divider" />

        {/* Editable Document Title */}
        <input
          type="text"
          className="title-input"
          maxLength={200}
          disabled={disabled}
          value={isEditingTitle ? titleValue : title}
          onChange={(e) => {
            setTitleValue(e.target.value);
            if (e.target.value.trim()) onTitleChange(e.target.value);
          }}
          onFocus={() => {
            originalTitle.current = title;
            setTitleValue(title);
            setIsEditingTitle(true);
          }}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          title="Click to rename document"
          aria-label="Diagram Title"
          dir="auto"
        />

        {/* Revision & Save Status Badge */}
        <div className={`revision-badge ${saveStatus}`} data-testid="revision-badge">
          {saveStatus === 'saving' && <Loader2 size={12} className="spin" />}
          {saveStatus === 'saved' && <Check size={12} />}
          {saveStatus === 'unsaved' && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#d97706',
                display: 'inline-block'
              }}
            />
          )}
          {saveStatus === 'error' && <AlertCircle size={12} />}
          <span>
            {saveStatus === 'saving' && 'Saving...'}
            {saveStatus === 'saved' && `Rev ${revision} · Saved`}
            {saveStatus === 'unsaved' && `Rev ${revision} · Unsaved`}
            {saveStatus === 'error' && 'Save failed'}
          </span>
        </div>
      </div>

      <div className="topbar-right">
        <div className="revision-author-field">
          <label htmlFor="revision-author">Author</label>
          <input
            id="revision-author"
            type="text"
            className="inspector-input revision-author-input"
            maxLength={REVISION_AUTHOR_MAX_LENGTH}
            value={author}
            onChange={(e) => onAuthorChange(e.target.value)}
            placeholder="author"
            aria-label="Revision author"
            aria-invalid={authorIssue ? true : undefined}
            aria-describedby={authorIssue ? 'revision-author-error' : undefined}
            title="Author name for operations and notes"
          />
          {authorIssue && (
            <p id="revision-author-error" className="field-error" role="alert">
              {authorIssue}
            </p>
          )}
        </div>

        {hasUnsavedEdits && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onDiscardChanges}
            disabled={disabled || saveStatus === 'saving'}
            title="Discard unsaved local changes and reload last saved revision"
          >
            <RotateCcw size={12} />
            Discard
          </button>
        )}

        <button
          type="button"
          className="btn btn-sm"
          onClick={onSaveAsCopy}
          disabled={disabled}
          title="Duplicate this diagram as a new document"
        >
          <Copy size={12} />
          Copy
        </button>

        <button
          type="button"
          className="btn btn-sm"
          onClick={onDownloadDraft}
          title="Download current draft as JSON"
        >
          <Download size={12} />
          Export JSON
        </button>

        {onHandoff && <button type="button" className="btn handoff-button" onClick={onHandoff} disabled={disabled}>
          <Send size={14} /> Agent handoff
        </button>}

        {/* Primary Save Button */}
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={disabled || saveStatus === 'saving' || (!hasUnsavedEdits && saveStatus === 'saved')}
          title="Save diagram changes (Ctrl/Cmd+S)"
          data-testid="save-button"
        >
          {saveStatus === 'saving' ? (
            <>
              <Loader2 size={13} className="spin" />
              <span>Saving...</span>
            </>
          ) : (
            <>
              <Save size={13} />
              <span>Save</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
};
