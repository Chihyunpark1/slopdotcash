# Restricted test payout execution

These private Workers perform the missing signing and broadcast step. They are
separate from the public account API and the scheduled payment dispatcher. They
accept an approved obligation and wallet-claim reference, never caller-supplied
calldata, amounts, tokens, programs, or arbitrary destinations.

Deploy a separate Worker for each chain and role. The identity attester has only
that chain's test identity key. The gas relayer has only its own test gas key.
Each Worker has its own SQLite Durable Object journal. The relayer reaches the
attester through a private service binding. Both roles independently read the
current wallet authorization from D1, reconstruct the exact signed consent,
verify the wallet signature, check its GitHub actor and immutable claim digest,
and inspect the finalized obligation. This trusts the GitHub session admission
and reviewed deployment registry. It does not make GitHub identity verifiable
without the identity authority.

The hosted wrapper checks the configured test network and the RPC's chain or
genesis identity before reading the signer secret. Base mainnet and Solana
mainnet are rejected. The local integration override exists only in the core
APIs and is not forwarded by the hosted wrapper.

## Durability and retries

Base nonce allocation, transaction signing, and persistence of signed bytes,
transaction hash, immutable operation identity, and next nonce occur inside one
Durable Object storage transaction. RPC calls happen outside that transaction.
Concurrent fetch handlers can interleave; the storage transaction serializes
nonce allocation and rechecks existing attempts. The signed transaction exists
in durable storage before its first broadcast. A retry uses the same bytes and
checks the known transaction first. It never starts another payment merely
because an RPC response was lost.

The Solana executor journals the signed wire transaction, signature, blockhash
expiry, and generation before broadcast. Its replacement path requires finalized
expiry and a fresh finalized obligation check. It creates destination associated
token accounts idempotently and pays through the version-bound escrow instruction.

`POST /v1/pay` returns a submitted transaction identity. It does not mark a
payment paid; the independent scanner and verifier must prove finality first.
A missing finalized wallet binding requests the separate attester and remains
retryable until binding finality. A successor wallet activates only after 24 hours have passed since both its
registration and signed authorization. The previous on-chain claim must occur
in the same actor/chain predecessor lineage, and all older-wallet payment
attempts must be reconciled. An operator cannot bypass this path.

`POST /v1/attempt-status` returns a persisted payment transaction identity or
null. It checks the original database attempt and journal identity, and does
not sign, broadcast, read a secret, or require the wallet claim still to be
current. This lets the dispatcher reconcile a lost response even after the
contributor has replaced the wallet. Signed transaction bytes are never returned.

`POST /v1/cancel-unsubmitted` retires an old-wallet attempt only after a signed
successor exists. Its journal transaction either finds a previously signed
transaction and returns that identity, or writes a retirement tombstone. Every
signer transaction checks the tombstone before signing. The dispatcher may mark
the old attempt failed only after confirmed retirement; a null lookup alone is
never proof that signing cannot race the lookup.

Signer keys must be dedicated to these Workers. Manual external transactions
using the same keys would invalidate the nonce ownership assumption. A Base
transaction stuck due to fee pricing requires operator reconciliation; there
is no automatic gas-price replacement in this version. Base signing limits gas
to 500,000 and max gas price to 10 gwei. Never delete or restore an old journal
snapshot to clear an error. A restore must preserve every signed attempt and
reconcile the chain before resuming.

## Configuration

`configure.mjs` generates private test-only Wrangler configurations from the
reviewed deployment registry and an explicitly supplied isolated D1 identity:

```sh
node workers/payment-executor/configure.mjs \
  --database-id "$TEST_D1_DATABASE_ID" \
  --database-name "$TEST_D1_DATABASE_NAME" \
  --deployments "$REVIEWED_TEST_DEPLOYMENTS_FILE" \
  --output workers/payment-executor/.generated
```

This command does not create resources or deploy. Generated configuration has
`workers_dev: false`, `preview_urls: false`, no routes, and the SQLite Durable
Object migration. It emits only families present in the reviewed registry.
Never add a public route. The dispatcher must bind separately to
`slop-base-relayer-test` and `slop-solana-relayer-test`.

Set secret bindings only through the approved isolated test release process:

- `PAYMENT_RPC_URLS`: private JSON mapping of network names to authenticated RPC
  endpoints. Do not place RPC credentials in public manifests.
- Base Worker: `TEST_SIGNER_PRIVATE_KEY`, dedicated test key in hex form.
- Solana Worker: `TEST_SOLANA_SIGNER_SEED`, dedicated test seed as 64 hex digits.

Supply only the one signer secret for the Worker's chain and role. The
`PAYMENT_DEPLOYMENTS` public configuration is generated from reviewed project
manifests; it is not a second editable project inventory. Both roles use
`PAYMENTS_DB`; the executor code reads authorization data and does not create
wallet authorizations or approve awards. Journal storage contains sensitive
operational material and has no read route other than transaction-ID lookup.

## Validation boundaries

`bun backend/payments/base.integration.ts` executes the account API, signed
wallet consent, finalized reservation scanner, real separate EIP1559 signers,
payment dispatch, disk-backed journal recovery after a deliberately lost RPC
response, and finalized payout indexing against actual Anvil contracts. It
checks the net 98-USDC balance from a 100-USDC gross award, rejects a substituted
destination, verifies scanner replay, rejects an early successor, and executes
the successor payment after a simulated 25-hour delay. It also proves signed
attempt discovery after wallet replacement and prevents retirement of signed
transactions. The deterministic Anvil mnemonic is a
public test fixture, not a user secret.

Local execution is not public testnet evidence. Public-chain acceptance still
needs isolated D1 and service bindings, dedicated funded gas/identity signers,
reviewed deployed escrow identities, actual test USDC, real GitHub OAuth, hosted
private Worker deployment, and finalized public receipts. Mainnet enablement,
production signing operations, lost-identity recovery, donation accounting,
and independent security review remain separate gates.
