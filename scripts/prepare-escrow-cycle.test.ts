import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import eliza from "../projects/eliza/project.json";
import { formatMonthlyCapDisplay } from "../src/lib/project-schema.mjs";
import { snapshotFixture } from "../tests/fixtures";
import { buildEscrowCycle, validateEscrowCycle } from "./prepare-escrow-cycle";

const input = {
  projectId: "eliza",
  cycleId: "2026-07",
  generatedAt: "2026-08-02T00:00:00.000Z",
};
const raw = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture(gross = "100000000") {
  const snapshot = snapshotFixture(input.generatedAt);
  snapshot.window.from = "2026-06-28T00:00:00.000Z";
  snapshot.window.to = input.generatedAt;
  snapshot.source.cutoffAt = snapshot.window.to;
  snapshot.source.verificationWindow = { ...snapshot.window };
  const project = {
    ...structuredClone(eliza),
    escrow: {
      schemaVersion: "1",
      effectiveCycle: "2026-07",
      chain: "base",
      feeBasisPoints: 200,
      withdrawalFeeBasisPoints: 1000,
      feeMode: "deduct-from-gross",
      deployments: [],
    },
    reward: {
      ...eliza.reward,
      chain: "base",
      feeBasisPoints: 200,
      monthlyCapMinor: gross,
      monthlyCapDisplay: formatMonthlyCapDisplay(gross),
    },
  };
  const identities = [
    { nodeId: "U_fixture", githubUserId: "42", login: "finish-line" },
  ];
  return { snapshot, project, identities };
}
function build(value: ReturnType<typeof fixture>) {
  return buildEscrowCycle(
    input,
    raw(value.snapshot),
    raw(value.identities),
    raw(value.project),
  );
}
async function archive(value: ReturnType<typeof fixture>) {
  const directory = await mkdtemp(join(tmpdir(), "escrow-cycle-"));
  directories.push(directory);
  const proposal = build(value);
  for (const [name, data] of Object.entries({
    "source-snapshot.json": value.snapshot,
    "github-identities.json": value.identities,
    "project.json": value.project,
    "proposal.json": proposal,
  }))
    await writeFile(join(directory, name), raw(data));
  return { directory, proposal };
}

describe("source-bound escrow cycle archives", () => {
  it("reconstructs a closed monthly archive with numeric identity and deducted integer fees", async () => {
    const value = fixture();
    const { directory, proposal } = await archive(value);
    const validated = await validateEscrowCycle(
      directory,
      input.projectId,
      input.cycleId,
    );
    expect(validated.proposal).toEqual(proposal);
    expect(validated.digest).toBe(
      hash(await readFile(join(directory, "proposal.json"))),
    );
    expect(proposal).toMatchObject({
      status: "under-review",
      chain: "base",
      grossCapMicro: "100000000",
      feeMode: "deduct-from-gross",
      reviewEndsAt: "2026-08-16T00:00:00.000Z",
      sourceSnapshotSha256: hash(raw(value.snapshot)),
      githubIdentitiesSha256: hash(raw(value.identities)),
      projectPolicySha256: hash(raw(value.project)),
    });
    expect(proposal.awards).toHaveLength(1);
    expect(proposal.awards[0]).toMatchObject({
      githubUserId: "42",
      githubNodeId: "U_fixture",
      grossMicro: "100000000",
      feeMicro: "2000000",
      netMicro: "98000000",
    });
    expect(proposal.awards[0].evidenceEventIds.length).toBeGreaterThan(0);
  });

  it("preserves the replay origin across independently reconstructed amount and snapshot revisions", () => {
    const original = build(fixture());
    const revised = fixture("200010000");
    revised.snapshot.source.requestCount += 1;
    const rebuilt = build(revised);
    expect(rebuilt.awards[0].grossMicro).toBe("200010000");
    expect(rebuilt.awards[0].feeMicro).toBe("4000200");
    expect(rebuilt.awards[0].netMicro).toBe("196009800");
    expect(rebuilt.sourceSnapshotSha256).not.toBe(
      original.sourceSnapshotSha256,
    );
    expect(rebuilt.projectPolicySha256).not.toBe(original.projectPolicySha256);
    expect(rebuilt.awards[0].sourceDigest).toBe(
      original.awards[0].sourceDigest,
    );
    revised.identities[0].githubUserId = "43";
    expect(build(revised).awards[0].sourceDigest).not.toBe(
      original.awards[0].sourceDigest,
    );
  });

  it("uses frozen policy rather than today's different chain, fee and cap", async () => {
    const value = fixture();
    expect(eliza.reward.chain).not.toBe(value.project.reward.chain);
    expect(eliza.reward.feeBasisPoints).not.toBe(
      value.project.reward.feeBasisPoints,
    );
    expect(eliza.reward.monthlyCapMinor).not.toBe(
      value.project.reward.monthlyCapMinor,
    );
    const { directory, proposal } = await archive(value);
    expect(
      (await validateEscrowCycle(directory, input.projectId, input.cycleId))
        .proposal,
    ).toEqual(proposal);
  });

  it("rejects edited allocations, identity evidence and archived policy", async () => {
    const value = fixture();
    const { directory, proposal } = await archive(value);
    await writeFile(
      join(directory, "proposal.json"),
      raw({ ...proposal, awards: [{ ...proposal.awards[0], netMicro: "1" }] }),
    );
    await expect(
      validateEscrowCycle(directory, input.projectId, input.cycleId),
    ).rejects.toThrow(/differs/);
    await writeFile(join(directory, "proposal.json"), raw(proposal));
    value.identities[0].githubUserId = "43";
    await writeFile(
      join(directory, "github-identities.json"),
      raw(value.identities),
    );
    await expect(
      validateEscrowCycle(directory, input.projectId, input.cycleId),
    ).rejects.toThrow(/differs/);
    value.identities[0].githubUserId = "42";
    await writeFile(
      join(directory, "github-identities.json"),
      raw(value.identities),
    );
    value.project.reward.monthlyCapMinor = "500000000";
    value.project.reward.monthlyCapDisplay = "$500";
    await writeFile(join(directory, "project.json"), raw(value.project));
    await expect(
      validateEscrowCycle(directory, input.projectId, input.cycleId),
    ).rejects.toThrow(/differs/);
  });

  it("rejects incomplete monthly evidence and missing numeric actor coverage", () => {
    const value = fixture();
    value.snapshot.source.verificationWindow.from = "2026-07-10T00:00:00.000Z";
    expect(() => build(value)).toThrow();
    const missing = fixture();
    missing.identities = [];
    expect(() => build(missing)).toThrow(/coverage/);
    const wrong = fixture();
    wrong.identities[0].nodeId = "U_other";
    expect(() => build(wrong)).toThrow(/Missing numeric/);
  });
});
