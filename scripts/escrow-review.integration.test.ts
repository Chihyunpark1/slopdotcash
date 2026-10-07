import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertEscrowDecisions, verifyEscrowReview } from "./escrow-review";

// Boundary test with real archive files and explicit GitHub response fixtures.
// This is not a claim of real public publication or human approval.
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(mergedAt: string) {
  const directory = await mkdtemp(join(tmpdir(), "slop-escrow-review-"));
  directories.push(directory);
  const proposal = {
    projectId: "fixture",
    cycleId: "2026-08",
    grossCapMicro: "100000000",
    awards: [
      {
        githubUserId: "123",
        grossMicro: "100000000",
        sourceDigest: "a".repeat(64),
      },
    ],
    generatedAt: "2026-09-01T00:00:00.000Z",
  };
  const proposalBytes = Buffer.from(JSON.stringify(proposal));
  const proposalSha256 = createHash("sha256")
    .update(proposalBytes)
    .digest("hex");
  const decisions = {
    schemaVersion: "1",
    proposalSha256,
    rows: [
      {
        githubUserId: "123",
        state: "approved",
        approvedGrossMicro: "100000000",
        adjustmentReason: null,
        relatedParty: false,
      },
    ],
  };
  const files = new Map([
    ["proposal.json", proposalBytes],
    ["decisions.json", Buffer.from(JSON.stringify(decisions))],
    ["source-snapshot.json", Buffer.from('{"fixture":true}')],
    ["github-identities.json", Buffer.from("[]")],
    ["project.json", Buffer.from("{}")],
  ]);
  for (const [name, bytes] of files)
    await writeFile(join(directory, name), bytes);
  const commit = "a".repeat(40),
    merge = "b".repeat(40),
    head = "c".repeat(40);
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const repository = url.pathname.split("/").slice(2, 4).join("/");
    const path = url.pathname.split("/").slice(4).join("/");
    if (path === "commits") return Response.json([{ sha: commit }]);
    if (path.startsWith("contents/")) {
      const name = path.split("/").at(-1) ?? "";
      const bytes = files.get(name);
      return bytes
        ? new Response(bytes)
        : new Response("missing", { status: 404 });
    }
    if (path === `commits/${commit}/pulls`)
      return Response.json([
        {
          number: 1,
          merged_at: mergedAt,
          merge_commit_sha: merge,
          head: { sha: head },
          base: { ref: "develop", repo: { full_name: repository } },
        },
      ]);
    if (path === `compare/${commit}...${head}`)
      return Response.json({ status: "ahead" });
    throw new Error(`Unexpected fixture route ${path}`);
  });
  return {
    directory,
    proposal,
    proposalSha256,
    decisions,
    files,
    stewardActorId: "999",
    now: new Date("2026-10-06T12:00:00.000Z"),
  };
}
describe("source-bound financial review gate", () => {
  it("uses verified PR merge time, so old proposal timestamps cannot skip public review", async () => {
    const input = await fixture("2026-10-05T12:00:00Z");
    await expect(verifyEscrowReview(input)).rejects.toThrow("14 days");
  });
  it("accepts exact published bytes after the full window and rejects a changed archive", async () => {
    const input = await fixture("2026-09-20T12:00:00Z");
    const result = await verifyEscrowReview(input);
    expect(result.reviewEndsAt).toBe("2026-10-04T12:00:00.000Z");
    expect(result.decisions.rows[0].approvedGrossMicro).toBe("100000000");
    await writeFile(
      join(input.directory, "source-snapshot.json"),
      '{"edited":true}',
    );
    await expect(verifyEscrowReview(input)).rejects.toThrow(
      "public canonical bytes",
    );
  });
  it("does not allow a steward to opt out of related-party review, exceed the cap, or omit an actor", async () => {
    const input = await fixture("2026-09-20T12:00:00Z");
    expect(() =>
      assertEscrowDecisions(
        input.decisions,
        input.proposal,
        input.proposalSha256,
        "123",
      ),
    ).toThrow("related party");
    const held = structuredClone(input.decisions);
    held.rows[0].state = "held";
    expect(() =>
      assertEscrowDecisions(held, input.proposal, input.proposalSha256, "999"),
    ).toThrow("gross amount");
    const oversized = structuredClone(input.decisions);
    oversized.rows[0].approvedGrossMicro = "100000001";
    oversized.rows[0].adjustmentReason = "Reviewed adjustment" as never;
    expect(() =>
      assertEscrowDecisions(
        oversized,
        input.proposal,
        input.proposalSha256,
        "999",
      ),
    ).toThrow("cap");
    expect(() =>
      assertEscrowDecisions(
        { ...input.decisions, rows: [] },
        input.proposal,
        input.proposalSha256,
        "999",
      ),
    ).toThrow("exact proposal");
  });
  it("fails closed when public evidence is unavailable", async () => {
    const input = await fixture("2026-09-20T12:00:00Z");
    vi.stubGlobal(
      "fetch",
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(verifyEscrowReview(input)).rejects.toThrow("unavailable");
  });
});
