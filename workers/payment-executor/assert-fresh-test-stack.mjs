// Read-only remote admission for the generated apply script, before any remote mutation.
const names = process.argv.slice(2);
if (
  names.length !== 3 ||
  names.some(
    (name) =>
      !/^slop-payments-(base-sepolia|solana-devnet|solana-testnet)(-[a-z0-9]+)*-(attester|relayer|dispatcher)$/.test(
        name,
      ),
  )
)
  throw new Error("Explicit isolated test stack names required");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/.test(account ?? "") || !token)
  throw new Error(
    "Test deployment Cloudflare account/token must be supplied securely by the release operator",
  );
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
  {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  },
);
if (!response.ok)
  throw new Error(
    `Cannot verify fresh stack (${response.status}); no changes permitted`,
  );
const result = await response.json();
if (
  !result.success ||
  !Array.isArray(result.result) ||
  result.result.some((item) => typeof item.id !== "string")
)
  throw new Error("Invalid worker inventory; no changes permitted");
if (result.result.some((worker) => names.includes(worker.id)))
  throw new Error(
    "Test stack already exists. Refusing reapply: reconcile existing journals and use a reviewed update procedure, or select a new isolated database/stack.",
  );
console.log(
  "Fresh isolated test worker names confirmed; no existing stack will be updated.",
);
