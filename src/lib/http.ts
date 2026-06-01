const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 300;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function httpGet<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {}
): Promise<{ data: T; fetchedAt: Date }> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES } = opts;

  let lastError: Error = new Error('unknown');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'polygon-market-bot/1.0', ...headers },
        },
        timeoutMs
      );

      if (!res.ok) throw new HttpError(res.status, url, `HTTP ${res.status}: ${res.statusText}`);

      const data = (await res.json()) as T;
      return { data, fetchedAt: new Date() };
    } catch (err) {
      lastError = err as Error;
      if (err instanceof HttpError && err.status < 500) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}
