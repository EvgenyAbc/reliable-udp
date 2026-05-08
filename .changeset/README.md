# Changesets

Use changesets to track semver and changelog entries for every user-facing change.

## Creating a release note

```bash
npm run changeset
```

This creates a markdown file in `.changeset/` that describes the change and bump type.

## Releasing

- Merge PRs with changesets.
- The release workflow opens/updates a "Version Packages" PR.
- Merging that PR publishes to npm and updates the changelog.
