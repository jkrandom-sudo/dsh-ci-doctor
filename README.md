# dsh-ci-doctor

[中文](./README.zh.md) · [npm](https://www.npmjs.com/package/dsh-ci-doctor) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

**CI failure, diagnosed before you even open the logs.** `dsh-ci-doctor` watches GitHub Actions for new failures, turns raw job logs into structured findings — normalized error signatures, failure categories, suspect files, trimmed log excerpts — and remembers every signature it has ever seen, so repeat failures are called out on sight. All through two agent tools and the `gh` CLI you already have authenticated.

## Usage

Just ask your agent in plain language — it picks the right tool:

- _"Watch CI on this repo and tell me when something fails"_ → starts a `ci_watch` background job.
- _"Why did the nightly build fail?"_ → runs `ci_diagnose` on the latest failed run and hands you the diagnosis card.
- _"Diagnose run 31782742089 on cli/cli"_ → targeted diagnosis of one specific run.

You get a markdown diagnosis card straight in the chat:

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

## What it does

**1. Watch — the `ci_watch` tool.** Starts a background job that polls for _new_ failed runs (the first poll sets a baseline, so historical red runs never fire the alarm):

```json
{ "repo": "owner/name", "branch": "main", "intervalSeconds": 30, "timeoutMinutes": 60 }
```

- Streams status lines you can read any time; cancel any time.
- Backs off exponentially on transient errors, gives up after 5 consecutive failures, fails immediately on auth errors.
- On detection it settles with a ready-made next step: `call ci_diagnose with repo="…" runId=…`.
- Watch a repo explicitly, or omit `repo` to watch the current working directory's repository.

**2. Diagnose — the `ci_diagnose` tool.** Point it at a run (or the latest failed run) and it returns the card shown above:

```json
{ "repo": "owner/name", "runId": 31782742089 }
```

- Error signatures are normalized (timestamps, hex ids, and numbers masked) so the _same_ failure gets the _same_ id across runs.
- Each signature is classified: test / build / lint / typecheck / dependency / network / permission / timeout / infra.
- Suspect files are mined from the log, vendor paths dropped.
- Log excerpts are trimmed to a budget with honest `… (skipped N lines) …` markers — content is never invented.

**3. The failure-signature ledger.** Every diagnosed signature is remembered — how many times seen, first/last sighting, last repo and run URL. Repeat failures surface as `seen 3×` in the report instead of pretending to be new. The ledger persists as a `ci_doctor` storage unit in the DSH storage directory when the profile provides a storage domain; it is in-memory otherwise.

## Read-only by contract

Both tools only ever _read_ GitHub state (via `gh api`). They never push, merge, cancel, rerun, or write anything to your repositories. Every result carries a `repositoryWrites: false` marker, and the package ships an optional invariant companion (`dsh-ci-doctor/invariant`) that fails loudly if a result ever loses that marker on hosts with an `invariants` service.

## Install

```bash
dsh plugin --profile web add dsh-ci-doctor
```

Prerequisites: the [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`) — the plugin reuses that session, there is nothing else to configure.

## Configuration

| Option                | Default | Meaning                                   |
| --------------------- | ------- | ----------------------------------------- |
| `pollIntervalSeconds` | `30`    | Seconds between watch polls (min 5).      |
| `watchTimeoutMinutes` | `60`    | Wall-clock lifetime of one watch (min 1). |
| `maxLogLines`         | `200`   | Per-job log excerpt budget (min 20).      |
| `ghBin`               | `gh`    | GitHub CLI executable.                    |
| `ledgerEnabled`       | `true`  | Record signatures into the ledger.        |

## How it works

The plugin speaks to the host only through documented Cordis seams and imports no `@deepseek-ai/*` package:

- `tools` — registers `ci_watch` / `ci_diagnose` on the real tool runtime.
- `jobs` — `ci_watch` runs as a first-class streaming background job, owned by the calling agent.
- `shell` — every `gh` call goes through the host's guarded, sandboxed execution pipeline.
- `storageDomain` — the signature ledger persists as the `ci_doctor` storage unit.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build   # types, unit tests, bundle
pnpm format:check                           # Prettier
```

## License

MIT
