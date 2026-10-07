import { sha256 } from "@noble/hashes/sha2.js";
import type { PaymentChainAdapter } from "../../backend/payments/ledger";
import { decodeBase58Bytes } from "../../src/lib/squads-funding";

export interface SolanaEscrowConfig {
  rpcUrl: string;
  genesisHash: string;
  programId: string;
  projectPda: string;
  projectId: string;
  network: string;
  networkDomain: string;
  vault: string;
  mint: string;
  owner: string;
  identityAuthority: string;
  feeRecipient: string;
  codeSha256: string;
  upgradeAuthority: string | null;
}
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid RPC object");
  return value as Obj;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid RPC string");
  return value;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Invalid RPC list");
  return value;
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result;
}
const uint = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
    offset,
    true,
  );
const pubkey = (bytes: Uint8Array, offset: number) =>
  base58(bytes.slice(offset, offset + 32));
function digest(value: string): Uint8Array {
  const plain = value.replace(/^0x/, "");
  if (!/^[a-fA-F0-9]{64}$/.test(plain))
    throw new Error("Invalid obligation digest");
  return Uint8Array.from(plain.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}
async function rpc(
  config: SolanaEscrowConfig,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC HTTP failure ${response.status}`);
  const body = object(await response.json());
  if (body.id !== 1 || body.error || !("result" in body))
    throw new Error("RPC failure");
  return body.result;
}
function account(
  value: unknown,
  owner: string,
  size: number,
  discriminator: string,
): Uint8Array {
  const info = object(value);
  if (info.owner !== owner) throw new Error("Account owner mismatch");
  const data = list(info.data);
  if (data[1] !== "base64") throw new Error("Wrong account encoding");
  const bytes = decode(string(data[0]));
  if (bytes.length !== size || hex(bytes.slice(0, 8)) !== discriminator)
    throw new Error("Account layout mismatch");
  return bytes;
}

/** Bind the reviewed deployment to finalized executable bytes and all project authorities. */
export async function verifySolanaDeployment(
  config: SolanaEscrowConfig,
): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(config.codeSha256))
    throw new Error("Missing reviewed program digest");
  if ((await rpc(config, "getGenesisHash", [])) !== config.genesisHash)
    throw new Error("Wrong Solana cluster");
  const response = object(
    await rpc(config, "getAccountInfo", [
      config.programId,
      { commitment: "finalized", encoding: "base64" },
    ]),
  );
  const program = object(response.value),
    data = list(program.data);
  if (program.executable !== true || data[1] !== "base64")
    throw new Error("Program is not executable");
  let code = decode(string(data[0]));
  if (program.owner === "BPFLoaderUpgradeab1e11111111111111111111111") {
    if (
      code.length !== 36 ||
      new DataView(code.buffer).getUint32(0, true) !== 2
    )
      throw new Error("Invalid upgradeable program pointer");
    const pd = object(
      object(
        await rpc(config, "getAccountInfo", [
          pubkey(code, 4),
          { commitment: "finalized", encoding: "base64" },
        ]),
      ).value,
    );
    const pdData = list(pd.data);
    if (
      pd.owner !== program.owner ||
      pd.executable !== false ||
      pdData[1] !== "base64"
    )
      throw new Error("ProgramData owner mismatch");
    const content = decode(string(pdData[0]));
    if (
      content.length <= 45 ||
      new DataView(content.buffer).getUint32(0, true) !== 3 ||
      content[12] > 1
    )
      throw new Error("Invalid ProgramData metadata");
    const authority = content[12] === 1 ? pubkey(content, 13) : null;
    if (authority !== config.upgradeAuthority)
      throw new Error("Upgrade authority mismatch");
    code = content.slice(45);
  } else if (
    program.owner !== "BPFLoader2111111111111111111111111111111111" ||
    config.upgradeAuthority !== null
  )
    throw new Error("Unsupported program loader or authority");
  if (hex(sha256(code)) !== config.codeSha256)
    throw new Error("Deployed program bytes differ from reviewed digest");
  const info = object(
    await rpc(config, "getAccountInfo", [
      config.projectPda,
      { commitment: "finalized", encoding: "base64" },
    ]),
  );
  const project = account(
    info.value,
    config.programId,
    249,
    "cda8bdcab5f78e13",
  );
  if (
    pubkey(project, 8) !== config.owner ||
    pubkey(project, 104) !== config.identityAuthority ||
    pubkey(project, 136) !== config.feeRecipient ||
    pubkey(project, 168) !== config.mint ||
    hex(project.slice(72, 104)) !== hex(digest(config.networkDomain))
  )
    throw new Error("Reviewed project authorities or asset mismatch");
  return project;
}

/** Uses finalized RPC, exact Anchor invocation logs and actual SPL token deltas. */
export function solanaPaymentAdapter(
  config: SolanaEscrowConfig,
): PaymentChainAdapter {
  return {
    async verifyFinalized(input) {
      if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0)
        throw new Error("Invalid log index");
      if (decodeBase58Bytes(input.transactionId).length !== 64)
        throw new Error("Invalid signature");
      const reviewedProject = await verifySolanaDeployment(config);
      const status = object(
        await rpc(config, "getSignatureStatuses", [
          [input.transactionId],
          { searchTransactionHistory: true },
        ]),
      );
      const statusValue = object(list(status.value)[0]);
      if (
        statusValue.err !== null ||
        statusValue.confirmationStatus !== "finalized"
      )
        throw new Error("Transaction not finalized");
      const tx = object(
        await rpc(config, "getTransaction", [
          input.transactionId,
          {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ]),
      );
      const meta = object(tx.meta),
        transaction = object(tx.transaction);
      if (
        meta.err !== null ||
        list(transaction.signatures)[0] !== input.transactionId ||
        tx.slot !== statusValue.slot
      )
        throw new Error("Transaction mismatch");
      const logs = list(meta.logMessages).map(string);
      const stack: string[] = [];
      let payload: Uint8Array | undefined;
      for (let i = 0; i < logs.length; i++) {
        const line = logs[i],
          invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line),
          end = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
        if (invoke) stack.push(invoke[1]);
        if (
          i === input.eventIndex &&
          stack.at(-1) === config.programId &&
          line.startsWith("Program data: ")
        )
          payload = decode(line.slice(14));
        if (end) {
          if (stack.pop() !== end[1])
            throw new Error("Invalid invocation stack");
        }
      }
      const discriminator =
        input.kind === "reserved" ? "140fcba476acd0cb" : "8e7aeab516affa91";
      if (payload?.length !== 136 || hex(payload.slice(0, 8)) !== discriminator)
        throw new Error("Exact escrow event missing");
      const award = digest(input.obligationId),
        projectOffset = input.kind === "reserved" ? 48 : 16,
        awardOffset = input.kind === "reserved" ? 80 : 48;
      if (
        pubkey(payload, projectOffset) !== config.projectPda ||
        hex(payload.slice(awardOffset, awardOffset + 32)) !== hex(award)
      )
        throw new Error("Wrong event project or award");
      const found = list(
        await rpc(config, "getProgramAccounts", [
          config.programId,
          {
            commitment: "finalized",
            encoding: "base64",
            filters: [
              { dataSize: 137 },
              { memcmp: { offset: 48, bytes: config.projectPda } },
              { memcmp: { offset: 80, bytes: b64(award), encoding: "base64" } },
            ],
          },
        ]),
      );
      if (found.length !== 1)
        throw new Error("Ambiguous or missing durable award");
      const obligation = account(
        object(found[0]).account,
        config.programId,
        137,
        "a8ce8d6a584caca7",
      );
      const gross = uint(obligation, 8),
        actor = uint(obligation, 112),
        net = uint(obligation, 120),
        fee = uint(obligation, 128),
        source = hex(obligation.slice(16, 48));
      if (
        gross === 0n ||
        actor === 0n ||
        gross !== net + fee ||
        fee !== gross / 50n ||
        uint(payload, 8) !== gross
      )
        throw new Error("Invalid award accounting");
      if (
        input.kind === "reserved" &&
        (hex(payload.slice(16, 48)) !== source ||
          uint(payload, 112) !== actor ||
          uint(payload, 120) !== net ||
          uint(payload, 128) !== fee)
      )
        throw new Error("Reservation differs from award");
      const project = reviewedProject;
      let destination: string | undefined;
      if (input.kind === "paid") {
        if (
          obligation[136] !== 1 ||
          uint(payload, 80) !== net ||
          uint(payload, 88) !== fee ||
          uint(payload, 128) === 0n
        )
          throw new Error("Paid event differs from obligation");
        destination = pubkey(payload, 96);
        const feeOwner = pubkey(project, 136),
          keys = list(object(transaction.message).accountKeys).map((entry) =>
            string(object(entry).pubkey),
          );
        const before = list(meta.preTokenBalances).map(object),
          after = list(meta.postTokenBalances).map(object);
        const expected = new Map<string, bigint>();
        expected.set(destination, net);
        expected.set(feeOwner, (expected.get(feeOwner) ?? 0n) + fee);
        let vaultSeen = false;
        for (const post of after) {
          const pre = before.find(
            (item) => item.accountIndex === post.accountIndex,
          );
          const a = pre
              ? object(pre.uiTokenAmount)
              : { amount: "0", decimals: 6 },
            b = object(post.uiTokenAmount),
            delta = BigInt(string(b.amount)) - BigInt(string(a.amount));
          if (delta === 0n) continue;
          if (
            (pre !== undefined && pre.mint !== config.mint) ||
            post.mint !== config.mint ||
            a.decimals !== 6 ||
            b.decimals !== 6 ||
            (pre !== undefined && pre.owner !== post.owner)
          )
            throw new Error("Wrong token movement");
          const index = post.accountIndex;
          if (typeof index !== "number" || !Number.isSafeInteger(index))
            throw new Error("Invalid account index");
          if (keys[index] === config.vault) {
            if (delta !== -gross || post.owner !== config.projectPda)
              throw new Error("Wrong vault debit");
            vaultSeen = true;
          } else {
            const owner = string(post.owner);
            if (delta < 0n || !expected.has(owner))
              throw new Error("Unexpected token recipient");
            expected.set(owner, (expected.get(owner) ?? 0n) - delta);
          }
        }
        if (
          !vaultSeen ||
          [...expected.values()].some((amount) => amount !== 0n)
        )
          throw new Error("Unreconciled payout deltas");
      }
      const block = object(
        await rpc(config, "getBlock", [
          tx.slot,
          {
            commitment: "finalized",
            transactionDetails: "none",
            rewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ]),
      );
      return {
        kind: input.kind,
        transactionId: input.transactionId,
        eventIndex: input.eventIndex,
        blockId: string(block.blockhash),
        obligationId: input.obligationId,
        projectId: config.projectId,
        network: config.network,
        chain: "solana",
        vault: config.vault,
        githubUserId: actor.toString(),
        grossMicro: gross.toString(),
        netMicro: net.toString(),
        feeMicro: fee.toString(),
        sourceDigest: source,
        ...(destination ? { destination } : {}),
      };
    },
  };
}

export {
  account as solanaAccount,
  base58 as solanaBase58,
  digest as solanaDigest,
  pubkey as solanaPubkey,
  rpc as solanaRpc,
  uint as solanaUint,
};
