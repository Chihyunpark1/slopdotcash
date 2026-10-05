/** Public RPC endpoints refuse bursts with HTTP 429. Only that answer is
 * retried, a bounded number of times, honouring a small Retry-After. Every
 * other status, error, or timeout is returned or thrown unchanged. */
export type FetchLike = (url: URL, init?: RequestInit) => Promise<Response>;

export const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header !== null && /^\d{1,3}$/u.test(header.trim()))
    return Math.min(Number(header.trim()) * 1000, RATE_LIMIT_MAX_WAIT_MS);
  return Math.min(1000 * (attempt + 1), RATE_LIMIT_MAX_WAIT_MS);
}

/** Sends the request with a fresh timeout per attempt. */
export async function fetchWithRateLimitRetry(
  fetchImpl: FetchLike,
  url: URL,
  init: Omit<RequestInit, "signal">,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES)
      return response;
    await response.body?.cancel();
    await new Promise((resolve) =>
      setTimeout(resolve, retryAfterMs(response, attempt)),
    );
  }
}
