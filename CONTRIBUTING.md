# Contributing

Thanks for helping improve `reliable-udp`.

## Setup

```bash
npm install
npm run verify
```

## Workflow

1. Create a branch.
2. Add tests with every behavior change.
3. Run `npm run verify`.
4. Add a changeset for user-facing changes:
   ```bash
   npm run changeset
   ```
5. Open a PR with context and test evidence.

## Coding guidelines

- Keep protocol behavior deterministic in tests.
- Favor small, composable API changes.
- Avoid exporting internal-only helpers from the package root.
