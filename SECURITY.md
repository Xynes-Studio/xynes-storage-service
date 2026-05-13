# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in `xynes-storage-service` or any
component of the Xynes ERP platform, please **do not** open a public GitHub
issue. Public issues become indexable and may expose users before a fix is
available.

Instead, please report the vulnerability privately to the Xynes Studio
security contact:

- **Preferred channel:** [GitHub Security Advisories](https://github.com/Xynes-Studio/xynes-storage-service/security/advisories/new) — opens a private advisory the maintainers can triage.
- **Fallback:** open an issue tagged `security-triage-needed` with **no
  vulnerability details in the body** asking a maintainer to open a private
  channel with you.

When reporting, please include:

- A clear description of the vulnerability and its impact.
- Steps to reproduce or a proof-of-concept.
- Affected versions, commits, or branches if known.
- Whether the vulnerability has been disclosed elsewhere.

## Scope

This policy covers `xynes-storage-service` specifically. Issues in
companion services (`xynes-gateway`, `xynes-authz-service`,
`xynes-accounts-service`, `xynes-cms-core`, etc.) should be reported on
their respective repositories under the same private-disclosure rules.

## What is in scope

- Information disclosure of provider credentials, signed URLs, or raw API
  keys via logs, responses, or error envelopes.
- Cross-workspace data access (a caller in workspace A reading or modifying
  storage objects belonging to workspace B).
- Path-traversal or object-key forgery enabling access to non-owned
  objects.
- Privilege escalation (e.g., a `read_only` actor bypassing scope or role
  checks to perform writes).
- Upload session forgery or replay enabling unauthorized writes to a
  workspace's provider bucket.
- Cleartext storage of provider credentials in any Postgres table.

## What is out of scope (do not report as security)

- Theoretical or speculative vulnerabilities without a reproduction path.
- Issues that require an already-compromised maintainer credential to
  exploit.
- Denial-of-service via expensive but legitimate workloads (file-size
  abuse is tracked under STORAGE-9 rate-limiting work).
- Issues in third-party dependencies that have already been disclosed
  upstream — please report those to the upstream project first.

## Response expectations

The maintainers aim to:

1. Acknowledge receipt within 5 business days.
2. Triage and confirm or deny the vulnerability within 14 business days.
3. Coordinate a fix and disclosure timeline with the reporter.
4. Credit reporters who request it after the fix has shipped.

## Pre-implementation status

While `xynes-storage-service` is in its STORAGE-1 (docs-only) phase, there
is no runtime to exploit. Documentation-level security issues
(e.g., a contract that would, if implemented as documented, leak
credentials) are nevertheless welcome reports — they save the cost of
fixing the issue after STORAGE-4 lands.
