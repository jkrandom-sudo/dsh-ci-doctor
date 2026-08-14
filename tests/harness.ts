import { Context } from 'cordis'
import { vi } from 'vitest'

import * as plugin from '../src/index.ts'
import type { GhClient, GhJob, GhRun } from '../src/gh.ts'
import type { DoctorDeps } from '../src/runtime.ts'
import { resolveConfig } from '../src/config.ts'
import { createMemoryLedger } from '../src/ledger.ts'

/** Minimal fake of the host tools service, capturing registrations. */
export function createFakeTools() {
  const registered: unknown[] = []
  const unregistered: unknown[] = []
  return {
    registered,
    unregistered,
    service: {
      register: vi.fn((definition: unknown) => {
        registered.push(definition)
        return () => {
          unregistered.push(definition)
        }
      }),
    },
  }
}

/** One canned shell response (flat shape — the fake wraps it host-style). */
export interface FakeShellResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

/**
 * A fake of the host shell seam that mirrors the REAL host contract:
 * resolve() takes `{command, timeoutMs?, stdoutMaxBytes?}` and run() returns
 * nested `{stdout: {text}, stderr: {text}}` blocks. Routing through this fake
 * exercises createShellRunner's unwrapping — the exact boundary where a
 * host-shape drift once shipped silently in a sister plugin.
 */
export function createFakeShell(handler: (command: string) => FakeShellResult) {
  const requests: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }[] = []
  return {
    requests,
    service: {
      resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }) {
        requests.push(request)
        return request
      },
      run: async (spec: { command: string }) => {
        const result = handler(spec.command)
        return {
          exitCode: result.exitCode,
          stdout: { text: result.stdout },
          stderr: { text: result.stderr },
          timedOut: result.timedOut ?? false,
        }
      },
    },
  }
}

/** A queued-response fake of the host jobs registry. */
export function createFakeJobs() {
  const started: { kind: string; label: string; owner?: unknown; hooks: unknown }[] = []
  let counter = 0
  return {
    started,
    service: {
      start: vi.fn((spec: { kind: string; label: string; owner?: unknown; run(): unknown }) => {
        counter++
        started.push({
          kind: spec.kind,
          label: spec.label,
          ...(spec.owner !== undefined ? { owner: spec.owner } : {}),
          hooks: spec.run(),
        })
        return `${spec.kind}-${counter}`
      }),
    },
  }
}

/** A controllable GitHub client; each method is a vi.fn. */
export function createFakeGh(overrides: Partial<GhClient> = {}): GhClient & {
  listFailedRuns: ReturnType<typeof vi.fn>
  getRun: ReturnType<typeof vi.fn>
  listJobs: ReturnType<typeof vi.fn>
  fetchJobLog: ReturnType<typeof vi.fn>
  currentRepo: ReturnType<typeof vi.fn>
} {
  return {
    currentRepo: vi.fn(async () => 'octo/demo'),
    listFailedRuns: vi.fn(async () => [] as GhRun[]),
    getRun: vi.fn(async () => ({}) as GhRun),
    listJobs: vi.fn(async () => [] as GhJob[]),
    fetchJobLog: vi.fn(async () => ''),
    ...overrides,
  } as GhClient & {
    listFailedRuns: ReturnType<typeof vi.fn>
    getRun: ReturnType<typeof vi.fn>
    listJobs: ReturnType<typeof vi.fn>
    fetchJobLog: ReturnType<typeof vi.fn>
    currentRepo: ReturnType<typeof vi.fn>
  }
}

/** A fake run factory with overridable fields. */
export function fakeRun(fields: Partial<GhRun> = {}): GhRun {
  return {
    id: 9001,
    name: 'CI',
    branch: 'main',
    headSha: '0123456789abcdef',
    conclusion: 'failure',
    status: 'completed',
    url: 'https://github.com/octo/demo/actions/runs/9001',
    createdAt: '2026-08-14T07:00:00Z',
    ...fields,
  }
}

/** A fake failed-job factory with overridable fields. */
export function fakeJob(fields: Partial<GhJob> = {}): GhJob {
  return {
    id: 555,
    name: 'test',
    conclusion: 'failure',
    failedSteps: [{ name: 'pnpm test', conclusion: 'failure' }],
    ...fields,
  }
}

/** A controllable clock + macrotask-yielding sleep pair for watcher tests. */
export function createFakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    // Yield through a macrotask so test-side setTimeout (cancel, …) can fire;
    // an instantly-resolving sleep would spin the loop as pure microtasks and
    // starve the event loop.
    sleep: async () =>
      new Promise<void>(resolve => {
        setImmediate(resolve)
      }),
  }
}

interface HarnessOptions {
  config?: plugin.Config
  gh?: GhClient
  withJobs?: boolean
  shell?: (command: string) => FakeShellResult
  storageDomain?: unknown
}

/**
 * Mount the production plugin against fake host services. Provide `shell` to
 * route gh commands through the real apply() wiring (createShellRunner +
 * createGhClient); without it the shell seam is absent and the gh() closure
 * throws. For tool-level tests with a mocked GitHub client use
 * {@link createDepsHarness} instead.
 */
export async function createPluginHarness(options: HarnessOptions = {}) {
  const ctx = new Context()
  const tools = createFakeTools()
  const jobs = createFakeJobs()
  ctx.provide('tools', tools.service)
  if (options.withJobs !== false) ctx.provide('jobs', jobs.service)
  if (options.storageDomain !== undefined) ctx.provide('storageDomain', options.storageDomain)
  const shell = options.shell === undefined ? undefined : createFakeShell(options.shell)
  if (shell !== undefined) ctx.provide('shell', shell.service)
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
  const fiber = await ctx.plugin(plugin, options.config ?? {})

  return {
    ctx,
    fiber,
    tools,
    jobs,
    shell,
    info,
    async dispose(): Promise<void> {
      try {
        await fiber.dispose()
      } finally {
        info.mockRestore()
      }
    },
  }
}

/** Build tool definitions directly against fully fake dependencies. */
export function createDepsHarness(
  overrides: Omit<Partial<DoctorDeps>, 'getJobs'> & {
    jobs?: ReturnType<typeof createFakeJobs>['service'] | undefined
  } = {},
) {
  const gh = createFakeGh()
  const jobs = createFakeJobs()
  const clock = createFakeClock()
  const ledger = createMemoryLedger()
  const deps: DoctorDeps = {
    gh: () => gh,
    getJobs: 'jobs' in overrides ? () => overrides.jobs : () => jobs.service,
    getLedger: async () => ledger,
    config: resolveConfig(),
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  }
  return { deps, gh, jobs, clock, ledger }
}
