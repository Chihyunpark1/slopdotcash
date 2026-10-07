import { ArrowRight, CircleAlert, ExternalLink } from "lucide-react";
import { Link } from "./Link";
import type { CycleIndexEntry } from "./lib/cycle-index";
import { cycleSettlementReminder } from "./lib/funding-reminders";
import { createProjectView, type ProjectView } from "./lib/project-view";
import type { ProjectDefinition } from "./lib/projects.mjs";
import { formatThirds } from "./lib/reviewer-leaders";
import type { CycleIndexState } from "./lib/use-cycle-index";
import type { DataState } from "./lib/use-snapshot";
import {
  cycleStateLabel,
  DataNotice,
  EmptyState,
  ExternalLinkAnchor,
  formatCycleMonth,
  formatDate,
  formatMicroUsdc,
  NotFound,
  stale,
} from "./Presentation";
import { CycleAllocation } from "./ProjectLeaderboard";

export function CyclePage({
  project,
  cycleId,
  state,
  retry,
}: {
  project: ProjectDefinition;
  cycleId: string;
  state: DataState;
  retry: () => void;
}) {
  if (state.status !== "ready")
    return (
      <main className="shell route-main">
        <DataNotice state={state} retry={retry} />
      </main>
    );
  const record = state.cycleIndex.cycles.find(
    (cycle) => cycle.projectId === project.id && cycle.cycleId === cycleId,
  );
  let view: ProjectView | null = null;
  try {
    view = createProjectView(state.snapshot, project.id, cycleId);
  } catch (error: unknown) {
    if (!record) {
      return (
        <NotFound
          title={error instanceof Error ? error.message : "Cycle unavailable"}
        />
      );
    }
  }
  const from = record?.contributionWindow.from ?? view?.cycle.from;
  const to = record?.contributionWindow.to ?? view?.cycle.endsAt;
  if (!from || !to) return <NotFound title="Cycle unavailable" />;
  const lifecycle =
    record?.state ?? (view?.cycle.status === "live" ? "live" : "closed");
  const reminder = cycleSettlementReminder({
    closesAt: to,
    fundingState:
      project.reward.reviewBudget?.fundingState === "committed"
        ? "committed"
        : project.reward.fundingState,
    kind:
      record?.kind ??
      (view?.reward.kind === "external-prize-share"
        ? "external-prize-share"
        : "monthly-pool"),
    now: new Date().toISOString(),
    paymentMode: project.reward.paymentMode,
    settledAt: record?.settledAt ?? null,
    state: record?.state ?? (view?.cycle.status === "live" ? "live" : "review"),
  });
  const headlineAmount = record
    ? record.kind === "external-prize-share"
      ? `${(record.reward.sharePartsPerMillion ?? 0) / 10_000}%`
      : formatMicroUsdc(
          record.state === "paid"
            ? record.reward.paidMinor
            : record.reward.approvedMinor !== "0"
              ? record.reward.approvedMinor
              : record.reward.suggestedMinor,
        )
    : view?.reward.kind === "monthly-pool"
      ? formatMicroUsdc(view.reward.projectedPrincipalMinor)
      : `${(view?.reward.totalSharePartsPerMillion ?? 0) / 10_000}%`;
  return (
    <main className="shell route-main cycle-page">
      <DataNotice state={state} retry={retry} />
      <p className="breadcrumb">
        <Link href={`/projects/${project.slug}`}>{project.name}</Link>
        <span>/</span>
        {cycleId}
      </p>
      <section className="cycle-hero">
        <div>
          <h1>
            {project.name} · {cycleId}
          </h1>
          <p>
            {lifecycle.replaceAll("-", " ")} · {formatDate(from)}–
            {formatDate(to)}. Paid means finalized Solana evidence reconciled
            exactly.
          </p>
        </div>
        <div className="cycle-number">
          <strong>{headlineAmount}</strong>
          <span>
            {record?.state === "paid"
              ? "paid principal"
              : record?.kind === "external-prize-share" ||
                  view?.reward.kind === "external-prize-share"
                ? "provisional shares assigned"
                : record
                  ? record.reward.approvedMinor !== "0"
                    ? "approved principal"
                    : "suggested principal"
                  : "projected principal"}
          </span>
        </div>
      </section>
      {record?.reward.lines ? (
        <p className="cycle-line-summary">
          Shared pool{" "}
          {formatMicroUsdc(record.reward.lines.sharedPool.suggestedMinor)} +
          additive review{" "}
          {formatMicroUsdc(record.reward.lines.reviewBudget.suggestedMinor)}{" "}
          suggested. The combined amount uses one wallet and one dust-floor
          decision.
        </p>
      ) : null}
      {reminder ? (
        <div
          className={`data-notice cycle-reminder ${reminder.kind}`}
          role="status"
        >
          <CircleAlert aria-hidden="true" size={18} />
          <span>{reminder.message}</span>
        </div>
      ) : null}
      <ol className="cycle-status-grid" aria-label="Cycle progress">
        <li>
          <strong>Contribution</strong>
          <p>Accepted GitHub work is collected; private traces are optional.</p>
        </li>
        <li>
          <strong>Review</strong>
          <p>Owners may set every allocation and total payout.</p>
        </li>
        <li>
          <strong>Approval</strong>
          <p>Wallet-linked amounts become immutable payout intents.</p>
        </li>
        <li>
          <strong>Settlement</strong>
          <p>The 1% fee applies when the approved principal is paid.</p>
        </li>
      </ol>
      {view ? (
        <CycleAllocation updatedAt={state.snapshot.generatedAt} view={view} />
      ) : record ? (
        <ArchivedCycleLeaderboard cycle={record} />
      ) : null}
      {record ? <CycleArtifacts cycle={record} /> : null}
    </main>
  );
}

