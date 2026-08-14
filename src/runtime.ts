/**
 * Runtime boundary and Cordis activation for dsh-ci-doctor.
 * @module dsh-ci-doctor/runtime
 */

import type { Context } from 'cordis'

import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { createGhClient, createShellRunner, type GhClient, type GhRun } from './gh.ts'
import { createMemoryLedger, openDomainLedger, type LedgerStore } from './ledger.ts'
import { trimLog } from './logs.ts'
import { extractSignatures, extractSuspectFiles, type ErrorSignature } from './signatures.ts'
import { createWatch } from './watcher.ts'

/** JSON-schema node in the subset enforced by the host tool registry. */
interface JsonSchemaNode {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: (string | number | boolean | null)[]
}

/** One model-facing content block. */
interface ContentBlock {
  type: string
  text?: string
}

/** The slice of the host tool registry this plugin consumes. */
interface ToolRegistry {
  register(definition: {
    name: string
    description: string
    parameters: JsonSchemaNode
    output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): ContentBlock[] }
    execute(args: unknown, exec: unknown): Promise<unknown>
    isConcurrencySafe?(args: unknown): boolean
  }): () => void
}

/** Minimal shape of the host job registry (ctx.jobs). */
interface JobRegistryLike {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
      readOutput(): string
    }
  }): string
}

/** Minimal shape of the tool execution context the host hands over. */
interface ToolExec {
  /** The agent on whose behalf the call runs (set by the agent loop). */
  agent?: unknown
}

/** Everything the tools close over. */
export interface DoctorDeps {
  /** GitHub client factory; throws when the host shell seam is unavailable. */
  gh(): GhClient
  /**
   * Resolve the host job registry. Lazy because the plugin mounts as soon as
   * `tools` is up, which can precede the jobs provider in a real composition
   * — an eager lookup would freeze a transient miss into a permanently
   * unavailable ci_watch.
   */
  getJobs(): JobRegistryLike | undefined
  /**
   * Resolve the failure-signature ledger. Lazy because the plugin mounts as
   * soon as `tools` is up, which can precede the storage domain in a real
   * composition — an eager lookup would freeze a transient miss.
   */
  getLedger(): Promise<LedgerStore>
  /** Resolved plugin configuration. */
  config: ResolvedConfig
  /** Sleep implementation for watch loops. */
  sleep(ms: number): Promise<void>
  /** Epoch-ms clock. */
  now(): number
}

/** One diagnosed signature, enriched with ledger history. */
export interface DiagnosedSignature extends ErrorSignature {
  /** Total times this signature has been diagnosed, including this one. */
  seenCount: number
  /** ISO timestamp of the first diagnosis. */
  firstSeenAt: string
}

/** One failed job's diagnosis. */
export interface JobDiagnosis {
  /** Job id. */
  id: number
  /** Job name. */
  name: string
  /** Failed step names. */
  failedSteps: string[]
  /** Extracted signatures with ledger history. */
  signatures: DiagnosedSignature[]
  /** Suspect repo files mined from the log. */
  suspectFiles: string[]
  /** Trimmed log excerpt (error windows only). */
  logExcerpt: string
  /** Why the log is missing (expired, retention-limited), when the fetch failed. */
  logError?: string
}

/** Canonical value returned by the ci_diagnose tool. */
export interface CiDiagnoseValue {
  /** Rendered Markdown diagnosis card. */
  markdown: string
  /** Repository diagnosed (`owner/name`). */
  repo: string
  /** Workflow run id; 0 when no failed run exists. */
  runId: number
  /** Run conclusion ('none' when no failed run exists). */
  conclusion: string
  /** Run URL. */
  runUrl: string
  /** Per-failed-job diagnoses. */
  jobs: JobDiagnosis[]
  /** Union of suspect files across jobs. */
  suspectFiles: string[]
  /** Read-only contract marker checked by the invariant companion. */
  repositoryWrites: false
}

/** Canonical value returned by the ci_watch tool. */
export interface CiWatchValue {
  /** Rendered Markdown status. */
  markdown: string
  /** Host job id of the watch. */
  jobId: string
  /** Repository being watched. */
  repo: string
  /** Poll interval in effect. */
  intervalSeconds: number
  /** Watch lifetime in effect. */
  timeoutMinutes: number
  /** Always true on a successful start. */
  watching: true
  /** Read-only contract marker checked by the invariant companion. */
  repositoryWrites: false
}

