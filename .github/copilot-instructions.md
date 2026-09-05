# GitHub Copilot instructions

Read and follow [AGENTS.md](../AGENTS.md) before editing. It contains the shared project rules, architecture boundaries, validation commands, and commit conventions. Consult [CONTRIBUTING.md](../CONTRIBUTING.md) for setup.

Essential constraints for suggestions and reviews:

- Edit shared TypeScript sources rather than generated Tauri/Wails bundles; regenerate with `pnpm build:native`.
- Trace wire-contract changes through TypeScript, Rust, and Go hosts.
- Verify host-side sender identity, ownership, and access checks. Treat renderer metadata and tool arguments as untrusted.
- Keep registration cleanup, execution cancellation, and native/polyfill behavior distinct.
- Cite official sources for compatibility claims. Do not infer native WebMCP conformance from mocks or version numbers.
- Run relevant checks from `AGENTS.md` and report only validation actually performed.
- Write shared instructions, new code comments, commit messages, and PR descriptions in English. Preserve existing translation languages.
- Use kebab-case branch descriptions and the lore-style commit convention in `CONTRIBUTING.md`.

Keep this summary consistent with `AGENTS.md`. Do not include secrets, registry contents, or private vulnerability details in suggestions or review comments.
