/** Regression for approval starvation: validate the actual job graph and shells. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonCommand } from "./skill-python.mjs";

function workflow(path) {
  const { executable, prefix } = pythonCommand(process.cwd());
  return JSON.parse(
    execFileSync(
      executable,
      [
        ...prefix,
        "-c",
        "import yaml,json,sys; value=yaml.safe_load(sys.stdin); value['on']=value.pop(True,value.get('on')); print(json.dumps(value))",
      ],
      { input: readFileSync(path, "utf8"), encoding: "utf8" },
    ),
  );
}

describe("independent release and intake paths", () => {
  it("runs proposal gates from the trusted checkout and stops before verification when either revision differs", () => {
    for (const [path, prefix, remoteRef, commands] of [
      [
        "funding-records",
        "FUNDING",
        "slop-funding-head",
        ["scripts/check-funding-record-pr.ts"],
      ],
      [
        "unsafe-destination-transitions",
        "CYCLE",
        "slop-cycle-head",
        [
          "--no-install scripts/check-unsafe-destination-transitions.ts",
          "--no-install scripts/check-squads-execution-transitions.ts",
        ],
      ],
    ]) {
      const definition = workflow(`.github/workflows/${path}.yml`);
      expect(Object.keys(definition.on)).toEqual(["pull_request_target"]);
      expect(definition.on.pull_request_target.branches).toEqual(["develop"]);
      expect(definition.permissions).toEqual({ contents: "read" });
      const job = definition.jobs[path];
      expect(job.permissions).toBeUndefined();
      expect(job.environment).toBeUndefined();
      const checkouts = job.steps.filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0].with.ref).toBe(
        `\${{ github.event.pull_request.base.sha }}`,
      );
      expect(checkouts[0].with["persist-credentials"]).toBe(false);
      const gate = job.steps.find((step) => step.env?.[`${prefix}_PR_NUMBER`]);
      expect(gate.env[`${prefix}_BASE_SHA`]).toBe(
        `\${{ github.event.pull_request.base.sha }}`,
      );
      expect(gate.env[`${prefix}_HEAD_SHA`]).toBe(
        `\${{ github.event.pull_request.head.sha }}`,
      );
      const shells = job.steps
        .filter((step) => step.run)
        .map((step) => step.run);
      expect(shells.join("\n")).not.toMatch(/gh pr (merge|review)/u);
      const installs = shells.filter((shell) =>
        /(?:bun|npm) install/u.test(shell),
      );
      expect(installs).toEqual(
        path === "funding-records"
          ? ["bun install --frozen-lockfile --ignore-scripts"]
          : [],
      );
      if (path === "funding-records") {
        expect(shells.at(-1)).toContain(
          "bun --no-install scripts/check-signer-access-transitions.ts",
        );
      }
      const root = mkdtempSync(join(tmpdir(), "slop-proposal-workflow-"));
      try {
        const git = (...args) =>
          execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git("init", "-q");
        git("config", "user.name", "Workflow fixture");
        git("config", "user.email", "fixture@example.invalid");
        git("commit", "--allow-empty", "-qm", "trusted base");
        const base = git("rev-parse", "HEAD");
        git("commit", "--allow-empty", "-qm", "proposal");
        const head = git("rev-parse", "HEAD");
        git("update-ref", "refs/pull/123/head", head);
        git("remote", "add", "origin", root);
        git("checkout", "--detach", base);
        mkdirSync(join(root, "bin"));
        // Execute the checked-in shell and real Git fetch. Only the already-tested
        // verifier is replaced so these checks can observe whether it is reached.
        writeFileSync(
          join(root, "bin/bun"),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\n',
          { mode: 0o700 },
        );
        const trace = join(root, "trace");
        for (const [baseSha, headSha, accepted] of [
          [base, head, true],
          [head, head, false],
          [base, base, false],
        ]) {
          rmSync(trace, { force: true });
          const result = spawnSync("bash", ["-eu", "-c", gate.run], {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${join(root, "bin")}:${process.env.PATH}`,
              TRACE: trace,
              RUNNER_TEMP: root,
              [`${prefix}_BASE_SHA`]: baseSha,
              [`${prefix}_HEAD_SHA`]: headSha,
              [`${prefix}_PR_NUMBER`]: "123",
            },
          });
          expect(result.status === 0, result.stderr).toBe(accepted);
          if (accepted) {
            const calls = readFileSync(trace, "utf8").trim().split("\n");
            expect(calls).toHaveLength(commands.length);
            commands.forEach((command, index) => {
              expect(calls[index]).toBe(
                path === "funding-records"
                  ? `${command} --base-sha ${base} --head-sha ${head} --pr-number 123 --output ${root}/funding-record-decision.json`
                  : `${command} ${base} ${head}`,
              );
            });
            expect(git("rev-parse", `refs/remotes/origin/${remoteRef}`)).toBe(
              head,
            );
          } else {
            expect(() => readFileSync(trace)).toThrow();
          }
          expect(git("rev-parse", "HEAD")).toBe(base);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it("routes code releases to production credentials without a manual approval job, while refreshes can publish", () => {
    const { jobs } = workflow(".github/workflows/deploy.yml");
    expect(jobs.approve).toBeUndefined();
    expect(jobs.deploy.needs).toEqual(["source", "quality"]);
    expect(jobs.deploy.if).not.toContain("needs.approve");
    expect(jobs.deploy.concurrency.group).toBe("slop-production");
    expect(jobs.deploy.environment.name).toBe(
      `\${{ github.event_name == 'schedule' && 'slop-data-refresh' || 'eliza-army-production' }}`,
    );
    const publication = jobs.deploy.steps.find(
      (step) => step.id === "pages-deploy",
    ).run;
    expect(
      publication.lastIndexOf("node scripts/released-source.mjs --check"),
    ).toBeLessThan(publication.indexOf("wrangler pages deploy"));
    expect(publication).toContain('--commit-hash="$RELEASE_SHA"');
    const { jobs: health } = workflow(
      ".github/workflows/private-intake-watch.yml",
    );
    expect(health.watch.needs).toBeUndefined();
    expect(health.watch.environment).toBeUndefined();
    expect(health.watch.concurrency.group).not.toBe(
      jobs.deploy.concurrency.group,
    );
    expect(JSON.stringify(health)).not.toContain("CLOUDFLARE_API_TOKEN");
  });
  it("renews the legacy format only while refreshing an older approved source", () => {
    const { jobs } = workflow(".github/workflows/deploy.yml");
    const command = jobs.quality.steps.find((step) =>
      step.run?.includes("bun run leaderboard:generate"),
    ).run;
    const root = mkdtempSync(join(tmpdir(), "slop-legacy-refresh-"));
    try {
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "scripts/prepare-private-intake-attestation.ts"),
        "",
      );
      writeFileSync(
        join(root, "bun"),
        '#!/bin/sh\nprintf \'%s:%s\\n\' "$GITHUB_SHA" "$*" >> "$TRACE"\n',
        { mode: 0o700 },
      );
      const trace = join(root, "trace");
      const env = {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        TRACE: trace,
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_SHA: "new-head",
        RELEASE_SHA: "approved-source",
      };
      execFileSync("bash", ["-eu", "-c", command], { cwd: root, env });
      expect(readFileSync(trace, "utf8")).toContain(
        "approved-source:scripts/prepare-private-intake-attestation.ts",
      );
      rmSync(join(root, "scripts/prepare-private-intake-attestation.ts"));
      rmSync(trace);
      execFileSync("bash", ["-eu", "-c", command], { cwd: root, env });
      expect(readFileSync(trace, "utf8").trim()).toBe(
        "new-head:run leaderboard:generate\nnew-head:run profiles:generate",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("parses every release shell after GitHub expression substitution", () => {
    for (const path of [
      ".github/workflows/deploy.yml",
      ".github/workflows/private-intake-watch.yml",
    ]) {
      for (const job of Object.values(workflow(path).jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.run) continue;
          const result = spawnSync("bash", ["-n"], {
            input: step.run.replace(/\$\{\{.*?\}\}/gu, "fixture"),
            encoding: "utf8",
          });
          expect(result.status, `${path}: ${step.name}: ${result.stderr}`).toBe(
            0,
          );
        }
      }
    }
  });
});
