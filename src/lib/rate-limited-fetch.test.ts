/** Proves only HTTP 429 is retried, a bounded number of times. */
import { describe, expect, it } from "vitest";
import {
  fetchWithRateLimitRetry,
  RATE_LIMIT_RETRIES,
} from "./rate-limited-fetch";

const URL_ = new URL("https://rpc.example/");
const refusal = () =>
  new Response("slow down", { status: 429, headers: { "retry-after": "0" } });

describe("rate limited fetch", () => {
  it("retries a 429 with Retry-After and returns the first other answer", async () => {
    const answers = [refusal(), refusal(), new Response("ok", { status: 200 })];
    const signals: AbortSignal[] = [];
    const response = await fetchWithRateLimitRetry(
      async (_url, init) => {
        signals.push(init?.signal as AbortSignal);
        return answers.shift() as Response;
      },
      URL_,
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(200);
    expect(answers).toHaveLength(0);
    expect(new Set(signals).size).toBe(3);
  });

  it("gives up after the bounded retries and returns the 429 itself", async () => {
    let calls = 0;
    const response = await fetchWithRateLimitRetry(
      async () => {
        calls += 1;
        return refusal();
      },
      URL_,
      { method: "POST" },
    );
    expect(response.status).toBe(429);
    expect(calls).toBe(RATE_LIMIT_RETRIES + 1);
  });

  it("does not retry any other status or a thrown error", async () => {
    let calls = 0;
    const response = await fetchWithRateLimitRetry(
      async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
      URL_,
      {},
    );
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    await expect(
      fetchWithRateLimitRetry(
        async () => {
          throw new Error("offline");
        },
        URL_,
        {},
      ),
    ).rejects.toThrow("offline");
  });
});
