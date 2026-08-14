# dsh-ci-doctor

[中文](./README.zh.md) · [npm](https://www.npmjs.com/package/dsh-ci-doctor) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

**CI failure, diagnosed before you even open the logs.** `dsh-ci-doctor` watches GitHub Actions for new failures, turns raw job logs into structured findings — normalized error signatures, failure categories, suspect files, trimmed log excerpts — and remembers every signature it has ever seen, so repeat failures are called out on sight. All through two agent tools and the `gh` CLI you already have authenticated.

## What it does

**1. Watch — the `ci_watch` tool.** Starts a background job on the host's job registry that polls for *new* failed runs (the first poll sets a baseline, so historical red runs never fire the alarm):

```json
{ "repo": "owner/name", "branch": "main", "intervalSeconds": 30, "timeoutMinutes": 60 }
```

- Streams status lines you can read any time (`job_read`); cancel any time (`job_kill`).
- Backs off exponentially on transient errors, gives up after 5 consecutive failures, fails immediately on auth errors.
- On detection it settles with a ready-made next step: `call ci_diagnose with repo="…" runId=…`.
- Watch a repo explicitly, or omit `repo` to watch the current working directory's repository.

**2. Diagnose — the `ci_diagnose` tool.** Point it at a run (or the latest failed run) and it returns a markdown diagnosis card:

```json
{ "repo": "owner/name", "runId": 31782742089 }
```

```markdown
## CI diagnosis: cli/cli run #31782742089

**Conclusion:** failure · [run](https://github.com/cli/cli/actions/runs/31782742089)

### Job: Issue Triage (skills-driven)

**Failed steps:** triage
**Signatures:**
- `81a0edf32878` (timeout, first time seen) — server:http_server Session timeout configured…
**Suspect files:** `script/triage.ts`
<details><summary>Log excerpt</summary>
…
</details>
```

- Error signatures are normalized (timestamps, hex ids, and numbers masked) so the *same* failure gets the *same* id across runs.
- Each signature is classified: test / build / lint / typecheck / dependency / network / permission / timeout / infra.
- Suspect files are mined from the log, vendor paths dropped.
- Log excerpts are trimmed to a budget with honest `… (skipped N lines) …` markers — content is never invented.

**3. The failure-signature ledger.** Every diagnosed signature is remembered — how many times seen, first/last sighting, last repo and run URL. Repeat failures surface as `seen 3×` in the report instead of pretending to be new. Durable through the host's storage domain (`~/.dsh/storages/ci_doctor.json`) when the profile provides one; in-memory otherwise.

## Read-only by contract

Both tools only ever *read* GitHub state (via `gh api`). They never push, merge, cancel, rerun, or write anything to your repositories. Every canonical result carries `repositoryWrites: false`, and the package ships an optional invariant companion (`dsh-ci-doctor/invariant`) that fails loudly if a result ever loses that marker on hosts with an `invariants` service.

## Install

```bash
dsh plugin --profile web add dsh-ci-doctor
```

Prerequisites: the [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`) — the plugin reuses that session, there is nothing else to configure.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `pollIntervalSeconds` | `30` | Seconds between watch polls (min 5). |
| `watchTimeoutMinutes` | `60` | Wall-clock lifetime of one watch (min 1). |
| `maxLogLines` | `200` | Per-job log excerpt budget (min 20). |
| `ghBin` | `gh` | GitHub CLI executable. |
| `ledgerEnabled` | `true` | Record signatures into the ledger. |

## How it works

The plugin speaks to the host only through documented Cordis seams and imports no `@deepseek-ai/*` package:

- `tools` — registers `ci_watch` / `ci_diagnose` on the real tool runtime.
- `jobs` — `ci_watch` runs as a first-class streaming background job, owned by the calling agent.
- `shell` — every `gh` call goes through the host's guarded, sandboxed execution pipeline; JSON responses are projected with `--jq` so they stay far under capture caps.
- `storageDomain` — the signature ledger persists as the `ci_doctor` storage unit (optional peer: `zod`).

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build   # local gate: types, 85 unit tests, bundle
pnpm format:check                           # Prettier
node scripts/verify-web-profile.mjs         # real-environment check
```

The real-environment check boots the actual local `web` profile composition in-process (webserver overlaid to port 0), dispatches the real host exec shape `{ name, arguments }` through the tool waterfalls, runs a live read-only diagnosis against GitHub, starts/kills a real watch job, and proves the ledger survives process exit.

## Verification (v0.1.0)

- **Unit:** 85/85 tests green (signatures, log trimming, gh client, watcher state machine, ledger, plugin wiring, invariant companion).
- **Real environment:** in-process `boot()` of the local `web` profile — 18/18 checks passed: tools registered on the real runtime, both waterfalls accepted the `{ name, arguments }` exec shape, live `ci_diagnose` against `cli/cli` run [#31782742089](https://github.com/cli/cli/actions/runs/31782742089) extracted 8 signatures, a real `ci_watch` job streamed its baseline and settled on kill, and the ledger persisted to `~/.dsh/storages/ci_doctor.json`.

## License

MIT
