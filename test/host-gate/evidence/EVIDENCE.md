# Bridge #90 — real VS Code Host authorization gate (evidence)

**Verdict: PASS** — 10/10 required cases passed against a real VS Code 1.143.1 extension host, with the real
`@modelcontextprotocol/sdk` client over the bridge's real authenticated loopback SSE transport (no
`InMemoryTransport`, no mocked `vscode`). No product source change was needed. One successful launch, plus one
earlier launch that failed only on an over-strict harness assertion (documented below); 2 of the 3 allowed host
launches were used.

- Source (sole editor worktree): `1827501466c9c81e408e04a2a6a9f0698ec535c1`, branch `test/real-host-90-20261028`,
  base `bdab9eb`, controlled logic commit `cf03f89`.
- Controlled bundle: `out/extension.js`, SHA-256 `9585228e8dcb661d31c97c4a033dd8f99e568f3f2ef5f603866cb4268c1ed821`,
  881 640 bytes, built once with `node esbuild.config.js --production`.
- Fixture extension: `sc-agent-ide-fixture.bridge90-fixture` 0.0.1,
  `extension.js` SHA-256 `1ab083c43bccad3166689b04c0bbb544e220c87ea5b31d2b7f01022191260df9` (committed, harmless).
- Host: installed app `Visual Studio Code.app` 1.143.1 (`Code`, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`),
  launched executable `Contents/MacOS/Code`.
- SDK: `@modelcontextprotocol/sdk` 1.27.1 (client and bundled server), `zod` 3.25.76.
- Full machine evidence: `test/host-gate/evidence/host-gate-run.json` (redacted: no token, no private paths).
- Raw launcher stdout for both attempts: `evidence/launch-1-failed-run-output.txt`,
  `evidence/launch-2-pass-run-output.txt` (launcher already placeholder-redacts paths; no secrets).

## Commands and exits

| # | Command | Exit |
|---|---|---|
| 1 | `rm -f out/extension.js out/extension.js.map && node esbuild.config.js --production` | 0 (bundle 881 640 B, SHA above) |
| 2 | `npx tsc --noEmit` | 0 |
| 3 | `node --check test/host-gate/host/index.js && node --check test/host-gate/fixture/extension.js && node --check test/host-gate/runner/launch.mjs` | 0 |
| 4 | `node test/host-gate/runner/preflight.mjs 9585…ed821` (static only, no launch) | 0 |
| 5 | auxiliary static JS analysis: `npx tsc --noEmit --allowJs --checkJs … test/host-gate/{host,runner}` | 2 — only 5 TS2339 narrowing notes (`err.code`, `server.address().port`); no undefined-identifier findings. Not a gate. |
| 6 | Host launch **1**: `node test/host-gate/runner/launch.mjs --expect-bundle-sha 9585…ed821 --timeout-sec 300` | **1 (FAIL)** |
| 7 | Host launch **2**: same command | **0 (PASS)** |

Launch 1 (`pid 41397`, port 52085, exit 1, 11 341 ms): 9/10 cases passed; `case10` failed only the harness
assertion “exactly one document change event” because VS Code also emits a **zero-content-change** change event on
the first dirty-state transition. Harness assertion corrected to count content-bearing events; no product change.
Its revert-cleanup comparison also read the extension-host document before the revert propagated; cleanup now
polls, uses the editor revert path and reopens the document.

Launch 2 (`pid 45279`, pgid 45279, port 52315, exit 0, 12 630 ms): PASS.

## Launch configuration (names only; token never recorded)

Real app executable with: `--user-data-dir=<tmp>/user-data`, `--extensions-dir=<tmp>/extensions`,
`--extensionDevelopmentPath=<bridge worktree>`, `--extensionDevelopmentPath=<fixture>`,
`--extensionTestsPath=<repo>/test/host-gate/host/index.js`, `--disable-workspace-trust`, `--disable-updates`,
`--disable-crash-reporter`, `--disable-telemetry`, `--skip-welcome`, `--skip-release-notes`, `--disable-gpu`,
`--preserve-env`, `--new-window`, `<tmp>/workspace`.

Env names passed: `BRIDGE90_EVIDENCE_DIR`, `BRIDGE90_PORT`, `BRIDGE90_EXPECT_BUNDLE_SHA`,
`BRIDGE90_EXPECT_FIXTURE_SHA`, `BRIDGE90_BRIDGE_DIR`, `BRIDGE90_FIXTURE_DIR`, `BRIDGE90_APP_ROOT`,
`BRIDGE90_DEPLOYED_DIR`, `BRIDGE90_SDK_VERSION`, `BRIDGE90_LAUNCH_FLAGS`. The single-use bearer token exists only
in the ephemeral workspace `settings.json` (deleted); it is absent from every committed file.

## Mode attribution

- Fixture reached the extension host as a development extension: its own `ExtensionContext.extensionMode` was
  observed as **3 (Test)** (also `vscodeVersion 1.143.1`, `appHost desktop`).
- Bridge mode is **not directly observable**: `Extension` has no `extensionMode` property and only an extension
  sees its own `ExtensionContext`. Provenance instead: loaded from `--extensionDevelopmentPath` into an
  extension-test host (launch flags recorded), active, with the exact controlled bundle hash verified *inside* the
  host. No forged/assigned mode.
- Only two non-builtin extensions were loaded (the bridge and the fixture); the deployed
  `jhamama.vscode-mcp-bridge-ext-0.2.5` build is absent on disk and was not loaded.

## Coverage — 10/10 required cases (real SDK `tools/call` → real bridge → real VS Code providers)

| Case | Expectation | Observed |
|---|---|---|
| 01 empty list direct deny | `execute_vscode_command` rejected with empty allowlist | MCP tool error; text is the allowlist rejection naming the command; `directDenied` counter 0; doc version unchanged |
| 02 nonempty allow listed direct | allowlisted command runs once | success payload; `directAllowed` counter **1**; forwarded args `[{case:"02"}]` observed by the fixture command |
| 03 nonmember deny | command absent from non-empty allowlist rejected | tool error naming the command; counter 0 |
| 04 empty object `CodeAction.command` deny | object-carried command denied with empty allowlist | provider offered the action (positive control); tool error naming the command; counter 0; no edit, no change event; line 3 unchanged |
| 05 empty bare command deny | bare-string `CodeAction.command` denied | provider offered the action (positive control); tool error naming the command; counter 0; no edit; line 4 unchanged |
| 06 object carrier membership | same allowlist decides positive and negative | positive: applied, `objectAllowed` counter **1** with args `[{case:"06a"}]`, no edit; negative: denied, `objectDenied` counter 0, no edit, line 6 unchanged |
| 07 denied combined rejects before edit | edit+denied command rejected before any edit | tool error naming the command; document version unchanged; **0** change events; line 7 baseline; `combinedDenied` counter 0 |
| 08 all denied counters 0 + document unchanged | aggregate | all four denied counters **0**; lines 0–7 baseline; on-disk target byte-identical to baseline; only the two authorized markers present |
| 09 allowed combined edit precedence | edit applied once, carried allowed command **not** executed | `applied:true`; line 8 replaced exactly once; marker count 1; one content-bearing change event; version +1; `combinedAllowed` counter **0** |
| 10 edit-only allowed even empty | edit applies with empty allowlist | `applied:true`; line 9 replaced; one content-bearing change event; version +1; document dirty, not auto-saved; every command counter 0 |

Positive controls for every denial: the fixture provider demonstrably offered the action (`get_code_actions`
matched title), and allowlisted calls executed (counter + arguments observed), so a missing tool/provider cannot
masquerade as a denial. Every denial asserts the specific allowlist error text naming the command, not merely
`isError`.

## Transport / configuration facts

- `GET /health` → `{"status":"ok","version":"0.2.5","connectedAgents":0,"port":52315}`.
- Unauthenticated `GET /sse` → **401**; wrong bearer token → **401**; real client with the bearer token →
  MCP `initialize` + `tools/list` (27 tools) and successful `tools/call`s.
- Phase 1 used the empty allowlist (workspace default `[]`). Phase 2 used
  `[directAllowed, objectAllowed, combinedAllowed]`, applied through the real VS Code configuration API; the
  observed bridge restart went down (health refused), back up and stable on the same loopback port, with the
  effective setting read back exactly.
- Target fixture document: 10-line plaintext file; all edits/reads went through real `WorkspaceEdit`/
  `executeCodeActionProvider`/`registerCommand` inside the host.

## Cleanup proof

- `pid 45279` / pgid 45279; app exit code 0 (no signal). Process group empty afterwards
  (`kill(-pgid,0)` → ESRCH); owned tree sampled during the run contained 4 processes, **0** matching
  `sclang|scsynth|supernova`.
- Port 52315 closed after exit (`portOpenAfterExit: false`). Port 3333 was never used.
- Bridge `mcpServer.stop` executed; `/health` refused afterwards. Client closed; target document reverted
  (editor revert path; reopened document equals baseline, not dirty); target file on disk byte-identical to
  baseline throughout. Ephemeral tmp root deleted (`tmpRemoved: true`).
- A separate static scan found no SuperCollider reference in the harness/fixture. Three pre-existing SuperCollider
  processes owned by the user environment were observed (count only) and untouched; this gate neither starts nor
  signals any SC process, and does not touch the current Bridge deployment or GitHub.

## Scope / non-claims

No product code changed (`git status` shows only the new `test/host-gate/` harness, fixture and evidence). No
SuperCollider, no current-Bridge deployment, no merge/push, no market/production deployment, no CI claim. This is
the named real-Host e2e for this issue only.

## Reproduce

```bash
npm run build:prod                       # or: node esbuild.config.js --production
node test/host-gate/runner/launch.mjs --expect-bundle-sha 9585228e8dcb661d31c97c4a033dd8f99e568f3f2ef5f603866cb4268c1ed821
```

`launch.mjs` runs the static producer/consumer preflight (`runner/preflight.mjs`) before starting anything, then
starts exactly one real extension host and writes the redacted evidence JSON next to this file. The fixture
(`fixture/`) and runner (`host/index.js`) are plain Node, no test framework.
