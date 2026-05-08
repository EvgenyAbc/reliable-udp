# Releasing reliable-udp

## Versioning policy

- `patch`: bug fixes and non-breaking internals.
- `minor`: backward-compatible features and new exports.
- `major`: breaking API or protocol behavior changes.

## Maintainer flow

1. Contributors add a changeset for user-facing changes:
   ```bash
   npm run changeset
   ```
2. Merge PRs to `main`.
3. Release workflow updates/opens the "Version Packages" PR.
4. Merging that PR triggers npm publish via Changesets.

## Safety gates

- `prepublishOnly` runs `npm run verify` (lint + typecheck + tests + build).
- CI must be green before release PR merge.
