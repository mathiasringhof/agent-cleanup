# Make audit and apply compatible with the Skill Workshop scanner

Type: bug
Status: resolved

Source: https://github.com/mathiasringhof/agent-cleanup/issues/1

## Problem

Skill Workshop quarantined the audit and apply skills because their shipped Node helpers used `node:child_process` for OpenClaw validation and `tar` backup creation.

## Acceptance Criteria

- Shipped skill files contain no subprocess dependency or execution.
- Audit and post-apply validation run visibly through the agent's execution tool.
- Apply creates and verifies an external Change Backup without `tar`, a manifest, or hashes.
- Existing cleanup safety boundaries and advisory validation semantics remain intact.
- End-to-end tests and release validation prevent regressions.

## Answer

Audit now records a visibly executed validation result through `record-validation`. Apply creates a direct external directory containing the exact Cleanup Plan and existing touched paths, removes incomplete backups on copy failure, verifies the copied plan before mutation, and tells the skill when visible post-apply validation is required. Release validation recursively scans every shipped skill file for forbidden subprocess APIs.

## Comments

- 2026-07-20: Chose direct directory copies and copied-plan verification. Deliberately rejected manifests, hashes, staging directories, and later tamper detection.
