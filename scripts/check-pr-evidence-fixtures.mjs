/** Existing evidence-policy scenarios shared by the CLI compatibility check and test runner. */
const RETIRED_REPO_EVIDENCE_PATH = ".github/issue-evidence";

function buildFixtureBody(
  REQUIRED_EVIDENCE_ROWS,
  SURFACE_OCR_EVIDENCE_ROW,
  overrides = {},
) {
  const defaults = {
    "before-screenshots":
      "- [ ] Before screenshots `N/A - backend-only change, no UI surface`.",
    "after-screenshots":
      "- [ ] After screenshots `N/A - backend-only change, no UI surface`.",
    "walkthrough-video":
      "- [x] A video walkthrough: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
    "backend-logs":
      "- [ ] Backend logs: [backend.txt](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001)",
    "frontend-logs": "- [ ] Frontend logs `N/A - no frontend change`.",
    "llm-trajectory":
      "- [ ] Real-LLM trajectory: [report](https://github.com/elizaOS/eliza/releases/download/pr-evidence/fixture-trajectory.json)",
    "domain-artifacts":
      "- [ ] Domain artifacts: [export](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000007)",
    "ocr-review":
      "- [ ] OCR review `N/A - backend-only change has no rendered visual surface`.",
  };
  const merged = { ...defaults, ...overrides };
  return [...REQUIRED_EVIDENCE_ROWS, SURFACE_OCR_EVIDENCE_ROW]
    .map(({ id }) => `<!-- evidence-row:${id} -->\n${merged[id] ?? ""}`)
    .join("\n\n");
}

