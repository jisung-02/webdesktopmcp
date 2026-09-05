# Security Policy

webdesktopmcp is an experimental bridge between desktop webviews and external MCP clients. For its technical trust boundaries and known limitations, read [the security model](docs/security.md) and [support matrix](docs/support.md).

## Supported versions

Security fixes are developed on `main`. Reports about the current code and the latest published version are welcome; include the exact package version or commit. Older versions do not have a guaranteed backport policy. There is no long-term support or guaranteed response schedule.

## Reporting a vulnerability

Do not put exploit details, credentials, private data, or proof-of-concept code in a public issue or pull request.

Use GitHub's **Report a vulnerability** button on the repository's [Security Advisories page](https://github.com/jisung-02/webdesktopmcp/security/advisories) when available. This submits a private report to the maintainers. If the button is unavailable, open a public issue containing only a request to enable private reporting; wait for a private channel before sharing technical details. Never include live bearer tokens or registry contents.

Include the following in the private report:

- Affected package, version or commit, operating system, and desktop runtime version.
- Native or polyfill mode, relevant host configuration, and the required attacker access.
- A minimal reproduction using synthetic data, expected behavior, and observed behavior.
- Impact, affected trust boundary, and any proposed mitigation.

Relevant reports include unauthorized tool discovery or execution, forged origins or frame identities, cross-frame result injection, token exposure, and unsafe lifecycle behavior that crosses a documented trust boundary. A limitation documented in the security model can still merit a report if its impact differs from the stated assumptions.

Maintain confidentiality while a report is investigated. Disclosure timing and fixes should be coordinated with the maintainers. Reporting does not authorize testing other people's applications or data.

## Maintainer setup

A policy file does not enable private reporting. Repository administrators must enable **Private vulnerability reporting** in GitHub's security settings and monitor incoming reports. Follow [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
