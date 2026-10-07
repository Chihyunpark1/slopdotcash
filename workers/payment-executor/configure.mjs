import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generates reviewable test-only worker configs; never creates resources or deploys.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) {
      if (!value.startsWith("--") || !all[index + 1])
        throw new Error(
          "Use --database-id ID --database-name NAME --deployments PATH --output DIRECTORY",
        );
      pairs.push([value.slice(2), all[index + 1]]);
    }
    return pairs;
  }, []),
);
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    args["database-id"] ?? "",
  ) ||
  !/^[a-zA-Z0-9_-]+$/.test(args["database-name"] ?? "") ||
  !args.deployments ||
  !args.output
)
  throw new Error(
    "Explicit test database identity, deployments file, and output directory required",
  );
const deployments = JSON.parse(await readFile(args.deployments, "utf8"));
if (!Array.isArray(deployments) || deployments.length === 0)
  throw new Error("Expected generated deployment array");
for (const deployment of deployments) {
  if (
    !(
      deployment.chain === "base" &&
      deployment.network === "base-sepolia" &&
      deployment.chainId === "84532"
    ) &&
    !(
      deployment.chain === "solana" &&
      ["solana-devnet", "solana-testnet"].includes(deployment.network)
    )
  )
    throw new Error("Only approved public test deployments may be configured");
}
const root = dirname(fileURLToPath(import.meta.url));
await mkdir(args.output, { recursive: true });
for (const chain of ["base", "solana"]) {
  const selected = deployments.filter((d) => d.chain === chain);
  if (!selected.length) continue;
  for (const role of ["attester", "relayer"]) {
    const name = `slop-${chain}-${role}-test`;
    const config = {
      name,
      main: resolve(root, "index.ts"),
      compatibility_date: "2026-10-06",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      routes: [],
      vars: {
        SIGNER_ROLE: role,
        CHAIN_FAMILY: chain,
        PAYMENT_DEPLOYMENTS: JSON.stringify(selected),
      },
      d1_databases: [
        {
          binding: "PAYMENTS_DB",
          database_name: args["database-name"],
          database_id: args["database-id"],
        },
      ],
      durable_objects: {
        bindings: [{ name: "JOURNAL", class_name: "PaymentSignerJournal" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["PaymentSignerJournal"] }],
      ...(role === "relayer"
        ? {
            services: [
              {
                binding: "IDENTITY_ATTESTER",
                service: `slop-${chain}-attester-test`,
              },
            ],
          }
        : {}),
    };
    const path = resolve(args.output, `${name}.json`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(path);
  }
}