export function runSelfTest({
  evaluatePrEvidence,
  findRetiredRepoEvidenceFiles,
  inspectEvidenceHead,
  REQUIRED_EVIDENCE_ROWS,
  SURFACE_ARTIFACT_ROW_IDS,
  SURFACE_OCR_EVIDENCE_ROW,
}) {
  const body = (overrides) =>
    buildFixtureBody(
      REQUIRED_EVIDENCE_ROWS,
      SURFACE_OCR_EVIDENCE_ROW,
      overrides,
    );
  const failures = [];

  {
    const expected = "0835c66b420cebd18c693deb98d8b181c0a30faa";
    const exact = inspectEvidenceHead(
      `<!-- evidence-head:${expected} -->`,
      expected,
    );
    const reconstructed = inspectEvidenceHead(
      "<!-- evidence-head:0835c66b42b6a22fdfbf9fc7ea7d1be7b11d615f -->",
      expected,
    );
    const unrelated = inspectEvidenceHead(
      "<!-- evidence-head:ffffffffffffffffffffffffffffffffffffffff -->",
      expected,
    );
    if (!exact.ok) failures.push("exact evidence head should pass");
    if (reconstructed.status !== "likely-short-sha-reconstruction") {
      failures.push(
        "shared short-SHA prefix should receive a specific diagnostic",
      );
    }
    if (unrelated.status !== "head-mismatch") {
      failures.push(
        "unrelated evidence head should retain the generic diagnostic",
      );
    }
  }

  {
    const { ok } = evaluatePrEvidence(body());
    if (!ok) failures.push("all-filled fixture should pass");
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      body({
        "backend-logs":
          "- [ ] Backend logs show the real code path firing end to end, or are marked `N/A - <reason>`.",
      }),
    );
    const blank = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("blank fixture should fail");
    if (blank?.status !== "blank") {
      failures.push("blank row should be reported blank");
    }
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      body({
        "backend-logs": "- [x] Backend logs attached.",
      }),
    );
    const blank = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("checked-without-artifact fixture should fail");
    if (blank?.status !== "blank") {
      failures.push("checked-without-artifact row should be reported blank");
    }
  }

  // A pasted transcript is the format CONTRIBUTING.md § Evidence prescribes for
  // logs, so it must satisfy a non-visual row on its own.
  {
    const { ok, findings } = evaluatePrEvidence(
      body({
        "backend-logs": [
          "- [x] Boot-path run over the real vault backend.",
          "  <details><summary>connector-vault-refs</summary><pre>",
          "  $ vitest run packages/agent/src/runtime/connector-vault-refs.test.ts",
          "  Test Files  1 passed (1)",
          "       Tests  13 passed (13)",
          "    - ref resolves -> settings carry plaintext; process.env asserted clean",
          "  </pre></details>",
        ].join("\n"),
      }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (!ok) failures.push("inline transcript fixture should pass");
    if (row?.status !== "ok") {
      failures.push("inline transcript row should be reported ok");
    }
  }

  // The floor is what keeps the allowance from becoming a rubber stamp: an
  // empty container and a one-line "see attached" must both still fail.
  for (const [name, rowText] of [
    ["empty details block", "- [x] Backend logs.\n  <details></details>"],
    [
      "summary-only details block",
      "- [x] Backend logs.\n  <details><summary>backend logs for the whole run</summary></details>",
    ],
    ["one-line code fence", "- [x] Backend logs.\n  ```\n  ok\n  ```"],
  ]) {
    const { ok, findings } = evaluatePrEvidence(
      body({ "backend-logs": rowText }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push(`${name} fixture should fail`);
    if (row?.status !== "blank") {
      failures.push(`${name} row should be reported blank`);
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok } = evaluatePrEvidence(body);
    if (!ok) failures.push("all-N/A-with-reason fixture should pass");
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "ui",
    });
    if (ok) failures.push("ui-labeled all-N/A fixture should fail");
    const screenshots = findings.filter((finding) =>
      SURFACE_ARTIFACT_ROW_IDS.includes(finding.id),
    );
    if (screenshots.some((finding) => finding.status !== "artifact-required")) {
      failures.push(
        "ui-labeled screenshot/video rows should require artifacts",
      );
    }
    const ocr = findings.find((finding) => finding.id === "ocr-review");
    if (ocr?.status !== "ocr-required") {
      failures.push("ui-labeled evidence should require OCR proof");
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: ["packages/ui/src/components/Foo.tsx"],
    });
    if (ok) {
      failures.push("UI-file diff with all-N/A rows should fail (no labels)");
    }
    if (
      findings.find((finding) => finding.id === "before-screenshots")
        ?.status !== "artifact-required"
    ) {
      failures.push("UI-file diff should require screenshot artifacts");
    }
  }

  {
    const { ok } = evaluatePrEvidence(body(), REQUIRED_EVIDENCE_ROWS, {
      changedFiles: [
        "packages/ui/src/components/Foo.test.tsx",
        "packages/app-core/src/services/thing.ts",
        "packages/ui/src/components/Foo.stories.tsx",
      ],
    });
    if (!ok) {
      failures.push(
        "test/story/server-only diff should not trigger surface artifacts",
      );
    }
  }

  {
    const { ok } = evaluatePrEvidence(
      body({ "backend-logs": "- [ ] Backend logs N/A" }),
    );
    if (ok) failures.push("bare N/A should fail");
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      body({
        "backend-logs": `- [ ] Backend logs: ${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
      }),
    );
    const backend = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("retired repo evidence-only row should fail");
    if (backend?.status !== "blank") {
      failures.push("retired repo evidence-only row should be reported blank");
    }
  }

  {
    const retired = findRetiredRepoEvidenceFiles([
      "packages/app/test-results/report.json",
      `${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
    ]);
    if (retired.length !== 1) {
      failures.push("retired repo evidence changed file should be rejected");
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.slice(1)
      .map(
        ({ id }) =>
          `<!-- evidence-row:${id} -->\n- [ ] N/A - covered elsewhere`,
      )
      .join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body);
    const missing = findings.find(
      (finding) => finding.id === "before-screenshots",
    );
    if (ok) failures.push("missing-marker fixture should fail");
    if (missing?.status !== "missing") {
      failures.push("absent row should be reported missing");
    }
  }

  {
    // A body written without ANY template markers (prose-only evidence notes,
    // the #16925/#16913 failure shape) reports every required row missing —
    // the CLI layer keys its "template was removed" hint off this shape.
    const { ok, findings } = evaluatePrEvidence(
      "Evidence rows: UI/video/frontend N/A - cloud backend latency.",
    );
    if (ok) failures.push("marker-free body should fail");
    if (!findings.every((finding) => finding.status === "missing")) {
      failures.push("marker-free body should report every row missing");
    }
  }

  {
    // An overflow-release (pr-evidence-N) screenshot satisfies a UI-file surface
    // PR identically to a primary-release one — the storage location moved, the
    // gate did not.
    const dl = (tag, name) =>
      `https://github.com/elizaOS/eliza/releases/download/${tag}/${name}`;
    const { ok } = evaluatePrEvidence(
      body({
        "before-screenshots": `- [x] ![before](${dl("pr-evidence-2", "16367-before.jpg")})`,
        "after-screenshots": `- [x] ![after](${dl("pr-evidence-2", "16367-after.jpg")})`,
        "walkthrough-video": `- [x] ${dl("pr-evidence-2", "16367-walk.mp4")}`,
        "ocr-review": `- [ ] OCR text readout: ${dl("pr-evidence-3", "16367-ocr.jsonl")}`,
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    if (!ok)
      failures.push("overflow-release evidence on a surface PR should pass");
  }

  {
    // A link to the release PAGE (not a /download/ asset) is not a screenshot.
    const { ok } = evaluatePrEvidence(
      body({
        "before-screenshots":
          "- [ ] Before screenshots: https://github.com/elizaOS/eliza/releases/tag/pr-evidence-2",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    if (ok) failures.push("release-page link must not satisfy a visual row");
  }

  if (failures.length > 0) {
    throw new Error(
      `check-pr-evidence self-test failed:\n${failures.join("\n")}`,
    );
  }
}
