---
name: project-governance
description: Use when starting or resuming work in this repository, handing off context, or amending project rules and reviewer responsibilities.
---

# Project governance

Resolve paths from the repository root. Read `AGENTS.md`, `.project/constitution.md`
and `.project/context.md`, then only the scoped rules and reviewer definitions
matching the task's paths and risks. Read `.project/decisions.md` for amendments,
exceptions and unresolved conflicts. Check nested agent instructions when present.

Pass this context to the chosen workflow and each reviewer:
- Task, intended outcome, affected paths and exclusions.
- Constitution version, applicable rule IDs and canonical source paths.
- Relevant architecture decisions, checks, reviewers and evidence requirements.
- Open decisions and scoped exceptions, including authority and expiry.

Keep established rules distinct from proposals. Do not waive rules or treat an AI
review as human merge approval. Amend governance through the constitution's
amendment process. Keep project policy in `.project/`, not duplicated in skills.

For change review, read [project-review](../project-review/SKILL.md).
Use `.work/` for plans, reports and scratch evidence as directed by `AGENTS.md`.
These instructions require no global installation, Claude command or particular
agent tool. An agent without skill discovery must read these files by path.
