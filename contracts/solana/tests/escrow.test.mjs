import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  freezeAccount,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  thawAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { solanaPaymentAdapter } from "../.local/adapter.mjs";

const { AnchorProvider, Program, BN } = anchor;
const provider = AnchorProvider.env();
const payer = provider.wallet.payer;
const program = new Program(
  JSON.parse(readFileSync("target/idl/slop_escrow.json")),
  provider,
);
const hash = (s) => [...createHash("sha256").update(s).digest()];
const network = hash("solana:localnet:escrow-v2");
const bn = (x) => new BN(String(x));
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const key = (x) => x.toBuffer();
const seed = (s) => Buffer.from(s);
const actorSeed = (id) => bn(id).toArrayLike(Buffer, "le", 8);
const authority = Keypair.generate();
const feeOwner = Keypair.generate();
const recipient = Keypair.generate();
const late = Keypair.generate();
let mint, source, feeAccount, destination, lateDestination, project, vault;
const binding = (id) =>
  pda(
    seed("wallet"),
    key(authority.publicKey),
    Buffer.from(network),
    actorSeed(id),
  );
const obligation = (id) =>
  pda(seed("award"), key(project), Buffer.from(hash(id)));
async function commit(id, actor, principal, origin = id) {
  return program.methods
    .commit(hash(id), hash(`source:${origin}`), bn(actor), bn(principal))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      vault,
      obligation: obligation(id),
      origin: pda(
        seed("origin"),
        key(project),
        Buffer.from(hash(`source:${origin}`)),
      ),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
async function bind(actor, address, expected = 0, domain = network) {
  return program.methods
    .bindWallet(
      bn(actor),
      domain,
      bn(expected),
      address,
      hash(`claim:${actor}:${expected}`),
    )
    .accountsStrict({
      payer: payer.publicKey,
      identityAuthority: authority.publicKey,
      project,
      binding: binding(actor),
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
}
function pay(id, actor, address, version = 1) {
  return program.methods
    .pay(bn(version))
    .accountsStrict({
      project,
      obligation: obligation(id),
      binding: binding(actor),
      mint,
      vault,
      destination: address,
      feeAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}
function withdraw(amount) {
  return program.methods
    .withdraw(bn(amount))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      destination: source,
      feeAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}
const balance = async (address) =>
  (await getAccount(provider.connection, address)).amount;
test("actual SPL escrow lifecycle, late wallet claim, reserve and authority attacks", async () => {
  mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6,
  );
  source = await createAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
  );
  feeAccount = await createAccount(
    provider.connection,
    payer,
    mint,
    feeOwner.publicKey,
  );
  destination = await createAccount(
    provider.connection,
    payer,
    mint,
    recipient.publicKey,
  );
  lateDestination = await createAccount(
    provider.connection,
    payer,
    mint,
    late.publicKey,
  );
  await mintTo(provider.connection, payer, mint, source, payer, 1_000_000_000n);
  project = pda(
    seed("project"),
    key(payer.publicKey),
    Buffer.from(hash("project")),
  );
  vault = pda(seed("vault"), key(project));
  await program.methods
    .initialize(
      hash("project"),
      network,
      authority.publicKey,
      feeOwner.publicKey,
    )
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await program.methods
    .deposit(bn(1_000_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const firstCommit = await commit("first", 101, 100_000_000);
  await commit("late", 102, 50_000_000);
  assert.equal(
    (await program.account.project.fetch(project)).reserved.toString(),
    "150000000",
  );
  await assert.rejects(withdraw(1_000_000_000), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("overspend", 103, 1_000_000_000),
    /InsufficientFreeBalance/,
  );
  await assert.rejects(
    pay("late", 102, lateDestination),
    /AccountNotInitialized/,
  );
  await bind(101, recipient.publicKey);
  await assert.rejects(bind(101, late.publicKey), /StaleBinding/);
  await assert.rejects(bind(102, late.publicKey, 0, hash("different-network")));
  await assert.rejects(pay("first", 101, lateDestination), /ConstraintRaw/);
  await assert.rejects(
    program.methods
      .bindWallet(bn(101), network, bn(1), late.publicKey, hash("bad-claim"))
      .accountsStrict({
        payer: payer.publicKey,
        identityAuthority: payer.publicKey,
        project,
        binding: binding(101),
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
  await freezeAccount(provider.connection, payer, destination, mint, payer);
  await assert.rejects(pay("first", 101, destination));
  assert.equal(await balance(feeAccount), 0n);
  assert.equal(
    (await program.account.obligation.fetch(obligation("first"))).paid,
    false,
  );
  await thawAccount(provider.connection, payer, destination, mint, payer);
  const firstPayment = await pay("first", 101, destination);
  assert.equal(await balance(destination), 98_000_000n);
  assert.equal(await balance(feeAccount), 2_000_000n);
  await assert.rejects(pay("first", 101, destination), /AlreadyPaid/);
  await assert.rejects(commit("first", 101, 100_000_000));
  await assert.rejects(commit("changed-award-id", 101, 100_000_000, "first"));
  await assert.rejects(
    program.methods
      .withdraw(bn(1))
      .accountsStrict({
        owner: authority.publicKey,
        project,
        mint,
        vault,
        destination: source,
        feeAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc(),
    /ConstraintHasOne/,
  );
  const wrongMint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );
  const wrongDestination = await createAccount(
    provider.connection,
    payer,
    wrongMint,
    late.publicKey,
  );
  await bind(102, late.publicKey);
  await assert.rejects(
    pay("late", 102, wrongDestination),
    /ConstraintTokenMint/,
  );
  // Split withdrawals cannot avoid the cumulative 10% charge.
  await withdraw(1);
  await withdraw(849_999_999);
  assert.equal(await balance(source), 765_000_000n);
  assert.equal(await balance(feeAccount), 87_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  await bind(102, recipient.publicKey, 1);
  await assert.rejects(
    pay("late", 102, lateDestination, 1),
    /StaleBinding|ConstraintRaw/,
  );
  await pay("late", 102, destination, 2);
  assert.equal(await balance(destination), 147_000_000n);
  assert.equal(await balance(feeAccount), 88_000_000n);
  assert.equal(await balance(vault), 0n);
  const state = await program.account.project.fetch(project);
  assert.equal(state.reserved.toString(), "0");
  assert.equal(state.paid.toString(), "147000000");
  assert.equal(state.payoutFees.toString(), "3000000");
  assert.equal(state.withdrawalFees.toString(), "85000000");
  assert.equal(
    (await balance(source)) +
      (await balance(destination)) +
      (await balance(feeAccount)) +
      (await balance(vault)),
    1_000_000_000n,
  );
  await provider.connection.confirmTransaction(firstPayment, "finalized");
  const evidence = {
    programId: program.programId.toBase58(),
    genesisHash: await provider.connection.getGenesisHash(),
    signature: firstPayment,
    project: project.toBase58(),
    awardId: Buffer.from(hash("first")).toString("hex"),
    sourceDigest: Buffer.from(hash("source:first")).toString("hex"),
    actorId: 101,
    gross: "100000000",
    principal: "98000000",
    fee: "2000000",
    walletVersion: 1,
    destinationOwner: recipient.publicKey.toBase58(),
    destinationAccount: destination.toBase58(),
    vault: vault.toBase58(),
    feeAccount: feeAccount.toBase58(),
    mint: mint.toBase58(),
    network: Buffer.from(network).toString("hex"),
  };
  const workerAdapter = solanaPaymentAdapter({
    rpcUrl: provider.connection.rpcEndpoint,
    genesisHash: evidence.genesisHash,
    programId: evidence.programId,
    projectPda: evidence.project,
    projectId: "local-project",
    network: "solana:localnet",
    networkDomain: evidence.network,
    vault: evidence.vault,
    mint: evidence.mint,
    owner: payer.publicKey.toBase58(),
    identityAuthority: authority.publicKey.toBase58(),
    feeRecipient: feeOwner.publicKey.toBase58(),
    codeSha256: createHash("sha256")
      .update(readFileSync("target/deploy/slop_escrow.so"))
      .digest("hex"),
    upgradeAuthority: "11111111111111111111111111111111",
  });
  for (const [signature, kind, disc] of [
    [firstCommit, "reserved", [20, 15, 203, 164, 118, 172, 208, 203]],
    [firstPayment, "paid", [142, 122, 234, 181, 22, 175, 250, 145]],
  ]) {
    const receipt = await provider.connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    const eventIndex = receipt.meta.logMessages.findIndex(
      (line) =>
        line.startsWith("Program data: ") &&
        Buffer.from(line.slice(14), "base64")
          .subarray(0, 8)
          .equals(Buffer.from(disc)),
    );
    const input = {
      transactionId: signature,
      eventIndex,
      kind,
      obligationId: evidence.awardId,
    };
    const normalized = await workerAdapter.verifyFinalized(input);
    assert.equal(normalized.grossMicro, "100000000");
    assert.equal(normalized.netMicro, "98000000");
    assert.equal(normalized.githubUserId, "101");
    await assert.rejects(
      workerAdapter.verifyFinalized({ ...input, eventIndex: 0 }),
      /Exact escrow event/,
    );
  }
  await mintTo(provider.connection, payer, mint, vault, payer, 1_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("unsolicited", 105, 1),
    /InsufficientFreeBalance/,
  );
  assert.equal(await balance(vault), 1_000_000n);
});
