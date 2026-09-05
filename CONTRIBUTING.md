# Contributing

Thanks for contributing to webdesktopmcp. Read the [support matrix](docs/support.md), [protocol](docs/protocol.md), and [reference mapping](docs/references.md) before changing bridge behavior. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 20 or newer and the pnpm version in the root `packageManager` field (currently 10.32.1). Go changes require Go 1.22 or newer. Rust/Tauri changes require a toolchain compatible with the checked-in Cargo.lock and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/); use current stable Rust for local validation.

```sh
git clone https://github.com/jisung-02/webdesktopmcp.git
cd webdesktopmcp
pnpm install --frozen-lockfile
pnpm build
```

The monorepo contains the page implementation in `packages/core`, wire types in `packages/protocol`, the Node host in `packages/server`, Electron/React/CLI packages, the Rust Tauri plugin in `crates/tauri-plugin-webdesktopmcp`, and the Go host in `go/webdesktopmcp`.

## Branches and commits

Use a type prefix and a kebab-case description, for example `fix/registration-cleanup` or `docs/security-policy`. Keep each commit focused on one logical change.

Use the repository's lore-style convention: a Conventional Commit subject (`fix:`, `feat:`, `docs:`, or `chore:`), a short problem/result explanation, and decision-record trailers. This repository defines the portable format below; it does not require a private local skill.

```text
docs: explain registration cleanup

Describe the cleanup contract and its limits so integrations can manage
component lifetimes without assuming a native unregisterTool method.

Decision: Document AbortSignal-based registration cleanup.
Alternatives: Avoid relying on a nonstandard native unregisterTool method.
Validation: Checked documented APIs and local Markdown links.
```

Record actual decisions and checks; do not invent alternatives or test results. Use one logical change per commit.

## Coding assistants

Use [AGENTS.md](AGENTS.md) as the shared instructions. [Assistant setup and official references](docs/ai-assistants.md) describe the Codex, Claude Code, GitHub Copilot, and Cursor entry points.

## Making a change

- Preserve the distinction between upstream WebMCP behavior and this library's extensions. Cite official sources when changing compatibility claims.
- Validate sender identity and tool ownership at the host boundary. Treat page-supplied metadata and tool arguments as untrusted.
- Add regression coverage for behavior changes, preferably in the existing relevant test file. Documentation-only changes need link and formatting checks.
- Edit the shared TypeScript core and adapter entry points rather than generated JavaScript bundles. Run `pnpm build:native` and include regenerated `bootstrap.js` files for Tauri and Wails.
- Keep dependency changes intentional and update the relevant lockfile. Preserve third-party license notices.

## Validation

For TypeScript or shared bridge changes:

```sh
pnpm build
pnpm typecheck
pnpm test
```

For Go host changes:

```sh
cd go/webdesktopmcp
go test -race ./...
```

For Rust host changes:

```sh
cd crates/tauri-plugin-webdesktopmcp
cargo test --locked
```

For Electron preload, IPC, or lifecycle changes, also run the real integration test in a graphical desktop session:

```sh
pnpm --filter @webdesktopmcp/electron test:smoke
```

Before submitting, run `pnpm check:generated` and `git diff --check`. State which checks ran and any unavailable platform checks in the PR. Mock tests and a polyfill smoke run do not prove native WebMCP compatibility; record the actual runtime and mode when reporting integration results.

## Pull requests

Use the PR template to explain the problem, resulting behavior, validation, and material limitations. Link related issues. Changes to the protected `main` branch must go through a pull request. Keep the English README accurate and update affected translations, support documentation, and references when behavior changes.

## License

The project uses the [MIT License](LICENSE). Contributions are submitted under that license. Only contribute material you have the right to distribute, and preserve the license and copyright notices in redistributed copies.