interface CiWatchArgs {
  repo?: string
  workflow?: string
  branch?: string
  intervalSeconds?: number
  timeoutMinutes?: number
  once?: boolean
}

interface CiDiagnoseArgs {
  repo?: string
  runId?: number
  job?: string
  maxLines?: number
  format?: 'markdown' | 'json'
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${key}" must be a non-empty string when provided`)
  }
  return value
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`"${key}" must be a number >= ${min} when provided`)
  }
  return value
}

function narrowWatchArgs(args: unknown): CiWatchArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('ci_watch expects an object argument')
  }
  const record = args as Record<string, unknown>
  const narrowed: CiWatchArgs = {}
  const repo = optionalString(record, 'repo')
  if (repo !== undefined) narrowed.repo = repo
  const workflow = optionalString(record, 'workflow')
  if (workflow !== undefined) narrowed.workflow = workflow
  const branch = optionalString(record, 'branch')
  if (branch !== undefined) narrowed.branch = branch
  const interval = optionalNumber(record, 'intervalSeconds', 5)
  if (interval !== undefined) narrowed.intervalSeconds = interval
  const timeout = optionalNumber(record, 'timeoutMinutes', 1)
  if (timeout !== undefined) narrowed.timeoutMinutes = timeout
  if (record.once !== undefined) {
    if (typeof record.once !== 'boolean') throw new Error('"once" must be a boolean when provided')
    narrowed.once = record.once
  }
  return narrowed
}

function narrowDiagnoseArgs(args: unknown): CiDiagnoseArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('ci_diagnose expects an object argument')
  }
  const record = args as Record<string, unknown>
  const narrowed: CiDiagnoseArgs = {}
  const repo = optionalString(record, 'repo')
  if (repo !== undefined) narrowed.repo = repo
  const runId = optionalNumber(record, 'runId', 1)
  if (runId !== undefined) narrowed.runId = Math.floor(runId)
  const job = optionalString(record, 'job')
  if (job !== undefined) narrowed.job = job
  const maxLines = optionalNumber(record, 'maxLines', 20)
  if (maxLines !== undefined) narrowed.maxLines = Math.floor(maxLines)
  if (record.format === 'markdown' || record.format === 'json') narrowed.format = record.format
  return narrowed
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

async function resolveRepo(gh: GhClient, repo: string | undefined): Promise<string> {
  if (repo === undefined) return gh.currentRepo()
  if (!REPO_RE.test(repo)) throw new Error(`"repo" must look like "owner/name", got: ${repo}`)
  return repo
}

/** Cap on failed jobs whose logs are fetched per diagnosis. */
const MAX_JOBS_DIAGNOSED = 3

/**
 * Hard ceiling on the per-job excerpt budget. fetchJobLog deliberately raises
 * the shell capture budget to 4 MB; without a cap here, a huge maxLines would
 * pour the whole raw log into the model's context — the exact outcome the
 * trim design exists to prevent.
 */
const MAX_LOG_LINES = 2_000

/**
 * Run one diagnosis against a failed run: fetch failed-job logs, extract
 * signatures, consult and update the ledger, and assemble the report value.
 * @param deps - Plugin dependencies.
 * @param args - Narrowed tool arguments.
 * @returns The canonical tool value.
 */
