# Contributing to xynes-storage-service

Thank you for your interest in contributing. This repository is part of the
[Xynes ERP](https://github.com/Xynes-Studio) platform.

> **Status:** STORAGE-1 — architecture & docs only. The runnable service,
> tooling, and CI workflows land in **STORAGE-4**. Until then, contributions
> here are documentation-only.

## Branch model

This repository uses a two-branch trunk:

- **`main`** — release branch. Protected. Only release-time fixes target
  `main` directly.
- **`develop`** — long-lived working branch. **All feature work targets
  `develop`.**

```
feature/<story-id>-<slug>  ──▶  develop  ──▶  main
```

When you open a pull request:

1. Branch from `develop` using a `feature/<id>-<slug>` (e.g.,
   `feature/storage-4-bun-hono-scaffold`) or `fix/<short-desc>` name.
2. Target `develop` as the PR base — **not** `main`.
3. Keep PRs reviewable: prefer one logical change per PR.
4. Use **squash merges** to keep history linear (matches branch protection).

## Pull request checklist

- [ ] PR targets `develop` (or `main` only for release-time fixes).
- [ ] Title follows the `type(scope): summary` convention (e.g.,
  `docs(storage-1): land developer guide`).
- [ ] All conversations resolved before merge.
- [ ] At least 1 approving review.
- [ ] Once STORAGE-4 lands CI: lint, typecheck, and test workflows must
  pass.

## Commit messages

Use conventional commit prefixes when appropriate:

- `docs(<story-id>):` — documentation-only changes.
- `feat(<story-id>):` — user-facing functionality.
- `fix(<story-id>):` — bug fixes.
- `chore:` — tooling, dependency bumps, repository housekeeping.
- `test:` — test additions or changes.
- `refactor:` — internal restructuring without behavior change.

## Code of Conduct

By participating in this project you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Security disclosures

Please **do not** open public issues for security vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for the private disclosure channel.

## Documentation-first contributions (STORAGE-1)

While this repository is in its docs-only phase, contributions should:

- Update the relevant section of `DEVELOPER.md`, `docs/architecture.md`, or
  `docs/api-contract.md`.
- Cross-reference the authoritative source plan at
  `xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md`
  when contract details change.
- Avoid adding `package.json`, `src/`, `tests/`, or other runtime artifacts
  until STORAGE-4 lands.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](./LICENSE).
