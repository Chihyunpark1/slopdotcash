import { it } from "vitest";
import * as evidence from "./check-pr-evidence.mjs";
import { runSelfTest } from "./check-pr-evidence-fixtures.mjs";

it("rejects missing or substituted PR evidence and retains valid evidence forms", () =>
  runSelfTest(evidence));
