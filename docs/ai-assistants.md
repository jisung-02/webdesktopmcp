# Coding assistant instructions

The repository keeps shared guidance in [AGENTS.md](../AGENTS.md). Tool entry points are small so implementation rules can be maintained in one place. All shared assistant instructions are written in English.

| Assistant | Entry point | How the shared rules are supplied |
|---|---|---|
| OpenAI Codex | [AGENTS.md](../AGENTS.md) | Repository instructions are discovered through the AGENTS.md hierarchy. |
| Claude Code | [CLAUDE.md](../CLAUDE.md) | Imports the root AGENTS.md with `@AGENTS.md`. |
| GitHub Copilot | [.github/copilot-instructions.md](../.github/copilot-instructions.md) | Provides essential constraints and directs the assistant to read AGENTS.md. |
| Cursor | [.cursor/rules/repository.mdc](../.cursor/rules/repository.mdc) | An always-applied project rule references AGENTS.md. Cursor also supports AGENTS.md directly. |
| Other assistants | [AGENTS.md](../AGENTS.md) | Use native AGENTS.md support where available; otherwise attach or load the file explicitly. |

A Markdown link is not a universal import mechanism. Claude's `@` imports, Cursor rule references, and Copilot's instructions have different loading behavior. Instructions guide assistants; they do not enforce permissions, execute checks, or replace review.

## Maintenance and verification

Update AGENTS.md when project boundaries or commands change. Keep the Copilot summary aligned and avoid duplicating the complete guide in every tool file. Use repository-relative paths; do not import a maintainer's home directory or require private skills.

When setting up an assistant, open the repository root and inspect its loaded instructions. In Claude Code, use `/memory` to inspect loaded memory files. In Cursor, check that the repository rule is enabled with Always Apply. For Copilot, check the instructions reference in the response where supported. Ask Codex to summarize the repository instructions it loaded. Available diagnostics vary by client and version.

The entry-point paths, imports, and local document links were checked when these files were added. This does not claim a live instruction-loading test in all four products.

## Official references

Reviewed on 2026-09-05. These documents describe tool behavior and can change independently of this repository.

- [OpenAI: Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)
- [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [GitHub: Adding repository custom instructions for Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- [Cursor: Rules](https://prod.cursor.com/docs/rules)