function ArchivedCycleLeaderboard({ cycle }: { cycle: CycleIndexEntry }) {
  return (
    <section className="section project-leader-section">
      <div className="section-heading">
        <h2>Contributors</h2>
      </div>
      {cycle.contributors.length === 0 ? (
        <EmptyState text="This cycle closed with no accepted awards." />
      ) : (
        <div className="leader-table">
          <table className="leader-grid">
            <caption className="visually-hidden">
              Archived cycle contributors
            </caption>
            <thead>
              <tr className="leader-row archived-leader-head">
                <th scope="col">Contributor</th>
                <th scope="col">Score</th>
                <th scope="col">Suggested</th>
                <th scope="col">Approved</th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {cycle.contributors.map((contributor) => (
                <tr
                  className="leader-row archived-leader-row"
                  key={contributor.actor.id}
                >
                  <th scope="row">
                    <Link
                      href={`/contributors/${encodeURIComponent(contributor.actor.login)}`}
                    >
                      {contributor.actor.login}
                    </Link>
                  </th>
                  <td>
                    {formatThirds(
                      contributor.scoreThirds ?? contributor.score * 3,
                    )}
                  </td>
                  <td>
                    {formatMicroUsdc(contributor.suggestedMinor)}
                    {contributor.lines ? (
                      <small>
                        Pool{" "}
                        {formatMicroUsdc(
                          contributor.lines.sharedPool.suggestedMinor,
                        )}{" "}
                        + review{" "}
                        {formatMicroUsdc(
                          contributor.lines.reviewBudget.suggestedMinor,
                        )}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    {formatMicroUsdc(contributor.approvedMinor)}
                    {contributor.lines ? (
                      <small>
                        Pool{" "}
                        {formatMicroUsdc(
                          contributor.lines.sharedPool.approvedMinor,
                        )}{" "}
                        + review{" "}
                        {formatMicroUsdc(
                          contributor.lines.reviewBudget.approvedMinor,
                        )}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <strong>{formatMicroUsdc(contributor.paidMinor)}</strong>
                    {contributor.lines ? (
                      <small>
                        Pool{" "}
                        {formatMicroUsdc(
                          contributor.lines.sharedPool.paidMinor,
                        )}{" "}
                        + review{" "}
                        {formatMicroUsdc(
                          contributor.lines.reviewBudget.paidMinor,
                        )}
                      </small>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CycleArtifacts({ cycle }: { cycle: CycleIndexEntry }) {
  const files = [
    ["Frozen source", cycle.files.sourceSnapshot],
    ["Proposal", cycle.files.proposal],
    ["Approved allocation", cycle.files.allocation],
    ["Unsigned transfer plan", cycle.files.executionPlan],
    ["Verified settlement", cycle.files.settlement],
  ] as const;
  return (
    <section className="section cycle-artifacts">
      <div className="section-heading">
        <h2>Public files</h2>
      </div>
      <div className="artifact-links">
        {files
          .filter((entry) => entry[1] !== null)
          .map(([label, file]) =>
            file ? (
              <ExternalLinkAnchor href={file.url} key={label}>
                <span>
                  <strong>{label}</strong>
                  <small>{file.sha256.slice(0, 16)}…</small>
                </span>
                <ExternalLink aria-hidden="true" size={17} />
              </ExternalLinkAnchor>
            ) : null,
          )}
      </div>
    </section>
  );
}

export function CycleArchivePage({
  state,
  retry,
}: {
  state: CycleIndexState;
  retry: () => void;
}) {
  const cycles =
    state.status === "ready"
      ? [...state.cycleIndex.cycles].sort((left, right) =>
          right.cycleId.localeCompare(left.cycleId),
        )
      : [];
  return (
    <main className="shell evidence-page">
      <section className="evidence-page-hero">
        <h1>Every pool gets a dated public record.</h1>
        <p>
          Proposed is not approved. Approved is not paid. Each cycle keeps its
          source snapshot, state, allocation, and settlement evidence distinct.
        </p>
        {state.status === "loading" ? (
          <p role="status">Loading cycle history…</p>
        ) : state.status === "error" ? (
          <div role="alert">
            Cycle history unavailable: {state.message}{" "}
            <button type="button" onClick={retry}>
              Retry
            </button>
          </div>
        ) : cycles.length === 0 ? (
          <p>No published cycles yet.</p>
        ) : null}
        {state.status === "ready" && stale(state.cycleIndex) ? (
          <p className="data-notice data-stale" role="status">
            Cycle history may be outdated · updated{" "}
            {formatDate(state.cycleIndex.generatedAt)}
          </p>
        ) : null}
      </section>
      <div className="cycle-archive-list">
        {cycles.map((cycle) => (
          <article
            className="cycle-archive-card"
            key={`${cycle.projectId}-${cycle.cycleId}`}
          >
            <div>
              <span>{cycle.projectId}</span>
              <h2>{formatCycleMonth(cycle.cycleId)}</h2>
            </div>
            <dl>
              <div>
                <dt>State</dt>
                <dd>{cycleStateLabel(cycle.state)}</dd>
              </div>
              <div>
                <dt>Suggested</dt>
                <dd>{formatMicroUsdc(cycle.reward.suggestedMinor)}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd>{formatMicroUsdc(cycle.reward.approvedMinor)}</dd>
              </div>
              <div>
                <dt>Paid</dt>
                <dd>{formatMicroUsdc(cycle.reward.paidMinor)}</dd>
              </div>
            </dl>
            <Link href={`/cycles/${cycle.projectId}/${cycle.cycleId}`}>
              Inspect cycle <ArrowRight aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </main>
  );
}
