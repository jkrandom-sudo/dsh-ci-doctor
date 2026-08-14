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
  withShell?: boolean
  storageDomain?: unknown
}

/**
 * Mount the production plugin against fake host services. The fake shell is
 * bypassed: `gh` is injected by wrapping the plugin's `apply` through a test
 * double of the deps — instead we provide a shell that throws, and override
 * the tool deps via the returned registry entries. For tool-level tests use
 * {@link createDepsHarness} which builds tool definitions directly.
 */
export async function createPluginHarness(options: HarnessOptions = {}) {
  const ctx = new Context()
  const tools = createFakeTools()
  const jobs = createFakeJobs()
  ctx.provide('tools', tools.service)
  if (options.withJobs !== false) ctx.provide('jobs', jobs.service)
  if (options.storageDomain !== undefined) ctx.provide('storageDomain', options.storageDomain)
  if (options.withShell === true) {
    ctx.provide('shell', {
      resolve: (request: unknown) => request,
      run: async () => {
        throw new Error('fake shell: no command expected')
      },
    })
  }
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
  const fiber = await ctx.plugin(plugin, options.config ?? {})

  return {
    ctx,
    fiber,
    tools,
    jobs,
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
  overrides: Omit<Partial<DoctorDeps>, 'jobs'> & { jobs?: DoctorDeps['jobs'] | undefined } = {},
) {
  const gh = createFakeGh()
  const jobs = createFakeJobs()
  const clock = createFakeClock()
  const ledger = createMemoryLedger()
  const deps: DoctorDeps = {
    gh: () => gh,
    jobs: jobs.service as unknown as NonNullable<DoctorDeps['jobs']>,
    getLedger: async () => ledger,
    config: resolveConfig(),
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  }
  return { deps, gh, jobs, clock, ledger }
}
