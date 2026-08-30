export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw new UpstreamError(`Upstream returned ${response.status}`, response.status, body);
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
