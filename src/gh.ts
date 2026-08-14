/**
 * GitHub CLI client. Every call goes through an injectable command runner so
 * tests never spawn a process and production wires `ctx.shell` (the host's
 * guarded execution pipeline) without importing host packages.
 * @module dsh-ci-doctor/gh
 */

/** Minimal result of one finished command, mirroring the host shell's shape. */
export interface CommandResult {
  /** Process exit code; null when killed by a signal. */
  exitCode: number | null
  /** Captured stdout text. */
  stdout: string
  /** Captured stderr text. */
  stderr: string
  /** True when the runner's own timeout cut the command short. */
  timedOut?: boolean
}

/** Extra knobs for one command execution. */
export interface CommandOptions {
  /**
   * Per-call stdout capture budget in bytes. Host shell executors cap
   * captured output (dsh-bash-local defaults to 64 KiB, keeping the tail) —
   * large payloads must either shrink (jq projections) or raise this.
   */
  stdoutMaxBytes?: number
}

/** One command execution — the seam tests and the host shell both implement. */
export type CommandRunner = (command: string, options?: CommandOptions) => Promise<CommandResult>

/** Typed failure of one GitHub call. */
export type GhErrorKind = 'auth' | 'not-found' | 'rate-limit' | 'timeout' | 'api'

/** Error raised for any failed `gh` invocation, classified for the caller. */
export class GhError extends Error {
  readonly kind: GhErrorKind
  constructor(kind: GhErrorKind, message: string) {
    super(message)
    this.name = 'GhError'
    this.kind = kind
  }
}

/** One workflow run, normalized from the Actions API. */
export interface GhRun {
  /** Numeric run id. */
  id: number
  /** Workflow display name. */
  name: string
  /** Branch the run executed on. */
  branch: string
  /** Head commit SHA. */
  headSha: string
  /** API conclusion (failure, success, …). */
  conclusion: string
  /** Run status (completed, in_progress, …). */
  status: string
  /** Browser URL of the run. */
  url: string
  /** ISO creation timestamp. */
  createdAt: string
}

/** One failed step inside a job. */
export interface GhFailedStep {
  /** Step name as shown in the workflow log. */
  name: string
  /** Step conclusion (failure, cancelled, …). */
  conclusion: string
}

/** One job of a workflow run. */
export interface GhJob {
  /** Numeric job id (used to fetch logs). */
  id: number
  /** Job name. */
  name: string
  /** Job conclusion. */
  conclusion: string
  /** Failed steps of this job. */
  failedSteps: GhFailedStep[]
}

/** GitHub operations the doctor needs. */
export interface GhClient {
  /** Resolve `owner/name` of the repository a working directory belongs to. */
  currentRepo(workdir?: string): Promise<string>
  /** List recent failed runs, newest first. */
  listFailedRuns(options: ListRunsOptions): Promise<GhRun[]>
  /** Fetch one run's detail. */
  getRun(repo: string, runId: number): Promise<GhRun>
  /** List a run's jobs with their failed steps. */
  listJobs(repo: string, runId: number): Promise<GhJob[]>
  /** Fetch one job's plain-text log. */
  fetchJobLog(repo: string, jobId: number): Promise<string>
}

/** Filters for listing failed runs. */
export interface ListRunsOptions {
  /** `owner/name` repository. */
  repo: string
  /** Optional branch filter. */
  branch?: string
  /** Optional workflow name or filename filter. */
  workflow?: string
  /** Maximum runs returned (API page size). */
  limit?: number
}

interface RawRun {
  id?: number
  name?: string
  head_branch?: string
  head_sha?: string
  conclusion?: string | null
  status?: string
  html_url?: string
  created_at?: string
}

interface RawStep {
  name?: string
  conclusion?: string | null
}

interface RawJob {
  id?: number
  name?: string
  conclusion?: string | null
  steps?: RawStep[]
}

function normalizeRun(raw: RawRun): GhRun {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    branch: raw.head_branch ?? '',
    headSha: raw.head_sha ?? '',
    conclusion: raw.conclusion ?? '',
    status: raw.status ?? '',
    url: raw.html_url ?? '',
    createdAt: raw.created_at ?? '',
  }
}

function normalizeJob(raw: RawJob): GhJob {
  const steps = Array.isArray(raw.steps) ? raw.steps : []
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    conclusion: raw.conclusion ?? '',
    failedSteps: steps
      .filter(step => step.conclusion === 'failure' || step.conclusion === 'cancelled')
      .map(step => ({ name: step.name ?? '', conclusion: step.conclusion ?? '' })),
  }
}

