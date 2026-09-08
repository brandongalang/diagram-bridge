import React from 'react';
import { AlertCircle, Download, Copy, RefreshCw } from 'lucide-react';

interface ConflictBannerProps {
  remoteRevision: number;
  onSaveAsCopy: () => void;
  onDownloadDraft: () => void;
  onDiscardAndReload: () => void;
}

export const ConflictBanner: React.FC<ConflictBannerProps> = ({
  remoteRevision,
  onSaveAsCopy,
  onDownloadDraft,
  onDiscardAndReload
}) => {
  return (
    <div className="conflict-banner" role="alert">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <AlertCircle size={16} color="#b45309" />
        <span>
          <strong>Remote Conflict:</strong> Revision {remoteRevision} is available on the server, but you have unsaved local edits.
        </span>
      </div>
      <div className="conflict-banner-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onSaveAsCopy}
          title="Save your current edits as a new document"
        >
          <Copy size={12} />
          Save as Copy
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onDownloadDraft}
          title="Download your draft as a local JSON backup"
        >
          <Download size={12} />
          Download Draft
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onDiscardAndReload}
          title="Discard local edits and load server revision"
        >
          <RefreshCw size={12} />
          Discard & Reload
        </button>
      </div>
    </div>
  );
};
