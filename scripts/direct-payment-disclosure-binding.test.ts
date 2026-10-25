/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Disclosure,
  verifyDisclosure,
} from "./check-direct-payment-disclosures";

// A disclosure is bound to its frozen preparation by digest. The project,
// month and contributor set it publishes must be the preparation's own, because
// prepare-payments-import writes the observed rows under the disclosure's
// projectId and contributionMonth into an append-only table.
const root = resolve(import.meta.dir, "../tests/fixtures/history");

function load(name: string) {
  const disclosure = JSON.parse(
    readFileSync(resolve(root, "disclosures", name), "utf8"),
  ) as Disclosure;
  const preparationBytes = readFileSync(
    resolve(root, disclosure.preparation.path),
  );
  return { disclosure, preparationBytes };
}

describe("direct-payment disclosure binding", () => {
  it("accepts the checked-in August disclosures", () => {
    for (const name of [
      "asi-2026-08-direct-payments.json",
      "eliza-2026-08-direct-payments.json",
    ]) {
      const { disclosure, preparationBytes } = load(name);
      expect(verifyDisclosure(disclosure, preparationBytes)).toEqual([]);
    }
  });

  it("refuses a project or month the preparation does not name", () => {
    const { disclosure, preparationBytes } = load(
      "eliza-2026-08-direct-payments.json",
    );
    const relabeled = {
      ...disclosure,
      projectId: "asi",
      contributionMonth: "2026-09",
    };
    expect(verifyDisclosure(relabeled, preparationBytes)).toEqual([
      "projectId asi does not match the preparation's eliza",
      "contributionMonth 2026-09 does not match the preparation's 2026-08",
    ]);
  });

  it("refuses a repeated contributor that takes another contributor's row", () => {
    const { disclosure, preparationBytes } = load(
      "eliza-2026-08-direct-payments.json",
    );
    const kept = disclosure.rows.find((row) => row.login === "ADWilkinson");
    const dropped = disclosure.rows.find((row) => row.login === "gblinproject");
    if (!kept || !dropped) throw new Error("fixture rows missing");
    // Equal weights keep every row count and amount total unchanged.
    expect(dropped.publishedWeight).toBe(kept.publishedWeight);
    expect(dropped.state).toBe(kept.state);
    const repeated = {
      ...disclosure,
      rows: disclosure.rows.map((row) => (row === dropped ? kept : row)),
    };
    expect(verifyDisclosure(repeated, preparationBytes)).toEqual([
      `row ADWilkinson repeats contributor ${kept.actorId}`,
      "preparation contributor gblinproject has no row",
    ]);
  });

  it("refuses a denominator the rows do not add up to", () => {
    const preparation = {
      projectId: "demo",
      cycleId: "2026-10",
      counts: { weight: "4" },
      contributors: [
        { actor: { id: "1", login: "alice" }, weight: "3", wallet: null },
        { actor: { id: "2", login: "bob" }, weight: "1", wallet: null },
      ],
    };
    const preparationBytes = new TextEncoder().encode(
      JSON.stringify(preparation),
    );
    const sha256 = createHash("sha256").update(preparationBytes).digest("hex");
    const base: Disclosure = {
      schemaVersion: "1",
      kind: "direct-payment-disclosure",
      projectId: "demo",
      contributionMonth: "2026-10",
      preparation: { path: "prep.json", sha256, totalWeight: "4" },
      reconstructedBasis: {
        capMinor: "1000",
        denominatorWeight: "8",
        rounding: "half-up",
        allocatedMinor: "500",
        overCapMinor: "-500",
      },
      totals: {
        rows: 2,
        observedTransfers: 0,
        observedAmountMinor: "0",
        allocatedMinor: "500",
        byState: {
          "held-below-minimum": { rows: 2, amountMinor: "500" },
        },
      },
      rows: [
        {
          actorId: "1",
          login: "alice",
          publishedWeight: "3",
          effectiveWeight: "3",
          entitlementMinor: "375",
          wallet: null,
          state: "held-below-minimum",
          observed: null,
        },
        {
          actorId: "2",
          login: "bob",
          publishedWeight: "1",
          effectiveWeight: "1",
          entitlementMinor: "125",
          wallet: null,
          state: "held-below-minimum",
          observed: null,
        },
      ],
    };
    // Halved entitlements reproduce against the wrong denominator.
    expect(verifyDisclosure(base, preparationBytes)).toEqual([
      "reconstructedBasis.denominatorWeight 8 matches neither the preparation totalWeight 4 nor the sum of effective weights 4",
    ]);
    const correct: Disclosure = {
      ...base,
      reconstructedBasis: {
        capMinor: "1000",
        denominatorWeight: "4",
        rounding: "half-up",
        allocatedMinor: "1000",
        overCapMinor: "0",
      },
      totals: {
        ...base.totals,
        allocatedMinor: "1000",
        byState: {
          "held-below-minimum": { rows: 2, amountMinor: "1000" },
        },
      },
      rows: [
        { ...base.rows[0], entitlementMinor: "750" },
        { ...base.rows[1], entitlementMinor: "250" },
      ],
    };
    expect(verifyDisclosure(correct, preparationBytes)).toEqual([]);
  });
});
