/** Tests exact unsigned Solana USDC plans and tamper rejection. */

import { describe, expect, it, vi } from "vitest";
import { assertRewardAllocationManifest } from "./rewards";
import {
  assertNetworkSettlementExecutionPlan,
  assertSettlementExecutionPlan,
  BASE_MAINNET_USDC_CONTRACT,
  createBaseSettlementExecutionPlan,
  createEip681TransferRequest,
  createSettlementExecutionPlan,
  planCarriesPlatformFee,
  SOLANA_MAINNET_USDC_MINT,
} from "./settlement-plan";
import {
  type VerifyBaseSettlementTransaction,
  verifyRewardSettlementOnchain,
} from "./solana-settlement";

const RECIPIENT = "11111111111111111111111111111111";
const SOURCE = "Vote111111111111111111111111111111111111111";
const OTHER_SOURCE = "SysvarRent111111111111111111111111111111111";
const FEE = "Stake11111111111111111111111111111111111111";
const COMMIT = "a".repeat(40);

function approvedAllocation() {
  return assertRewardAllocationManifest({
    schemaVersion: "1",
    kind: "reward-allocation",
    projectId: "eliza",
    cycleId: "2026-07",
    status: "approved",
    generatedAt: "2026-08-01T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
    contributionWindow: {
      from: "2026-07-07T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    review: {
      days: 14,
      lastMaterialChangeAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-15T00:00:00.000Z",
    },
    currency: "USDC",
    chain: "solana",
    capMinor: "10000000000",
    feeBasisPoints: 100,
    scoringRuleVersion: "gitarmy-v1",
    sourceSnapshotSha256: "b".repeat(64),
    allocations: [
      {
        intentId: "pay_eliza_2026_07_u1",
        actor: { id: "U_1", login: "contributor" },
        score: 100,
        suggestedMinor: "1000000",
        approvedMinor: "1000000",
        state: "approved",
        wallet: {
          address: RECIPIENT,
          chain: "solana",
          observedAt: "2026-08-01T00:00:00.000Z",
          sourceCommit: COMMIT,
          sourceUrl: `https://github.com/contributor/contributor/blob/${COMMIT}/README.md`,
        },
        evidenceEventIds: ["event_1"],
        adjustmentReason: null,
        relatedParty: false,
        platformApproval: null,
      },
    ],
    totals: {
      suggestedMinor: "1000000",
      approvedMinor: "1000000",
      feeMinor: "10000",
    },
  });
}

