import type {
  DiagramDocument,
  DocumentSummary,
  RevisionMeta,
  ApplyRequest,
  MutationResult,
  PullResult
} from '../types.js';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TOKEN_STORAGE_KEY = 'diagram_bridge_token';

export function initializeAuthToken(): string | null {
  if (typeof window === 'undefined') return null;

  // Check URL fragment for #token=...
  const hash = window.location.hash;
  if (hash && hash.includes('token=')) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const token = params.get('token');
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      // Strip fragment from URL without triggering reload
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return token;
    }
  }

  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers,
    signal: AbortSignal.timeout(10000)
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const code = payload?.error?.code || (response.status === 409 ? 'STALE_REVISION_CONFLICT' : 'HTTP_ERROR');
    const message = payload?.error?.message || `Request failed with status ${response.status}`;
    const details = payload?.error?.details;
    throw new ApiError(response.status, code, message, details);
  }

  return payload as T;
}

export const api = {
  async getBootstrap(): Promise<{ apiVersion: 1; workspaceId: string; workspacePath: string; cliPath: string; documents: DocumentSummary[] }> {
    return request('/api/bootstrap');
  },

  async getDocuments(): Promise<{ apiVersion: 1; documents: DocumentSummary[] }> {
    return request('/api/documents');
  },

  async createDocument(title: string, document?: DiagramDocument): Promise<{ apiVersion: 1; document: DiagramDocument }> {
    return request('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ title, document })
    });
  },

  async getDocument(id: string, revision?: number): Promise<{ apiVersion: 1; document: DiagramDocument }> {
    const url = revision !== undefined ? `/api/documents/${encodeURIComponent(id)}?revision=${revision}` : `/api/documents/${encodeURIComponent(id)}`;
    return request(url);
  },

  async getHead(id: string): Promise<{ apiVersion: 1; revision: number }> {
    return request(`/api/documents/${encodeURIComponent(id)}/head`);
  },

  async getHistory(id: string): Promise<{ apiVersion: 1; revisions: RevisionMeta[] }> {
    return request(`/api/documents/${encodeURIComponent(id)}/history`);
  },

  async apply(id: string, req: ApplyRequest): Promise<{ apiVersion: 1 } & MutationResult> {
    return request(`/api/documents/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify(req)
    });
  },

  async revert(id: string, req: Omit<ApplyRequest, 'operations'>): Promise<{ apiVersion: 1 } & MutationResult> {
    return request(`/api/documents/${encodeURIComponent(id)}/revert`, {
      method: 'POST',
      body: JSON.stringify(req)
    });
  },

  async pull(id: string, since?: number): Promise<{ apiVersion: 1 } & PullResult> {
    const url = since !== undefined ? `/api/documents/${encodeURIComponent(id)}/pull?since=${since}` : `/api/documents/${encodeURIComponent(id)}/pull`;
    return request(url);
  }
};
