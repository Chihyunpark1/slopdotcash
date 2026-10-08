import type { ReactNode } from "react";
import { fetchWithDeadline, readBoundedJson } from "./lib/browser-json";
import type { CycleIndex } from "./lib/cycle-index";
import {
  assertProfiles,
  type ProfileIndex,
  profileCounts,
} from "./lib/profiles";
import { usePublicResource } from "./lib/use-public-resource";
import { ContributorIdentity } from "./Presentation";

const disclosures = import.meta.glob("../disclosures/*.json", {
  eager: true,
  import: "default",
}) as Record<
  string,
  {
    rows: {
      actorId: string;
      state: string;
      observed: null | { amountMinor: string; signature: string };
    }[];
  }
>;
async function loadProfiles(signal: AbortSignal) {
  const response = await fetchWithDeadline("/data/profiles.json", {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw Error("Profiles unavailable");
  const index = await readBoundedJson(response, 8 * 1024 * 1024, "profiles");
  assertProfiles(index);
  return { index };
}
type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; index: ProfileIndex };
export function useProfiles(): { state: State; retry: () => void } {
  const [state, retry] = usePublicResource(
    true,
    loadProfiles,
    "Profiles unavailable",
    15_000,
  );
  return { state, retry };
}
function dollars(n: bigint) {
  return `$${(n / 1000000n).toLocaleString("en-US")}.${(n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}
export function ProfileActivity({
  login,
  actorId,
  showIdentity = false,
  cycles,
  census,
  summary,
}: {
  login: string;
  actorId?: string;
  showIdentity?: boolean;
  cycles?: CycleIndex;
  census: ReturnType<typeof useProfiles>;
  summary?: ReactNode;
}) {
  const { state, retry } = census;
  const matches =
    state.status === "ready"
      ? state.index.people.filter((p) =>
          actorId
            ? p.id === actorId
            : p.login.toLowerCase() === login.toLowerCase(),
        )
      : [];
  const p = matches.length === 1 ? matches[0] : undefined;
  const id = actorId ?? p?.id;
  const counts = p
    ? profileCounts(p)
    : id && state.status === "ready"
      ? { merged: 0, open: 0, closed: 0 }
      : null;
  const image =
    p?.avatarUrl ??
    `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=160`;
  const payments =
    cycles && id
      ? cycles.cycles.flatMap((c) =>
          c.contributors
            .filter((m) => m.actor.id === id && m.state === "paid")
            .map((m) => ({
              amount: BigInt(m.paidMinor),
              href: `/cycles/${c.projectId}/${c.cycleId}`,
              name: `${c.projectId} · ${c.cycleId}`,
            })),
        )
      : null;
  const seen = new Set<string>();
  const direct = id
    ? Object.entries(disclosures).flatMap(([path, d]) =>
        d.rows
          .filter(
            (r) => r.actorId === id && r.state === "paid-direct" && r.observed,
          )
          .flatMap((r) => {
            const o = r.observed;
            if (
              !o ||
              !/^\d+$/.test(o.amountMinor) ||
              !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(o.signature) ||
              seen.has(o.signature)
            )
              return [];
            seen.add(o.signature);
            return [
              {
                amount: BigInt(o.amountMinor),
                href: `https://solscan.io/tx/${o.signature}`,
                name: path.split("/").pop()!,
              },
            ];
          }),
      )
    : [];
  return (
    <section className="profile-activity" aria-label="Contributor profile">
      {showIdentity ? (
        <ContributorIdentity
          actor={{
            login: p?.login ?? login,
            avatarUrl: image,
            url: `https://github.com/${encodeURIComponent(p?.login ?? login)}`,
          }}
        />
      ) : null}
      <h2>Contribution record</h2>
      <div className="profile-totals">
        {summary}
        {state.status === "ready" ? (
          <>
            {(
              [
                ["Merged", "merged"],
                ["Open", "open"],
                ["Closed without merging", "closed"],
              ] as const
            ).map(([label, key]) => (
              <div key={key}>
                <strong>
                  {counts ? counts[key].toLocaleString() : "Unknown"}
                </strong>
                <span>PRs {label.toLowerCase()}</span>
              </div>
            ))}
          </>
        ) : null}
        <div>
          <strong>
            {payments
              ? dollars(payments.reduce((n, r) => n + r.amount, 0n))
              : "Unavailable"}
          </strong>
          <span>verified payments received · USDC</span>
        </div>
        <div>
          <strong>
            {id
              ? dollars(direct.reduce((n, r) => n + r.amount, 0n))
              : "Unavailable"}
          </strong>
          <span>direct payments reported · USDC</span>
        </div>
      </div>

      {state.status === "error" ? (
        <p role="status">
          PR counts are unavailable.{" "}
          <button type="button" onClick={retry}>
            Retry profile
          </button>
        </p>
      ) : state.status === "loading" ? (
        <p role="status">Loading PR history…</p>
      ) : (
        <>
          <p className="points-meta">
            Slop repository history · updated{" "}
            {new Date(state.index.generatedAt).toLocaleString()}
            {Date.now() - Date.parse(state.index.generatedAt) > 8 * 3600000
              ? " · Stale: refresh pending"
              : ""}
          </p>
          {p ? (
            <details>
              <summary>PR counts by repository</summary>
              <p className="points-meta">
                Statuses observed between{" "}
                {new Date(state.index.startedAt).toLocaleString()} and{" "}
                {new Date(state.index.generatedAt).toLocaleString()}.
              </p>
              <ul>
                {p.repositories.map((r) => (
                  <li key={r.repository}>
                    <a
                      href={`https://github.com/${r.repository}/pulls?q=${encodeURIComponent(`is:pr author:${p.login}`)}`}
                    >
                      {r.repository}
                    </a>{" "}
                    · {r.merged} merged · {r.open} open · {r.closed} closed
                    without merging
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      <p className="points-meta">
        Direct payments come from published disclosures outside Slop’s verified
        settlement process.
      </p>
      {payments?.length || direct.length ? (
        <details>
          <summary>Payment records</summary>
          <ul>
            {[...(payments ?? []), ...direct].map((r) => (
              <li key={r.href}>
                <a href={r.href} target="_blank" rel="noreferrer">
                  {dollars(r.amount)} USDC · {r.name}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
