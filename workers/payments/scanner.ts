import type { D1Database } from "../../backend/trace/cloudflare-persistence";
export interface ScanDeployment {
  projectId: string;
  network: string;
  chain: string;
  vault: string;
  deploymentTransaction?: string;
  projectPda?: string;
  programId?: string;
}
export interface ScanEvent {
  projectId: string;
  network: string;
  transactionId: string;
  eventIndex: number;
  kind: "reserved" | "paid";
  obligationId: string;
}
const RESERVED =
  "0xd42548deb9ef20b582fe02f194f3c5e39fd0b7d1803321cd197e4ce48c30a857";
const PAID =
  "0x4bf296cb04d665f3fe904ce30894876ea577c828bbc117e8bacad4c4bcb757f7";
async function rpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("Scanner RPC unavailable");
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error || !("result" in body)) throw new Error("Scanner RPC failed");
  return body.result;
}
/** A cursor advances only after every recognized finalized event is durably verified and indexed. */
export async function scanBasePayments(
  db: D1Database,
  deployment: ScanDeployment,
  rpcUrl: string,
  index: (event: ScanEvent) => Promise<void>,
): Promise<void> {
  const cursor = await db
    .prepare(
      "SELECT position FROM payment_chain_cursors WHERE project_id=? AND network=?",
    )
    .bind(deployment.projectId, deployment.network)
    .first<{ position: string }>();
  let from: bigint;
  if (cursor) from = BigInt(cursor.position) + 1n;
  else {
    if (!deployment.deploymentTransaction)
      throw new Error("Deployment transaction required for scanner origin");
    const receipt = (await rpc(rpcUrl, "eth_getTransactionReceipt", [
      deployment.deploymentTransaction,
    ])) as { status: string; blockNumber: string } | null;
    if (receipt?.status !== "0x1")
      throw new Error("Deployment origin unavailable");
    from = BigInt(receipt.blockNumber);
  }
  const finalized = (await rpc(rpcUrl, "eth_getBlockByNumber", [
    "finalized",
    false,
  ])) as { number: string } | null;
  if (!finalized) throw new Error("Finalized chain head unavailable");
  const end = BigInt(finalized.number);
  if (from > end) return;
  const to = from + 1999n < end ? from + 1999n : end;
  const logs = (await rpc(rpcUrl, "eth_getLogs", [
    {
      address: deployment.vault,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics: [[RESERVED, PAID]],
    },
  ])) as {
    topics: string[];
    transactionHash: string;
    logIndex: string;
    blockNumber: string;
  }[];
  if (!Array.isArray(logs)) throw new Error("Invalid finalized log page");
  logs.sort((a, b) =>
    BigInt(a.blockNumber) === BigInt(b.blockNumber)
      ? Number(BigInt(a.logIndex) - BigInt(b.logIndex))
      : BigInt(a.blockNumber) < BigInt(b.blockNumber)
        ? -1
        : 1,
  );
  for (const log of logs) {
    if (log.topics[0] !== RESERVED && log.topics[0] !== PAID)
      throw new Error("Unexpected scanner event");
    await index({
      projectId: deployment.projectId,
      network: deployment.network,
      transactionId: log.transactionHash,
      eventIndex: Number(BigInt(log.logIndex)),
      kind: log.topics[0] === RESERVED ? "reserved" : "paid",
      obligationId: log.topics[1],
    });
  }
  await db
    .prepare(
      "INSERT INTO payment_chain_cursors VALUES(?,?,?,?) ON CONFLICT(project_id,network) DO UPDATE SET position=excluded.position,synced_at=excluded.synced_at",
    )
    .bind(
      deployment.projectId,
      deployment.network,
      to.toString(),
      new Date().toISOString(),
    )
    .run();
}
export async function scanSolanaPayments(
  db: D1Database,
  deployment: ScanDeployment,
  rpcUrl: string,
  index: (event: ScanEvent) => Promise<void>,
): Promise<void> {
  if (!deployment.projectPda || !deployment.programId)
    throw new Error("Solana project deployment missing");
  const cursor = await db
    .prepare(
      "SELECT position FROM payment_chain_cursors WHERE project_id=? AND network=?",
    )
    .bind(deployment.projectId, deployment.network)
    .first<{ position: string }>();
  const signatures: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  while (true) {
    const page = (await rpc(rpcUrl, "getSignaturesForAddress", [
      deployment.projectPda,
      {
        commitment: "finalized",
        limit: 1000,
        ...(before ? { before } : {}),
        ...(cursor ? { until: cursor.position } : {}),
      },
    ])) as { signature: string; err: unknown }[];
    if (!Array.isArray(page)) throw new Error("Invalid Solana signature page");
    signatures.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const latest = signatures[0]?.signature;
  for (const item of signatures.reverse()) {
    if (item.err) continue;
    const tx = (await rpc(rpcUrl, "getTransaction", [
      item.signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ])) as { meta: { err: unknown; logMessages: string[] } } | null;
    if (!tx?.meta || tx.meta.err)
      throw new Error("Finalized transaction unavailable");
    const stack: string[] = [];
    for (const [eventIndex, line] of tx.meta.logMessages.entries()) {
      const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
      if (invoke) stack.push(invoke[1]);
      if (
        line.startsWith("Program data: ") &&
        stack.at(-1) === deployment.programId
      ) {
        const bytes = Uint8Array.from(atob(line.slice(14)), (c) =>
          c.charCodeAt(0),
        );
        const hex = (value: Uint8Array) =>
          Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
        const tag = hex(bytes.slice(0, 8));
        if (tag === "140fcba476acd0cb" || tag === "8e7aeab516affa91") {
          const kind = tag === "140fcba476acd0cb" ? "reserved" : "paid";
          const offset = kind === "reserved" ? 80 : 48;
          await index({
            projectId: deployment.projectId,
            network: deployment.network,
            transactionId: item.signature,
            eventIndex,
            kind,
            obligationId: hex(bytes.slice(offset, offset + 32)),
          });
        }
      }
      const end = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
      if (end && stack.pop() !== end[1])
        throw new Error("Invalid program invocation stack");
    }
  }
  if (latest)
    await db
      .prepare(
        "INSERT INTO payment_chain_cursors VALUES(?,?,?,?) ON CONFLICT(project_id,network) DO UPDATE SET position=excluded.position,synced_at=excluded.synced_at",
      )
      .bind(
        deployment.projectId,
        deployment.network,
        latest,
        new Date().toISOString(),
      )
      .run();
}