describe("settlement execution plans", () => {
  function fundedAllocation(instrumentId: string) {
    const allocation = approvedAllocation();
    return assertRewardAllocationManifest({
      ...allocation,
      fundingBasis: {
        cycleId: allocation.cycleId,
        fundingState: "committed",
        committedMinor: allocation.capMinor,
        monthlyCapMinor: allocation.capMinor,
        instrumentId,
      },
    });
  }

  it("binds creation and readback to the frozen Squads vault, not any valid wallet", () => {
    const allocation = fundedAllocation(
      `squads-v4-vault:solana:${RECIPIENT}:0:${SOURCE}`,
    );
    const input = {
      allocation,
      allocationSha256: "c".repeat(64),
      createdAt: "2026-08-15T00:01:00.000Z",
      feeRecipient: FEE,
      sourceOwner: SOURCE,
    };
    const plan = createSettlementExecutionPlan(input);
    expect(assertSettlementExecutionPlan(plan, allocation)).toEqual(plan);
    expect(() =>
      createSettlementExecutionPlan({ ...input, sourceOwner: OTHER_SOURCE }),
    ).toThrow(/source owner must match the frozen funding vault/u);
    expect(() =>
      assertSettlementExecutionPlan(
        { ...plan, sourceOwner: OTHER_SOURCE },
        allocation,
      ),
    ).toThrow(/source owner must match the frozen funding vault/u);
  });

  it.each(["base", "ethereum"])(
    "does not invent a Solana source for a %s stream",
    (network) => {
      const allocation = fundedAllocation(
        `sablier-lockup-v4:${network}:0x${"a".repeat(40)}:1`,
      );
      expect(() =>
        createSettlementExecutionPlan({
          allocation,
          allocationSha256: "c".repeat(64),
          createdAt: "2026-08-15T00:01:00.000Z",
          feeRecipient: FEE,
          sourceOwner: SOURCE,
        }),
      ).toThrow(/requires a frozen Solana Squads funding instrument/u);
    },
  );

  it("includes exact contributor principal and the fee on top", () => {
    const allocation = approvedAllocation();
    const plan = createSettlementExecutionPlan({
      allocation,
      allocationSha256: "c".repeat(64),
      createdAt: "2026-08-15T00:01:00.000Z",
      feeRecipient: FEE,
      sourceOwner: SOURCE,
    });
    expect(plan.token.mint).toBe(SOLANA_MAINNET_USDC_MINT);
    expect(plan.transfers).toHaveLength(2);
    expect(plan.totals).toEqual({
      contributorMinor: "1000000",
      platformFeeMinor: "10000",
      totalMinor: "1010000",
    });
    expect(assertSettlementExecutionPlan(plan, allocation)).toEqual(plan);
  });

  it("carries no fee transfer on a project vault (RFC #500 section 8)", () => {
    const projectVault = `squads-project-vault:solana:${RECIPIENT}:0:${SOURCE}`;
    const twoOfTwo = `squads-v4-vault:solana:${RECIPIENT}:0:${SOURCE}`;
    expect(planCarriesPlatformFee(projectVault)).toBe(false);
    expect(planCarriesPlatformFee(twoOfTwo)).toBe(true);
    expect(planCarriesPlatformFee(undefined)).toBe(true);
    expect(planCarriesPlatformFee(null)).toBe(true);

    const allocation = fundedAllocation(projectVault);
    const input = {
      allocation,
      allocationSha256: "c".repeat(64),
      createdAt: "2026-08-15T00:01:00.000Z",
      feeRecipient: FEE,
      sourceOwner: SOURCE,
    };
    const plan = createSettlementExecutionPlan(input);
    expect(plan.transfers.map((transfer) => transfer.kind)).toEqual([
      "contributor",
    ]);
    expect(plan.totals).toEqual({
      contributorMinor: "1000000",
      platformFeeMinor: "0",
      totalMinor: "1000000",
    });
    // The fee is still due; it is the allocation's, not the vault's.
    expect(allocation.totals.feeMinor).toBe("10000");
    expect(assertSettlementExecutionPlan(plan, allocation)).toEqual(plan);

    // The same allocation on a 2-of-2 vault still ends with the fee transfer,
    // and that plan cannot be read back against the project vault allocation.
    const withFee = createSettlementExecutionPlan({
      ...input,
      allocation: fundedAllocation(twoOfTwo),
    });
    expect(withFee.transfers.map((transfer) => transfer.kind)).toEqual([
      "contributor",
      "platform-fee",
    ]);
    expect(() => assertSettlementExecutionPlan(withFee, allocation)).toThrow(
      /differs from its approved allocation/u,
    );
    // Nor can a fee transfer be appended to a project vault plan by hand.
    expect(() =>
      assertSettlementExecutionPlan(
        {
          ...plan,
          transfers: [...plan.transfers, withFee.transfers[1]],
          totals: withFee.totals,
        },
        allocation,
      ),
    ).toThrow(/differs from its approved allocation/u);
  });

  it("rejects a plan paying the source and any post-generation tampering", () => {
    const allocation = approvedAllocation();
    expect(() =>
      createSettlementExecutionPlan({
        allocation,
        allocationSha256: "c".repeat(64),
        createdAt: "2026-08-15T00:01:00.000Z",
        feeRecipient: FEE,
        sourceOwner: RECIPIENT,
      }),
    ).toThrow(/source wallet/u);

    const plan = createSettlementExecutionPlan({
      allocation,
      allocationSha256: "c".repeat(64),
      createdAt: "2026-08-15T00:01:00.000Z",
      feeRecipient: FEE,
      sourceOwner: SOURCE,
    });
    plan.transfers[0].amountMinor = "1000001";
    expect(() => assertSettlementExecutionPlan(plan, allocation)).toThrow(
      /differs/u,
    );
  });
});