/** Classify one failed gh invocation from its stderr text. */
function classifyGhFailure(stderr: string, timedOut: boolean): GhErrorKind {
  if (timedOut) return 'timeout'
  const text = stderr.toLowerCase()
  if (/rate limit|403.*forbidden.*rate|429/.test(text) && /rate|too many/.test(text))
    return 'rate-limit'
  if (/not found|404/.test(text)) return 'not-found'
  if (/auth|login|credentials|401|bad credentials|unauthorized/.test(text)) return 'auth'
  return 'api'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build a GitHub client over an injectable command runner.
 * @param run - Executes one shell command line and captures its output.
 * @param ghBin - GitHub CLI executable (default "gh").
 * @returns The doctor's GitHub client.
 */
export function createGhClient(run: CommandRunner, ghBin = 'gh'): GhClient {
  // ghBin comes from configuration, not the model — but it crosses into a
  // shell command line, so quote it like everything else (a path with spaces
  // would otherwise break every call, and a hostile value would execute).
  const bin = shellQuote(ghBin)
  /**
   * Run `gh api <endpoint>` and parse stdout as JSON. JSON endpoints always
   * carry a --jq projection: the full API payloads dwarf the host shell's
   * capture cap (64 KiB by default), and a truncated tail is unparseable.
   */
  async function apiJson<T>(endpoint: string, jq: string): Promise<T> {
    const result = await run(`${bin} api ${shellQuote(endpoint)} --jq ${shellQuote(jq)}`)
    return parseApiResult<T>(endpoint, result)
  }

  /** Shared exit-code classification + JSON parse for apiJson. */
  function parseApiResult<T>(endpoint: string, result: CommandResult): T {
    if (result.exitCode !== 0) {
      const kind = classifyGhFailure(result.stderr, result.timedOut === true)
      throw new GhError(
        kind,
        `gh api ${endpoint} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      )
    }
    try {
      return JSON.parse(result.stdout) as T
    } catch {
      const preview = result.stdout.trim().slice(0, 200)
      throw new GhError(
        'api',
        `gh api ${endpoint} returned non-JSON output${preview === '' ? ' (empty stdout)' : `: ${preview}`}`,
      )
    }
  }

  return {
    async currentRepo(workdir) {
      const cd = workdir === undefined ? '' : `cd ${shellQuote(workdir)} && `
      const result = await run(`${cd}${bin} repo view --json nameWithOwner --jq .nameWithOwner`)
      if (result.exitCode !== 0 || result.stdout.trim() === '') {
        throw new GhError(
          'not-found',
          `could not resolve the current repository: ${result.stderr.trim() || 'not a GitHub workdir'}`,
        )
      }
      return result.stdout.trim()
    },

    async listFailedRuns(options) {
      const limit = options.limit ?? 10
      let endpoint = `repos/${options.repo}/actions/runs?status=failure&per_page=${limit}`
      if (options.branch !== undefined) endpoint += `&branch=${encodeURIComponent(options.branch)}`
      if (options.workflow !== undefined) {
        endpoint = `repos/${options.repo}/actions/workflows/${encodeURIComponent(options.workflow)}/runs?status=failure&per_page=${limit}`
        if (options.branch !== undefined)
          endpoint += `&branch=${encodeURIComponent(options.branch)}`
      }
      const payload = await apiJson<{ workflow_runs?: RawRun[] }>(
        endpoint,
        '{workflow_runs: [.workflow_runs[] | {id, name, head_branch, head_sha, conclusion, status, html_url, created_at}]}',
      )
      return (payload.workflow_runs ?? []).map(normalizeRun)
    },

    async getRun(repo, runId) {
      const payload = await apiJson<RawRun>(
        `repos/${repo}/actions/runs/${runId}`,
        '{id, name, head_branch, head_sha, conclusion, status, html_url, created_at}',
      )
      return normalizeRun(payload)
    },

    async listJobs(repo, runId) {
      const payload = await apiJson<{ jobs?: RawJob[] }>(
        `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        '{jobs: [.jobs[] | {id, name, conclusion, steps: [.steps[]? | {name, conclusion}]}]}',
      )
      return (payload.jobs ?? []).map(normalizeJob)
    },

    async fetchJobLog(repo, jobId) {
      // Raw logs can be megabytes; raise the capture budget well past the
      // host shell's 64 KiB default so trimLog — not the executor's tail
      // truncation — decides what the diagnosis sees.
      const result = await run(
        `${bin} api ${shellQuote(`repos/${repo}/actions/jobs/${jobId}/logs`)}`,
        { stdoutMaxBytes: 4_000_000 },
      )
      if (result.exitCode !== 0) {
        const kind = classifyGhFailure(result.stderr, result.timedOut === true)
        throw new GhError(
          kind,
          `failed to fetch log for job ${jobId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        )
      }
      return result.stdout
    },
  }
}

/**
 * Adapt the host's `ctx.shell` service (ShellExecutor) to a CommandRunner.
 * Typed against a minimal structural interface so the plugin never imports
 * host packages.
 * @param shell - Host shell executor (resolve + run).
 * @param timeoutMs - Per-command timeout budget.
 * @returns A CommandRunner backed by the guarded host pipeline.
 */
export function createShellRunner(
  shell: {
    resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }): unknown
    run(spec: unknown): Promise<{
      exitCode: number | null
      stdout: { text: string }
      stderr: { text: string }
      timedOut: boolean
    }>
  },
  timeoutMs = 60_000,
): CommandRunner {
  return async (command, options) => {
    const result = await shell.run(
      shell.resolve({
        command,
        timeoutMs,
        ...(options?.stdoutMaxBytes !== undefined
          ? { stdoutMaxBytes: options.stdoutMaxBytes }
          : {}),
      }),
    )
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      timedOut: result.timedOut,
    }
  }
}
