import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchPayment } from "../../../backend/payments/dispatch";
import { handlePaymentsApi } from "../../../backend/payments/handler";
import {
  type FinalizedPaymentEvent,
  indexPaymentEvent,
} from "../../../backend/payments/ledger";
import {
  personalMessageHash,
  verifyPaymentWalletSignature,
} from "../../../backend/payments/possession";
import type { D1Database } from "../../../backend/trace/cloudflare-persistence";
import { sha256Hex } from "../../../workers/identity/crypto";
import { recoverUncertainAttempts } from "../../../workers/payments/index";

let sql: DatabaseSync;
let db: D1Database;
const now = "2026-10-06T12:00:00.000Z";
const token = "a".repeat(43);
function statement(
  query: string,
  args: unknown[] = [],
): ReturnType<D1Database["prepare"]> {
  return {
    bind(...values: unknown[]) {
      return statement(query, values);
    },
    async first<T>() {
      return (sql.prepare(query).get(...(args as string[])) ??
        null) as T | null;
    },
    async run() {
      const result = sql.prepare(query).run(...(args as string[]));
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
function request(path: string, body?: unknown, auth = true) {
  return new Request(`https://slop.cash/api/v1/payments${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(auth ? { cookie: `__Host-slop_points=${token}` } : {}),
      ...(body
        ? { origin: "https://slop.cash", "content-type": "application/json" }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function claim(
  id: string,
  chain = "base",
  actor = "123",
  predecessor: string | null = null,
) {
  sql
    .prepare(
      "INSERT INTO wallet_claims(id,github_user_id,github_login,wallet_address,source,source_body_sha256,observed_at,record_sha256,supersedes_claim_id,created_at,chain) VALUES(?,?,?,'0x7e5f4552091a69125d5dfcb7b8c2659029395bdf','d1_registry',?,?,?,?,?,?)",
    )
    .run(
      id,
      actor,
      "alice",
      id.padEnd(64, "a"),
      now,
      id.padEnd(64, "b"),
      predecessor,
      now,
      chain,
    );
}
async function authorize(claimId: string) {
  const challengeResponse = await handlePaymentsApi(
    request("/wallets/challenge", { claimId }),
    { db, now: () => new Date(now) },
  );
  if (!challengeResponse.ok) return challengeResponse;
  const challenge = await challengeResponse.json();
  const key = new Uint8Array(32);
  key[31] = 1;
  const signed = secp256k1.sign(personalMessageHash(challenge.message), key, {
    prehash: false,
    format: "recovered",
  });
  const signature = `0x${Array.from(signed.slice(1), (b) => b.toString(16).padStart(2, "0")).join("")}${(signed[0] + 27).toString(16)}`;
  return handlePaymentsApi(
    request("/wallets/authorize", {
      claimId,
      challengeId: challenge.challengeId,
      signature,
    }),
    { db, now: () => new Date(now) },
  );
}
const reserved: FinalizedPaymentEvent = {
  kind: "reserved",
  transactionId: "reserve-tx",
  eventIndex: 0,
  blockId: "block",
  obligationId: "award",
  projectId: "test",
  network: "base-sepolia",
  chain: "base",
  vault: "vault",
  githubUserId: "123",
  grossMicro: "100000000",
  netMicro: "98000000",
  feeMicro: "2000000",
  sourceDigest: "a".repeat(64),
};
async function index(event: FinalizedPaymentEvent) {
  await indexPaymentEvent(
    db,
    {
      async verifyFinalized() {
        return event;
      },
    },
    event,
    now,
  );
}
beforeEach(async () => {
  sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(`migrations/${file}`, "utf8"));
  db = {
    prepare: statement,
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const s of statements) result.push(await s.run());
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  sql
    .prepare(
      "INSERT INTO points_members(actor_id,github_id,login,joined_at,public) VALUES('node','123','alice',?,0)",
    )
    .run(now);
  sql
    .prepare("INSERT INTO points_sessions VALUES(?,?,?)")
    .run(await sha256Hex(token), "node", "2027-01-01T00:00:00.000Z");
});
afterEach(() => sql.close());
describe("payment account with migrated SQL database", () => {
  it("reserves a walletless award, authorizes late wallet, queues once and only marks paid from verified event", async () => {
    await index(reserved);
    await index(reserved);
    let response = await handlePaymentsApi(request("/me"), {
      db,
      now: () => new Date(now),
    });
    expect((await response.json()).balances).toContainEqual({
      chain: "base",
      netMicro: "98000000",
    });
    expect(sql.prepare("SELECT count(*) n FROM payment_outbox").get()?.n).toBe(
      0,
    );
    claim("claim");
    for (let i = 0; i < 2; i++) {
      response = await authorize("claim");
      expect(response.status).toBe(200);
    }
    expect(sql.prepare("SELECT count(*) n FROM payment_outbox").get()?.n).toBe(
      1,
    );
    expect(
      sql.prepare("SELECT state FROM payment_obligations").get()?.state,
    ).toBe("reserved");
    await index({
      ...reserved,
      kind: "paid",
      transactionId: "paid-tx",
      destination: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    });
    expect(sql.prepare("SELECT state FROM payment_outbox").get()?.state).toBe(
      "paid",
    );
    await expect(
      index({ ...reserved, kind: "paid", transactionId: "replay-tx" }),
    ).rejects.toThrow("duplicate");
  });
  it("rejects other actor and stale destinations, cross-site writes, anonymous reads and public admin writes", async () => {
    claim("foreign", "base", "456");
    claim("old");
    claim("new", "base", "123", "old");
    for (const claimId of ["foreign", "old"]) {
      expect((await authorize(claimId)).status).toBe(409);
    }
    expect(
      (await handlePaymentsApi(request("/me", undefined, false), { db }))
        .status,
    ).toBe(401);
    expect(
      (await handlePaymentsApi(request("/admin/wallet-proposals", {}), { db }))
        .status,
    ).toBe(403);
    const cross = request("/wallets/authorize", { claimId: "new" });
    cross.headers.set("origin", "https://evil.example");
    expect((await handlePaymentsApi(cross, { db })).status).toBe(403);
  });
  it("rejects unfinalized evidence without fabricating a balance", async () => {
    await expect(
      indexPaymentEvent(
        db,
        {
          async verifyFinalized() {
            throw new Error("not finalized");
          },
        },
        reserved,
        now,
      ),
    ).rejects.toThrow("not finalized");
    expect(
      sql.prepare("SELECT count(*) n FROM payment_obligations").get()?.n,
    ).toBe(0);
    await expect(index({ ...reserved, feeMicro: "1" })).rejects.toThrow(
      "mismatch",
    );
  });
  it("persists ambiguous dispatch and retries the same idempotency key without marking paid", async () => {
    claim("claim");
    await authorize("claim");
    await index(reserved);
    const keys: string[] = [];
    await expect(
      dispatchPayment(
        db,
        {
          async submit(input) {
            keys.push(input.idempotencyKey);
            throw new Error("connection lost");
          },
        },
        "award",
        new Date(now),
      ),
    ).rejects.toThrow("connection lost");
    expect(sql.prepare("SELECT state FROM payment_attempts").get()?.state).toBe(
      "unknown",
    );
    await dispatchPayment(
      db,
      {
        async submit(input) {
          keys.push(input.idempotencyKey);
          return { transactionId: "paid-tx" };
        },
      },
      "award",
      new Date(now),
    );
    expect(keys[0]).toBe(keys[1]);
    expect(
      sql.prepare("SELECT count(*) n FROM payment_attempts").get()?.n,
    ).toBe(1);
    expect(
      sql.prepare("SELECT state FROM payment_obligations").get()?.state,
    ).toBe("reserved");
    expect(
      await dispatchPayment(
        db,
        {
          async submit() {
            throw new Error("must not resubmit");
          },
        },
        "award",
        new Date(now),
      ),
    ).toBe("unavailable");
  });
  it("locks each funded project to one network and prevents replaying a source under another award", async () => {
    await index(reserved);
    await expect(
      index({
        ...reserved,
        transactionId: "second",
        obligationId: "second",
        network: "solana-testnet",
        chain: "solana",
      }),
    ).rejects.toThrow("locked");
    await expect(
      index({ ...reserved, transactionId: "second", obligationId: "second" }),
    ).rejects.toThrow("UNIQUE");
    expect(sql.prepare("SELECT count(*) n FROM payment_events").get()?.n).toBe(
      1,
    );
  });
  it("requires a wallet signature even with a valid GitHub session and consumes each signed challenge once", async () => {
    claim("claim");
    expect(
      (
        await handlePaymentsApi(
          request("/wallets/authorize", { claimId: "claim" }),
          { db },
        )
      ).status,
    ).toBe(400);
    const challenge = await (
      await handlePaymentsApi(
        request("/wallets/challenge", { claimId: "claim" }),
        { db, now: () => new Date(now) },
      )
    ).json();
    const key = new Uint8Array(32);
    key[31] = 1;
    const signature = secp256k1.sign(
      personalMessageHash(challenge.message),
      key,
      { prehash: false, format: "recovered" },
    );
    const body = {
      claimId: "claim",
      challengeId: challenge.challengeId,
      signature: `0x${Array.from(signature.slice(1), (b) => b.toString(16).padStart(2, "0")).join("")}${(signature[0] + 27).toString(16)}`,
    };
    expect(
      (
        await handlePaymentsApi(request("/wallets/authorize", body), {
          db,
          now: () => new Date(now),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await handlePaymentsApi(request("/wallets/authorize", body), {
          db,
          now: () => new Date(now),
        })
      ).status,
    ).toBe(403);
  });
  it("authorizes a Solana wallet with its Ed25519 signature and rejects a different message", async () => {
    const key = new Uint8Array(32).fill(7);
    const publicKey = ed25519.getPublicKey(key);
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let number = BigInt(
        `0x${Array.from(publicKey, (b) => b.toString(16).padStart(2, "0")).join("")}`,
      ),
      address = "";
    while (number) {
      address = alphabet[Number(number % 58n)] + address;
      number /= 58n;
    }
    for (const byte of publicKey) {
      if (byte !== 0) break;
      address = `1${address}`;
    }
    sql
      .prepare(
        "INSERT INTO wallet_claims(id,github_user_id,github_login,wallet_address,source,source_body_sha256,observed_at,record_sha256,created_at,chain) VALUES('sol','123','alice',?,'d1_registry',?,?,?,?,'solana')",
      )
      .run(address, "a".repeat(64), now, "b".repeat(64), now);
    const challenge = await (
      await handlePaymentsApi(
        request("/wallets/challenge", { claimId: "sol" }),
        { db, now: () => new Date(now) },
      )
    ).json();
    const body = {
      claimId: "sol",
      challengeId: challenge.challengeId,
      signature: Buffer.from(
        ed25519.sign(
          new TextEncoder().encode(`${challenge.message} altered`),
          key,
        ),
      ).toString("base64"),
    };
    expect(
      (
        await handlePaymentsApi(request("/wallets/authorize", body), {
          db,
          now: () => new Date(now),
        })
      ).status,
    ).toBe(403);
    body.signature = Buffer.from(
      ed25519.sign(new TextEncoder().encode(challenge.message), key),
    ).toString("base64");
    expect(
      (
        await handlePaymentsApi(request("/wallets/authorize", body), {
          db,
          now: () => new Date(now),
        })
      ).status,
    ).toBe(200);
  });
  it("registers from the existing GitHub session with canonical digests, audit and per-chain successor", async () => {
    const address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    const registered = await (
      await handlePaymentsApi(
        request("/wallets/register", { chain: "base", address }),
        { db, now: () => new Date(now) },
      )
    ).json();
    expect(typeof registered.claimId).toBe("string");
    const source = await sha256Hex(
      JSON.stringify({
        schemaVersion: 1,
        githubActorId: "123",
        address,
        chain: "base",
        supersedesClaimId: null,
      }),
    );
    const record = await sha256Hex(
      JSON.stringify({
        schemaVersion: 1,
        githubActorId: "123",
        githubLogin: "alice",
        address,
        chain: "base",
        source: "d1_registry",
        issueRepository: null,
        issueNumber: null,
        sourceBodySha256: source,
        observedAt: now,
        supersedesClaimId: null,
      }),
    );
    expect(
      sql
        .prepare("SELECT record_sha256 FROM wallet_claims WHERE id=?")
        .get(registered.claimId)?.record_sha256,
    ).toBe(record);
    const retry = await (
      await handlePaymentsApi(
        request("/wallets/register", { chain: "base", address }),
        { db },
      )
    ).json();
    expect(retry.claimId).toBe(registered.claimId);
    await handlePaymentsApi(
      request("/wallets/register", {
        chain: "base",
        address: "0x1111111111111111111111111111111111111111",
      }),
      { db },
    );
    expect(sql.prepare("SELECT count(*) n FROM wallet_claims").get()?.n).toBe(
      2,
    );
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM private_audit_events WHERE action='wallet_claim.created'",
        )
        .get()?.n,
    ).toBe(2);
  });
  it("rejects the Ed25519 identity-point forgery accepted by permissive consensus verification", () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const signature = new Uint8Array(64);
    signature[0] = 1;
    const message = "Authorize Slop automatic contributor payouts";
    expect(
      ed25519.verify(signature, new TextEncoder().encode(message), identity),
    ).toBe(true);
    let value = BigInt(`0x${Buffer.from(identity).toString("hex")}`),
      address = "";
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    while (value) {
      address = alphabet[Number(value % 58n)] + address;
      value /= 58n;
    }
    expect(
      verifyPaymentWalletSignature(
        "solana",
        address,
        message,
        Buffer.from(signature).toString("base64"),
      ),
    ).toBe(false);
  });
  it("retires an unsigned old-wallet attempt without a late request resurrecting it", async () => {
    claim("old");
    await authorize("old");
    await index(reserved);
    let rejectSend: (error: Error) => void = () => {};
    let entered: () => void = () => {};
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = dispatchPayment(
      db,
      {
        async submit() {
          entered();
          return new Promise((_resolve, reject) => {
            rejectSend = reject;
          });
        },
      },
      "award",
      new Date(now),
    );
    const result = pending.catch((error) => error);
    await entry;
    claim("new", "base", "123", "old");
    await authorize("new");
    await recoverUncertainAttempts({
      PAYMENTS_DB: db,
      PAYMENT_DEPLOYMENTS: "[]",
      PAYMENT_RPC_URLS: "{}",
      BASE_PAYMENT_EXECUTOR: {
        async fetch(request) {
          return Response.json(
            request.url.endsWith("cancel-unsubmitted")
              ? { retired: true, transactionId: null }
              : { transactionId: null },
          );
        },
      },
    });
    expect(sql.prepare("SELECT state FROM payment_attempts").get()?.state).toBe(
      "failed",
    );
    rejectSend(new Error("retired signing operation"));
    await result;
    expect(sql.prepare("SELECT state FROM payment_attempts").get()?.state).toBe(
      "failed",
    );
    expect(sql.prepare("SELECT state FROM payment_outbox").get()?.state).toBe(
      "ready",
    );
  });
});
