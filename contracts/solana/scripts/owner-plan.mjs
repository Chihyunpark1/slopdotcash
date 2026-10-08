#!/usr/bin/env node
import { createHash } from "node:crypto";
/** Read-only owner transaction planner. No key file, signing or broadcasting. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const { Program, BN } = anchor;
const hash = (value) => {
  if (typeof value !== "string" || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(value))
    throw new Error("Expected 32-byte digest");
  return [...Buffer.from(value.replace(/^0x/, ""), "hex")];
};
const amount = (value) => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error("Expected positive u64 decimal amount");
  return new BN(value);
};
export async function ownerPlan(input, runtime) {
  const d = input.deployment,
    connection = new Connection(runtime.rpcUrl, "finalized");
  if (
    typeof runtime.expectedGenesis !== "string" ||
    (await connection.getGenesisHash()) !== runtime.expectedGenesis
  )
    throw new Error("Wrong cluster genesis");
  const idl = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../idl/slop_escrow.json", import.meta.url)),
    ),
  );
  if (idl.address !== d.programId)
    throw new Error("IDL program identity mismatch");
  const program = new Program(idl, { connection }),
    owner = new PublicKey(d.owner),
    project = new PublicKey(d.projectPda),
    mint = new PublicKey(d.asset),
    vault = new PublicKey(d.vault);
  const pda = (...seeds) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  if (!pda(Buffer.from("vault"), project.toBuffer()).equals(vault))
    throw new Error("Wrong vault PDA");
  const deployed = await connection.getAccountInfo(
    program.programId,
    "finalized",
  );
  if (!deployed?.executable) throw new Error("Program is not executable");
  let executable = deployed.data;
  if (
    deployed.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111"
  ) {
    if (executable.length !== 36 || executable.readUInt32LE(0) !== 2)
      throw new Error("Invalid program pointer");
    const data = await connection.getAccountInfo(
      new PublicKey(executable.subarray(4, 36)),
      "finalized",
    );
    if (
      !data?.owner.equals(deployed.owner) ||
      data.executable ||
      data.data.length <= 45 ||
      data.data.readUInt32LE(0) !== 3 ||
      data.data[12] > 1
    )
      throw new Error("Invalid ProgramData");
    const authority =
      data.data[12] === 1
        ? new PublicKey(data.data.subarray(13, 45)).toBase58()
        : null;
    if (authority !== d.upgradeAuthority)
      throw new Error("Upgrade authority mismatch");
    executable = data.data.subarray(45);
  } else if (
    deployed.owner.toBase58() !==
      "BPFLoader2111111111111111111111111111111111" ||
    d.upgradeAuthority !== null
  )
    throw new Error("Unsupported loader");
  if (createHash("sha256").update(executable).digest("hex") !== d.codeSha256)
    throw new Error("Reviewed program digest mismatch");
  const instructions = [];
  if (input.operation === "initialize") {
    if (
      !pda(
        Buffer.from("project"),
        owner.toBuffer(),
        Buffer.from(hash(input.projectDigest)),
      ).equals(project)
    )
      throw new Error("Wrong project PDA");
    instructions.push(
      await program.methods
        .initialize(
          hash(input.projectDigest),
          hash(d.networkDomain),
          new PublicKey(d.identityAuthority),
          new PublicKey(d.feeRecipient),
        )
        .accountsStrict({
          owner,
          project,
          mint,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
  } else {
    const state = await program.account.project.fetch(project, "finalized");
    if (
      !state.owner.equals(owner) ||
      !state.mint.equals(mint) ||
      !state.identityAuthority.equals(new PublicKey(d.identityAuthority)) ||
      !state.feeRecipient.equals(new PublicKey(d.feeRecipient)) ||
      !Buffer.from(state.network).equals(Buffer.from(hash(d.networkDomain)))
    )
      throw new Error("Reviewed project configuration mismatch");
    if (input.operation === "deposit")
      instructions.push(
        await program.methods
          .deposit(amount(input.grossMicro))
          .accountsStrict({
            owner,
            project,
            mint,
            vault,
            source: getAssociatedTokenAddressSync(mint, owner),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
    else if (input.operation === "withdraw")
      instructions.push(
        await program.methods
          .withdraw(amount(input.grossMicro))
          .accountsStrict({
            owner,
            project,
            mint,
            vault,
            destination: getAssociatedTokenAddressSync(mint, owner),
            feeAccount: getAssociatedTokenAddressSync(
              mint,
              new PublicKey(d.feeRecipient),
              true,
            ),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
    else if (input.operation === "commit") {
      if (
        !Array.isArray(input.awards) ||
        input.awards.length < 1 ||
        input.awards.length > 3
      )
        throw new Error("Commit 1 to 3 awards per unsigned transaction");
      for (const award of input.awards) {
        const awardId = hash(award.awardId),
          source = hash(award.sourceDigest);
        instructions.push(
          await program.methods
            .commit(
              awardId,
              source,
              amount(award.githubUserId),
              amount(award.grossMicro),
            )
            .accountsStrict({
              owner,
              project,
              vault,
              obligation: pda(
                Buffer.from("award"),
                project.toBuffer(),
                Buffer.from(awardId),
              ),
              origin: pda(
                Buffer.from("origin"),
                project.toBuffer(),
                Buffer.from(source),
              ),
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        );
      }
    } else throw new Error("Unsupported owner operation");
  }
  const blockhash = new PublicKey(runtime.recentBlockhash).toBase58();
  const transaction = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  }).add(...instructions);
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  if (serialized.length > 1232)
    throw new Error("Split owner plan into smaller transactions");
  return {
    format: "solana-unsigned-legacy-transaction-v1",
    programId: d.programId,
    projectPda: d.projectPda,
    operation: input.operation,
    requiredSigner: owner.toBase58(),
    recentBlockhash: blockhash,
    transactionBase64: serialized.toString("base64"),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: node owner-plan.mjs reviewed-plan-input.json");
  console.log(
    JSON.stringify(
      await ownerPlan(JSON.parse(readFileSync(process.argv[2], "utf8")), {
        rpcUrl: process.env.SLOP_SOLANA_RPC_URL,
        expectedGenesis: process.env.SLOP_SOLANA_GENESIS,
        recentBlockhash: process.env.SLOP_SOLANA_RECENT_BLOCKHASH,
      }),
      null,
      2,
    ),
  );
}
