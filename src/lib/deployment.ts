/** Public origins are selected from an explicit deployment tier, never user input. */
export type DeploymentTier = "production" | "staging";
export function deploymentOrigins(tier: DeploymentTier = "production") {
  if (tier === "staging")
    return {
      site: "https://staging.slop.cash",
      api: "https://staging.slop.cash",
      identity: "https://identity-staging.slop.cash",
      browserOrigins: new Set(["https://staging.slop.cash"]),
    };
  return {
    site: "https://slop.cash",
    api: "https://api.slop.cash",
    identity: "https://identity.slop.cash",
    browserOrigins: new Set([
      "https://slop.cash",
      "https://www.slop.cash",
      "https://slop.tech",
      "https://www.slop.tech",
      "https://eliza.army",
    ]),
  };
}
export function deploymentTier(value: unknown): DeploymentTier {
  if (value === undefined || value === "production") return "production";
  if (value === "staging") return "staging";
  throw new Error("Invalid deployment tier");
}
