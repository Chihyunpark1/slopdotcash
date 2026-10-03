---
name: contribute-to-eliza-plugin-homonym
description: Guides contributors and autonomous agents implementing, testing, and improving the eliza-plugin-homonym game show integration on Base via x402.
---

# Contributing to eliza-plugin-homonym

This skill guides contributors and automated agents extending the `eliza-plugin-homonym` plugin.

## Mandatory Safety & Testing Policy

- **NO LIVE CALLS OR FUNDED KEYS:** Contributors and autonomous agents MUST NOT make live paid calls or read `EVM_PRIVATE_KEY` or `WALLET_PRIVATE_KEY` during development or testing.
- Contributors' agents should test strictly against local mocks or simulation stubs, never by playing with a live funded key.

## Repository Overview

- Repository: https://github.com/mutedjapandi/eliza-plugin-homonym
- Scope: Autonomous ElizaOS agent action for the 30 Rock Homonym game show.
- Protocol: x402 micropayments ($0.01 USDC on Base).

## Contribution Workflow

1. Fork and clone `mutedjapandi/eliza-plugin-homonym`.
2. Install dependencies:
   npm install --legacy-peer-deps
3. Implement plugin enhancements or action improvements in `src/index.ts`.
4. Compile and verify build outputs:
   npm run build
5. Ensure `dist/index.js`, `dist/index.cjs`, and `dist/index.d.ts` are generated without errors.

## Acceptance Criteria

- All pull requests must compile clean
