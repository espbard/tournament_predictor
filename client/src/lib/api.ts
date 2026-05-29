export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isFormData = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: isFormData ? undefined : (body ? { 'Content-Type': 'application/json' } : {}),
    body: isFormData ? body : (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'include',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? res.statusText, err.details);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function uploadFile(file: File, type: 'users' | 'tournaments' | 'teams'): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  form.append('type', type);
  const result = await request<{ url: string }>('POST', '/upload', form);
  return result.url;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
