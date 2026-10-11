let csrfToken: string | null = null;
let sessionRequest: Promise<string> | null = null;

async function token(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (!sessionRequest) sessionRequest = fetch('/api/session', { credentials: 'same-origin' })
    .then(async response => {
      if (!response.ok) throw new Error('无法建立本地会话，请刷新页面重试');
      const result = await response.json() as { token: string };
      csrfToken = result.token;
      return result.token;
    }).finally(() => { sessionRequest = null; });
  return sessionRequest;
}

export async function api<T>(path: string, method = 'GET', body?: unknown, retried = false): Promise<T> {
  const sessionToken = await token();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = sessionToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) csrfToken = null;
    if (response.status === 401 && method === 'GET' && !retried) return api<T>(path, method, body, true);
    throw new Error(result.error || `请求未完成（${response.status}）`);
  }
  return result as T;
}
