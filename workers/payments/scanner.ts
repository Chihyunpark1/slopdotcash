import type { D1Database } from "../../backend/trace/cloudflare-persistence";
import { escrowInvocations } from "../../contracts/solana/adapter";
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
const SOLANA_SIGNATURE_PAGES = 20;
const SOLANA_TRANSACTIONS_PER_RUN = 100;
/**
 * Indexes this project's escrow instructions oldest first. Anyone can mention
 * the project account in a transaction, so other projects' instructions are
 * skipped, work per run is bounded, and the cursor advances per transaction.
 */
export async function scanSolanaPayments(
  db: D1Database,
  deployment: ScanDeployment,
  rpcUrl: string,
  index: (event: ScanEvent) => Promise<void>,
): Promise<void> {
  const { projectPda, programId } = deployment;
  if (!projectPda || !programId)
    throw new Error("Solana project deployment missing");
  const cursor = await db
    .prepare(
      "SELECT position FROM payment_chain_cursors WHERE project_id=? AND network=?",
    )
    .bind(deployment.projectId, deployment.network)
    .first<{ position: string }>();
  const signatures: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  for (let page = 0; ; page++) {
    if (page === SOLANA_SIGNATURE_PAGES)
      throw new Error("Solana scanner backlog exceeds one run");
    const result = (await rpc(rpcUrl, "getSignaturesForAddress", [
      projectPda,
      {
        commitment: "finalized",
        limit: 1000,
        ...(before ? { before } : {}),
        ...(cursor ? { until: cursor.position } : {}),
      },
    ])) as { signature: string; err: unknown }[];
    if (!Array.isArray(result))
      throw new Error("Invalid Solana signature page");
    signatures.push(...result);
    if (result.length < 1000) break;
    before = result[result.length - 1].signature;
  }
  const save = (signature: string) =>
    db
      .prepare(
        "INSERT INTO payment_chain_cursors VALUES(?,?,?,?) ON CONFLICT(project_id,network) DO UPDATE SET position=excluded.position,synced_at=excluded.synced_at",
      )
      .bind(
        deployment.projectId,
        deployment.network,
        signature,
        new Date().toISOString(),
      )
      .run();
  for (const item of signatures
    .reverse()
    .slice(0, SOLANA_TRANSACTIONS_PER_RUN)) {
    if (!item.err) {
      const tx = (await rpc(rpcUrl, "getTransaction", [
        item.signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ])) as Record<string, unknown> | null;
      const meta = tx?.meta as { err: unknown } | undefined;
      if (!tx || !meta || meta.err)
        throw new Error("Finalized transaction unavailable");
      for (const invocation of escrowInvocations(tx, programId)) {
        const project =
          invocation.kind === "reserved"
            ? invocation.accounts[1]
            : invocation.accounts[0];
        if (project !== projectPda) continue;
        let obligationId: string;
        if (invocation.kind === "reserved")
          obligationId = hex(invocation.data.slice(8, 40));
        else {
          const award = (await rpc(rpcUrl, "getAccountInfo", [
            invocation.accounts[1],
            { commitment: "finalized", encoding: "base64" },
          ])) as { value: { data: [string, string] } | null };
          if (!award?.value) throw new Error("Paid award account missing");
          const bytes = Uint8Array.from(atob(award.value.data[0]), (c) =>
            c.charCodeAt(0),
          );
          obligationId = hex(bytes.slice(80, 112));
        }
        await index({
          projectId: deployment.projectId,
          network: deployment.network,
          transactionId: item.signature,
          eventIndex: invocation.index,
          kind: invocation.kind,
          obligationId,
        });
      }
    }
    await save(item.signature);
  }
}
const hex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