export async function diagnose(deps: DoctorDeps, args: CiDiagnoseArgs): Promise<CiDiagnoseValue> {
  const gh = deps.gh()
  const repo = await resolveRepo(gh, args.repo)

  let run: GhRun | undefined
  if (args.runId !== undefined) {
    run = await gh.getRun(repo, args.runId)
  } else {
    const failed = await gh.listFailedRuns({ repo, limit: 1 })
    run = failed[0]
  }
  if (run === undefined || run.id === 0) {
    return {
      markdown: `## CI diagnosis: ${repo}\n\nNo failed workflow runs found — nothing to diagnose. ✅`,
      repo,
      runId: 0,
      conclusion: 'none',
      runUrl: '',
      jobs: [],
      suspectFiles: [],
      repositoryWrites: false,
    }
  }

  const maxLines = Math.min(args.maxLines ?? deps.config.maxLogLines, MAX_LOG_LINES)
  const allJobs = await gh.listJobs(repo, run.id)
  let failedJobs = allJobs.filter(job => job.conclusion === 'failure')
  if (args.job !== undefined) {
    failedJobs = failedJobs.filter(job => job.name.includes(args.job as string))
  }
  const diagnosed: JobDiagnosis[] = []
  const suspectUnion: string[] = []
  const ledger = await deps.getLedger()

  for (const job of failedJobs.slice(0, MAX_JOBS_DIAGNOSED)) {
    let log: string
    try {
      log = await gh.fetchJobLog(repo, job.id)
    } catch (error) {
      // One unreadable log (expired past retention, transient API failure)
      // must not abort the whole diagnosis — the other failed jobs still
      // carry their signatures.
      diagnosed.push({
        id: job.id,
        name: job.name,
        failedSteps: job.failedSteps.map(step => step.name),
        signatures: [],
        suspectFiles: [],
        logExcerpt: '',
        logError: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const signatures: DiagnosedSignature[] = []
    for (const signature of extractSignatures(log)) {
      const record = await ledger.record(signature, {
        repo,
        runUrl: run.url,
        now: new Date(deps.now()),
      })
      signatures.push({ ...signature, seenCount: record.count, firstSeenAt: record.firstSeenAt })
    }
    const suspectFiles = extractSuspectFiles(log)
    for (const file of suspectFiles) {
      if (!suspectUnion.includes(file)) suspectUnion.push(file)
    }
    diagnosed.push({
      id: job.id,
      name: job.name,
      failedSteps: job.failedSteps.map(step => step.name),
      signatures,
      suspectFiles,
      logExcerpt: trimLog(log, { maxLines }),
    })
  }

  const value: CiDiagnoseValue = {
    markdown: '', // rendered below
    repo,
    runId: run.id,
    conclusion: run.conclusion,
    runUrl: run.url,
    jobs: diagnosed,
    suspectFiles: suspectUnion,
    repositoryWrites: false,
  }
  value.markdown = renderDiagnosis(value, run, failedJobs.length)
  return value
}

/**
 * Make attacker-influenced log text safe to wrap in a four-backtick fence:
 * any run of 4+ backticks in the content would close the fence early and let
 * the remainder render as live markdown (a prompt-injection channel), so such
 * runs are collapsed. Three backticks stay verbatim — the fence is longer.
 */
function fenceSafe(text: string): string {
  return text.replace(/`{4,}/g, '```')
}

function renderDiagnosis(value: CiDiagnoseValue, run: GhRun, totalFailedJobs: number): string {
  const lines: string[] = [
    `## CI diagnosis: ${value.repo} run #${value.runId}`,
    ``,
    `**Workflow:** ${run.name || '?'} · **Branch:** ${run.branch || '?'} · **Commit:** ${run.headSha.slice(0, 7) || '?'}`,
    `**Conclusion:** ${run.conclusion} · ${run.url}`,
    ``,
  ]
  if (value.jobs.length === 0) {
    lines.push(
      'No failed jobs found for this run (the failure may be at workflow level — check the run page).',
    )
  }
  for (const job of value.jobs) {
    lines.push(`### Job: ${job.name}`)
    if (job.failedSteps.length > 0) lines.push(`Failed steps: ${job.failedSteps.join(', ')}`)
    lines.push(``)
    if (job.signatures.length > 0) {
      lines.push(`**Error signatures**`)
      job.signatures.forEach((signature, index) => {
        const seen =
          signature.seenCount > 1
            ? ` — seen ${signature.seenCount}× (first ${signature.firstSeenAt.slice(0, 10)})`
            : ' — first time seen'
        lines.push(`${index + 1}. [${signature.category}] \`${signature.text}\`${seen}`)
      })
      lines.push(``)
    }
    if (job.suspectFiles.length > 0) {
      lines.push(`**Suspect files:** ${job.suspectFiles.map(file => `\`${file}\``).join(', ')}`)
      lines.push(``)
    }
    if (job.logError !== undefined) {
      lines.push(`**Log unavailable:** ${job.logError}`)
      lines.push(``)
    } else {
      lines.push(
        `<details><summary>Log excerpt</summary>`,
        ``,
        '````',
        fenceSafe(job.logExcerpt),
        '````',
        `</details>`,
        ``,
      )
    }
  }
  if (totalFailedJobs > value.jobs.length) {
    lines.push(
      `_${totalFailedJobs - value.jobs.length} more failed job(s) not shown (cap ${MAX_JOBS_DIAGNOSED}); pass "job" to focus one._`,
    )
  }
  lines.push(
    `**Next step:** check out the failing commit locally, reproduce with the failed step's command, ` +
      `fix, verify with the same command, then push — re-run ci_watch to confirm green.`,
  )
  return lines.join('\n')
}

/**
 * Build the ci_watch tool definition.
 * @param deps - Plugin dependencies.
 * @returns Host-ready tool definition.
 */
export function createCiWatchTool(deps: DoctorDeps): Parameters<ToolRegistry['register']>[0] {
  return {
    name: 'ci_watch',
    description:
      'Watch a GitHub repository for NEW CI failures (GitHub Actions). Starts a background ' +
      'job that polls via the gh CLI with exponential backoff; when a failure lands, the ' +
      'job completes and you are notified with the run id — call ci_diagnose next. ' +
      'Read-only: never touches the repository or CI state.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: "owner/name repository. Defaults to the current workdir's GitHub repo.",
        },
        workflow: { type: 'string', description: 'Workflow name or filename filter.' },
        branch: { type: 'string', description: 'Branch filter.' },
        intervalSeconds: {
          type: 'number',
          description: `Poll interval (default ${deps.config.pollIntervalSeconds}s, min 5).`,
        },
        timeoutMinutes: {
          type: 'number',
          description: `Give up after this many minutes (default ${deps.config.watchTimeoutMinutes}).`,
        },
        once: {
          type: 'boolean',
          description: 'Stop at the first detected failure (default true).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          jobId: { type: 'string' },
          repo: { type: 'string' },
          intervalSeconds: { type: 'number' },
          timeoutMinutes: { type: 'number' },
          watching: { type: 'boolean' },
          repositoryWrites: { type: 'boolean' },
        },
        required: [
          'markdown',
          'jobId',
          'repo',
          'intervalSeconds',
          'timeoutMinutes',
          'watching',
          'repositoryWrites',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: (value as CiWatchValue).markdown }],
    },
    execute: async (args, exec) => {
      const jobs = deps.getJobs()
      if (jobs === undefined) {
        throw new Error(
          'ci_watch requires the host jobs service (ctx.jobs); use ci_diagnose for a one-shot check',
        )
      }
      const narrowed = narrowWatchArgs(args)
      const gh = deps.gh()
      const repo = await resolveRepo(gh, narrowed.repo)
      const intervalSeconds = narrowed.intervalSeconds ?? deps.config.pollIntervalSeconds
      const timeoutMinutes = narrowed.timeoutMinutes ?? deps.config.watchTimeoutMinutes

      const spec = {
        repo,
        intervalSeconds,
        timeoutMinutes,
        ...(narrowed.workflow !== undefined ? { workflow: narrowed.workflow } : {}),
        ...(narrowed.branch !== undefined ? { branch: narrowed.branch } : {}),
        ...(narrowed.once !== undefined ? { once: narrowed.once } : {}),
      }
      const agent = (exec as ToolExec | undefined)?.agent
      const jobId = jobs.start({
        kind: 'ci-watch',
        label: `ci-watch ${repo}`,
        ...(agent !== undefined ? { owner: agent } : {}),
        run: () => createWatch(spec, { gh, sleep: deps.sleep, now: deps.now }),
      })
      const value: CiWatchValue = {
        markdown: [
          `## CI watch started: ${repo}`,
          ``,
          `Watching for new failed workflow runs every ${intervalSeconds}s (up to ${timeoutMinutes}m) — background job \`${jobId}\`.`,
          `You will be notified when a failure lands; then call \`ci_diagnose\` with the reported run id.`,
          `Stop it any time via the jobs UI / job tools.`,
        ].join('\n'),
        jobId,
        repo,
        intervalSeconds,
        timeoutMinutes,
        watching: true,
        repositoryWrites: false,
      }
      return value
    },
    isConcurrencySafe: () => true,
  }
}

/**
 * Build the ci_diagnose tool definition.
 * @param deps - Plugin dependencies.
 * @returns Host-ready tool definition.
 */
export function createCiDiagnoseTool(deps: DoctorDeps): Parameters<ToolRegistry['register']>[0] {
  return {
    name: 'ci_diagnose',
    description:
      'Diagnose a failed GitHub Actions run: fetch failed-job logs via the gh CLI, trim them ' +
      'to the error windows, extract normalized error signatures with categories, list ' +
      'suspect files, and recall how often each signature was seen before. ' +
      'Read-only: never touches the repository or CI state.',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: "owner/name repository. Defaults to the current workdir's GitHub repo.",
        },
        runId: {
          type: 'number',
          description: 'Workflow run id. Defaults to the latest failed run.',
        },
        job: {
          type: 'string',
          description: 'Only diagnose failed jobs whose name contains this substring.',
        },
        maxLines: {
          type: 'number',
          description: `Log lines kept per job (default ${deps.config.maxLogLines}, max ${MAX_LOG_LINES}).`,
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'markdown card (default) or raw JSON.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          repo: { type: 'string' },
          runId: { type: 'number' },
          conclusion: { type: 'string' },
          runUrl: { type: 'string' },
          jobs: { type: 'array' },
          suspectFiles: { type: 'array', items: { type: 'string' } },
          repositoryWrites: { type: 'boolean' },
        },
        required: [
          'markdown',
          'repo',
          'runId',
          'conclusion',
          'runUrl',
          'jobs',
          'suspectFiles',
          'repositoryWrites',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: (value as CiDiagnoseValue).markdown }],
    },
    execute: async args => {
      const narrowed = narrowDiagnoseArgs(args)
      const value = await diagnose(deps, narrowed)
      if (narrowed.format === 'json') {
        return { ...value, markdown: JSON.stringify({ ...value, markdown: undefined }, null, 2) }
      }
      return value
    },
    isConcurrencySafe: () => true,
  }
}

