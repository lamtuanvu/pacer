# Security policy

## Supported versions

Only the latest released 0.x minor line is supported, at its latest patch version. Older minor lines do not receive security fixes; upgrade to the current line.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/lamtuanvu/pacer/security/advisories/new): open the repository's **Security** tab and choose **Report a vulnerability**. Never report vulnerabilities in public issues. This channel will be available when the GitHub repository and private reporting are enabled.

Include the pacer version, OS, reproduction steps, impact and a minimal example where possible. Remove tokens, credentials and private repository content. The maintainer aims to acknowledge reports within 7 days, then coordinate investigation and disclosure privately.

## Scope

pacer runs local executor CLIs and supplied acceptance commands, reads local usage/session files and manages planner integration files. Reports involving unintended command execution, credential disclosure, unsafe file writes or unauthorized access to its local HTTP service are in scope. Executor permissions and configured external services also affect the environment; include those details when relevant.
