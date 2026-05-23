---
name: karpathy-guidelines
description: "Coding discipline for Codex when implementing, reviewing, or refactoring code. Use when work is non-trivial, ambiguous, likely to touch existing behavior, or needs a clean diff: surface assumptions, keep changes simple and surgical, define success criteria, and verify with reproducible checks."
---

# Karpathy Guidelines

## Overview

Use this skill as a lightweight discipline check for coding work in this repository. It adapts the Karpathy-inspired guidance from `multica-ai/andrej-karpathy-skills` for Codex, while keeping `AGENTS.md` as the authoritative source for hard repository policy.

## Working Rules

### 1. Think Before Coding

State the assumption you are acting on when the request or code path is ambiguous. If the uncertainty can be resolved by reading code, logs, tests, or docs, inspect those first. Ask only when the answer cannot be discovered locally and a wrong guess would be risky.

When there are multiple plausible interpretations, name the tradeoff briefly before choosing. Push back when the requested implementation would make the system noisier, more brittle, or harder to operate than a smaller approach.

### 2. Prefer The Smallest Durable Change

Implement the minimum code that solves the real user problem. Avoid speculative options, one-off abstractions, and configurability that the current product does not need.

Before adding a new layer, check whether an existing module, helper, provider, or test harness can be extended cleanly. If a change is growing larger than expected, stop and re-check whether the problem was framed too broadly.

### 3. Keep Diffs Surgical

Every changed line should connect to the request or to verification required by the request. Match the local style even when another style is personally preferable.

Do not clean up adjacent code, comments, formatting, or dead branches unless they are directly involved. Remove only the unused imports, variables, tests, or files created by your own change.

### 4. Work From Success Criteria

Turn a task into a verifiable goal before editing:

- Bug fix: reproduce or identify the failing behavior, patch it, then run the narrowest meaningful test.
- Feature: define the user-visible behavior, patch it, then verify UI/API/state behavior.
- Refactor: prove behavior is preserved with tests or before/after checks.
- Review: lead with concrete risks, file/module references, and missing verification.

For multi-step work, keep a short checklist with a verification point for each step. Do not claim completion until the relevant checks have run or you have clearly reported why they could not run.

## Repo Fit

This skill is intentionally softer than `AGENTS.md`. Follow `AGENTS.md` first for mandatory repo rules such as language, Git, CI, data safety, build outputs, UI checks, and PR formatting.

When this skill conflicts with a user instruction or a repository policy, follow the higher-priority instruction and mention the tradeoff if it affects the result.