/** Structural view of the host shell seam (ctx.shell). */
interface ShellLike {
  resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }): unknown
  run(spec: unknown): Promise<{
    exitCode: number | null
    stdout: { text: string }
    stderr: { text: string }
    timedOut: boolean
  }>
}

/**
 * Apply the plugin to its Cordis context.
 * @param ctx - Scoped plugin context; registrations are owned by its fiber.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined) {
    throw new Error('dsh-ci-doctor requires the "tools" service')
  }

  // Resolve the shell lazily at call time: this plugin mounts as soon as
  // `tools` is up, which can precede the shell provider in a real
  // composition — capturing at apply time would freeze a transient undefined.
  const gh = (): GhClient => {
    const shell = ctx.get('shell') as ShellLike | undefined
    if (shell === undefined) {
      throw new Error('dsh-ci-doctor requires the host shell service (ctx.shell) to run the gh CLI')
    }
    return createGhClient(createShellRunner(shell), resolved.ghBin)
  }

  // Open the signature ledger lazily on first use: this plugin mounts as soon
  // as `tools` is up, which can precede the storage domain in a real
  // composition — an eager `ctx.get('storageDomain')` here would freeze a
  // transient miss into a permanent in-memory fallback.
  let ledgerPromise: Promise<LedgerStore> | undefined
  const getLedger = (): Promise<LedgerStore> => {
    ledgerPromise ??= (async (): Promise<LedgerStore> => {
      if (!resolved.ledgerEnabled) return createMemoryLedger()
      const facility = ctx.get('storageDomain') as unknown
      if (facility === undefined) {
        ctx.logger.info('dsh-ci-doctor: no storage domain service; signature ledger is in-memory')
        return createMemoryLedger()
      }
      try {
        const ledger = await openDomainLedger(facility)
        ctx.logger.info('dsh-ci-doctor: signature ledger durable (storage domain ci_doctor)')
        return ledger
      } catch (error) {
        ctx.logger.warn(
          `dsh-ci-doctor: storage domain unavailable (${error instanceof Error ? error.message : String(error)}); ledger is in-memory`,
        )
        return createMemoryLedger()
      }
    })()
    return ledgerPromise
  }

  // Same mount-order reasoning as the shell: the jobs provider can mount
  // after `tools`, so resolve it at call time, never at apply time.
  const getJobs = (): JobRegistryLike | undefined => ctx.get('jobs') as JobRegistryLike | undefined
  const deps: DoctorDeps = {
    gh,
    getJobs,
    getLedger,
    config: resolved,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }

  ctx.effect(() => {
    const unregisterWatch = tools.register(createCiWatchTool(deps))
    const unregisterDiagnose = tools.register(createCiDiagnoseTool(deps))

    ctx.logger.info('dsh-ci-doctor loaded: ci_watch + ci_diagnose registered')

    return async () => {
      unregisterWatch()
      unregisterDiagnose()
      // Only close a ledger that was actually opened; never force one open.
      if (ledgerPromise !== undefined) await (await ledgerPromise).close()
    }
  })
}