describe("Base settlement execution plans (RFC #472)", () => {
  const BASE_RECIPIENT = `0x${"1".repeat(40)}`;
  const BASE_SOURCE = `0x${"2".repeat(40)}`;
  const BASE_FEE = `0x${"3".repeat(40)}`;
  const STREAM_CONTRACT = "0xc19a09a66887017f603e5df420ed3cb9a5c07c0a";
  const STREAM_ID = `sablier-lockup-v4:base:${STREAM_CONTRACT}:7`;
  const instruments = [
    {
      kind: "sablier-lockup-v4",
      network: "base",
      asset: "USDC",
      contract: STREAM_CONTRACT,
      recipient: BASE_SOURCE,
      streamId: "7",
      deadline: "2026-09-01T00:00:00.000Z",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      replacedAt: null,
    },
  ] as const;

  function baseAllocation(instrumentId = STREAM_ID) {
    const solana = approvedAllocation();
    return assertRewardAllocationManifest({
      ...solana,
      chain: "base",
      fundingBasis: {
        cycleId: solana.cycleId,
        fundingState: "committed",
        committedMinor: solana.capMinor,
        monthlyCapMinor: solana.capMinor,
        instrumentId,
      },
      allocations: solana.allocations.map((row) => ({
        ...row,
        wallet: { ...row.wallet, address: BASE_RECIPIENT, chain: "base" },
      })),
    });
  }

  const input = (allocation = baseAllocation()) => ({
    allocation,
    allocationSha256: "c".repeat(64),
    createdAt: "2026-08-15T00:01:00.000Z",
    feeRecipient: BASE_FEE,
    sourceOwner: BASE_SOURCE,
    fundingInstruments: instruments,
  });

  it("plans exact Base USDC transfers from the frozen stream recipient with a separate fee", () => {
    const allocation = baseAllocation();
    const plan = createBaseSettlementExecutionPlan(input(allocation));
    expect(plan.kind).toBe("base-usdc-transfer-plan");
    expect(plan.chainId).toBe(8453);
    expect(plan.token.contract).toBe(BASE_MAINNET_USDC_CONTRACT);
    expect(plan.transfers.map((transfer) => transfer.kind)).toEqual([
      "contributor",
      "platform-fee",
    ]);
    expect(plan.totals).toEqual({
      contributorMinor: "1000000",
      platformFeeMinor: "10000",
      totalMinor: "1010000",
    });
    expect(
      assertNetworkSettlementExecutionPlan(plan, allocation, instruments),
    ).toEqual(plan);
    expect(createEip681TransferRequest(plan, plan.transfers[0])).toBe(
      `ethereum:${BASE_MAINNET_USDC_CONTRACT}@8453/transfer?address=${BASE_RECIPIENT}&uint256=1000000`,
    );
    expect(createEip681TransferRequest(plan, plan.transfers[1])).toBe(
      `ethereum:${BASE_MAINNET_USDC_CONTRACT}@8453/transfer?address=${BASE_FEE}&uint256=10000`,
    );
  });

  it("refuses another source, a non-Base basis, or a plan on the wrong network", () => {
    expect(() =>
      createBaseSettlementExecutionPlan({
        ...input(),
        sourceOwner: BASE_FEE,
      }),
    ).toThrow(/frozen stream recipient/u);
    for (const instrumentId of [
      `sablier-lockup-v4:ethereum:${STREAM_CONTRACT}:7`,
      `squads-v4-vault:solana:${RECIPIENT}:0:${SOURCE}`,
    ]) {
      expect(() =>
        createBaseSettlementExecutionPlan(input(baseAllocation(instrumentId))),
      ).toThrow(/frozen Base Sablier funding instrument/u);
    }
    expect(() =>
      createBaseSettlementExecutionPlan({ ...input(), fundingInstruments: [] }),
    ).toThrow(/not in the project manifest/u);
    expect(() =>
      createSettlementExecutionPlan({ ...input(), sourceOwner: SOURCE }),
    ).toThrow(/settles on base, not solana/u);
    expect(() =>
      createBaseSettlementExecutionPlan({
        ...input(approvedAllocation()),
      }),
    ).toThrow(/settles on solana, not base/u);
  });

  it("marks a Base cycle paid only when every intent and the fee reconcile after the plan", async () => {
    const allocation = baseAllocation();
    const plan = createBaseSettlementExecutionPlan(input(allocation));
    const payout = `0x${"a".repeat(64)}`;
    const fee = `0x${"b".repeat(64)}`;
    const planTime = Date.parse(plan.createdAt) / 1_000;
    const settlement = (platformFeeSignature: string | null) => ({
      schemaVersion: "1",
      kind: "reward-settlement",
      projectId: allocation.projectId,
      cycleId: allocation.cycleId,
      allocationSha256: plan.allocationSha256,
      settledAt: "2026-08-16T00:00:00.000Z",
      currency: "USDC",
      chain: "base",
      status: "paid",
      recipients: [
        {
          intentId: "pay_eliza_2026_07_u1",
          approvedMinor: "1000000",
          paidMinor: "1000000",
          state: "paid",
        },
      ],
      attempts: [
        {
          attemptId: "attempt_base_1",
          intentIds: ["pay_eliza_2026_07_u1"],
          signature: payout,
          state: "finalized",
        },
      ],
      platformFee: {
        recipient: BASE_FEE,
        dueMinor: "10000",
        paidMinor: "10000",
        signature: platformFeeSignature,
        state: "paid",
      },
      totals: {
        approvedMinor: "1000000",
        paidMinor: "1000000",
        feeMinor: "10000",
      },
    });
    const verifyBaseTransaction = vi.fn(
      async (request: { transactionHash: string }) => ({
        blockTime: planTime + 60,
        transactionHash: request.transactionHash,
      }),
    );
    const verify = (
      value: unknown,
      verifier: VerifyBaseSettlementTransaction = verifyBaseTransaction,
    ) =>
      verifyRewardSettlementOnchain({
        allocation,
        expectedAllocationSha256: plan.allocationSha256,
        fundingInstruments: instruments,
        plan,
        settlement: value,
        verifyBaseTransaction: verifier,
      });

    await expect(verify(settlement(fee))).resolves.toHaveLength(2);
    expect(verifyBaseTransaction).toHaveBeenCalledWith({
      source: BASE_SOURCE,
      transactionHash: payout,
      transfers: [{ recipient: BASE_RECIPIENT, amountMinor: "1000000" }],
    });
    expect(verifyBaseTransaction).toHaveBeenCalledWith({
      source: BASE_SOURCE,
      transactionHash: fee,
      transfers: [{ recipient: BASE_FEE, amountMinor: "10000" }],
    });
    // The fee is part of `paid`; a missing fee transfer is not a paid cycle.
    await expect(verify(settlement(null))).rejects.toThrow(
      /paid platform fee must be exact and signed/u,
    );
    // The fee and a payout cannot share one hash.
    await expect(verify(settlement(payout))).rejects.toThrow(/reuse/u);
    // A Solana signature is not Base evidence.
    await expect(verify(settlement("4".repeat(88)))).rejects.toThrow(
      /Base transaction hash/u,
    );
    // An older transfer with equal amounts cannot be replayed into this plan.
    await expect(
      verify(settlement(fee), async (request) => ({
        blockTime: planTime - 1,
        transactionHash: request.transactionHash,
      })),
    ).rejects.toThrow(/predates its plan/u);
    // Wrong token, partial, or overpaid transfers fail inside the verifier.
    await expect(
      verify(settlement(fee), async () => {
        throw new TypeError("EVM source USDC debit is not exact");
      }),
    ).rejects.toThrow(/debit is not exact/u);
  });

  it("rejects a Solana wallet in a Base cycle and a tampered stored plan", () => {
    const allocation = baseAllocation();
    expect(() =>
      assertRewardAllocationManifest({
        ...allocation,
        allocations: approvedAllocation().allocations,
      }),
    ).toThrow(/chain must be base/u);
    const plan = createBaseSettlementExecutionPlan(input(allocation));
    expect(() =>
      assertNetworkSettlementExecutionPlan(
        { ...plan, token: { ...plan.token, contract: `0x${"4".repeat(40)}` } },
        allocation,
        instruments,
      ),
    ).toThrow(/token identity/u);
    expect(() =>
      assertNetworkSettlementExecutionPlan(
        {
          ...plan,
          transfers: [
            plan.transfers[0],
            { ...plan.transfers[1], amountMinor: "1" },
          ],
        },
        allocation,
        instruments,
      ),
    ).toThrow(/differs/u);
  });
});
