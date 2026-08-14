import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Loader from '@cordisjs/plugin-loader'
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'

import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { resolveConfig } from '../src/config.ts'
import {
  createCiDiagnoseTool,
  createCiWatchTool,
  type CiDiagnoseValue,
  type CiWatchValue,
} from '../src/runtime.ts'
import { createDepsHarness, createPluginHarness, fakeJob, fakeRun } from './harness.ts'

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'logs')

interface ToolDef {
  name: string
  parameters: { required?: string[] }
  output: { render(args: unknown, value: unknown): { type: string; text?: string }[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

describe('dsh-ci-doctor plugin shape', () => {
  it('preserves the function-plugin namespace through Loader unwrapping', () => {
    expect('default' in plugin).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('dsh-ci-doctor')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('resolves schema defaults', () => {
    expect(resolveConfig()).toEqual({
      pollIntervalSeconds: 30,
      watchTimeoutMinutes: 60,
      maxLogLines: 200,
      ghBin: 'gh',
      ledgerEnabled: true,
    })
    expect(resolveConfig({ pollIntervalSeconds: 10, ledgerEnabled: false })).toMatchObject({
      pollIntervalSeconds: 10,
      ledgerEnabled: false,
      watchTimeoutMinutes: 60,
    })
  })
})

describe('plugin activation', () => {
  it('registers ci_watch and ci_diagnose and logs activation', async () => {
    const harness = await createPluginHarness()
    expect(harness.tools.service.register).toHaveBeenCalledTimes(2)
    const names = harness.tools.registered.map(def => (def as ToolDef).name)
    expect(names).toEqual(['ci_watch', 'ci_diagnose'])
    expect(harness.info).toHaveBeenCalledWith(expect.stringContaining('dsh-ci-doctor loaded'))
    await harness.dispose()
  })

  it('opens the signature ledger lazily, never at mount', async () => {
    // The plugin mounts as soon as `tools` is up — potentially before the
    // storage domain — so an eager open would freeze a transient miss.
    const open = vi.fn()
    const harness = await createPluginHarness({ storageDomain: { open } })
    expect(open).not.toHaveBeenCalled()
    await harness.dispose()
    expect(open).not.toHaveBeenCalled()
  })

  it('apply throws when the tools service is missing', async () => {
    // With `inject: ['tools']` declared, Cordis never applies the plugin when
    // the service is absent — the direct call pins the fail-loud message that
    // profiles bypassing inject would otherwise hit as a raw TypeError.
    await expect(plugin.apply(new Context(), {})).rejects.toThrow('requires the "tools" service')
  })

  it('unregisters both tools on disposal', async () => {
    const harness = await createPluginHarness()
    await harness.dispose()
    expect(harness.tools.unregistered).toHaveLength(2)
  })
})

describe('ci_watch tool', () => {
  it('starts a background job owned by the calling agent', async () => {
    const { deps, jobs, gh } = createDepsHarness()
    gh.currentRepo.mockResolvedValue('octo/demo')
    gh.listFailedRuns.mockResolvedValue([])
    const tool = createCiWatchTool(deps) as ToolDef
    const agent = { id: 'agent-1' }
    const value = (await tool.execute(
      { branch: 'main' },
      { name: 'ci_watch', arguments: { branch: 'main' }, agent },
    )) as CiWatchValue

    expect(value.watching).toBe(true)
    expect(value.jobId).toBe('ci-watch-1')
    expect(value.repo).toBe('octo/demo')
    expect(value.repositoryWrites).toBe(false)
    expect(jobs.started[0]).toMatchObject({
      kind: 'ci-watch',
      label: 'ci-watch octo/demo',
      owner: agent,
    })
    expect(value.markdown).toContain('ci-watch-1')
  })

  it('honors explicit repo and interval overrides', async () => {
    const { deps, jobs, gh } = createDepsHarness()
    gh.listFailedRuns.mockResolvedValue([])
    const tool = createCiWatchTool(deps) as ToolDef
    const value = (await tool.execute(
      { repo: 'octo/other', intervalSeconds: 10, timeoutMinutes: 5, workflow: 'ci.yml' },
      undefined,
    )) as CiWatchValue
    expect(value.repo).toBe('octo/other')
    expect(value.intervalSeconds).toBe(10)
    expect(value.timeoutMinutes).toBe(5)
    expect(jobs.started[0]?.label).toBe('ci-watch octo/other')
    expect(gh.currentRepo).not.toHaveBeenCalled()
  })

  it('rejects malformed repo strings', async () => {
    const { deps } = createDepsHarness()
    const tool = createCiWatchTool(deps) as ToolDef
    await expect(tool.execute({ repo: 'not-a-repo' }, undefined)).rejects.toThrow('owner/name')
  })

  it('rejects non-object arguments', async () => {
    const { deps } = createDepsHarness()
    const tool = createCiWatchTool(deps) as ToolDef
    await expect(tool.execute('octo/demo', undefined)).rejects.toThrow('object')
  })

  it('fails loudly when the host jobs service is absent', async () => {
    const { deps } = createDepsHarness({ jobs: undefined })
    const tool = createCiWatchTool(deps) as ToolDef
    await expect(tool.execute({}, undefined)).rejects.toThrow('ctx.jobs')
  })

  it('renders the markdown block for the model', async () => {
    const { deps, gh } = createDepsHarness()
    gh.listFailedRuns.mockResolvedValue([])
    const tool = createCiWatchTool(deps) as ToolDef
    const value = await tool.execute({ repo: 'octo/demo' }, undefined)
    const blocks = tool.output.render(undefined, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('CI watch started: octo/demo')
  })
})

describe('ci_diagnose tool', () => {
  const LOG = readFileSync(path.join(fixtures, 'test-failure.log'), 'utf8')

  function diagnosedDeps() {
    const harness = createDepsHarness()
    harness.gh.listFailedRuns.mockResolvedValue([fakeRun()])
    harness.gh.getRun.mockResolvedValue(fakeRun())
    harness.gh.listJobs.mockResolvedValue([
      fakeJob(),
      fakeJob({ id: 556, name: 'build', conclusion: 'success', failedSteps: [] }),
    ])
    harness.gh.fetchJobLog.mockResolvedValue(LOG)
    return harness
  }

  it('diagnoses the latest failed run end-to-end', async () => {
    const { deps } = diagnosedDeps()
    const tool = createCiDiagnoseTool(deps) as ToolDef
    const value = (await tool.execute({}, undefined)) as CiDiagnoseValue

    expect(value.repo).toBe('octo/demo')
    expect(value.runId).toBe(9001)
    expect(value.conclusion).toBe('failure')
    expect(value.repositoryWrites).toBe(false)
    expect(value.jobs).toHaveLength(1)
    expect(value.jobs[0]?.failedSteps).toEqual(['pnpm test'])
    expect(value.jobs[0]?.signatures.some(s => s.category === 'test')).toBe(true)
    expect(value.suspectFiles).toContain('tests/watcher.spec.ts')
    expect(value.markdown).toContain('## CI diagnosis: octo/demo run #9001')
    expect(value.markdown).toContain('first time seen')
  })

  it('records signatures in the ledger and reports repeat sightings', async () => {
    const { deps } = diagnosedDeps()
    const tool = createCiDiagnoseTool(deps) as ToolDef
    await tool.execute({}, undefined)
    const second = (await tool.execute({}, undefined)) as CiDiagnoseValue
    const signature = second.jobs[0]?.signatures[0]
    expect(signature?.seenCount).toBe(2)
    expect(second.markdown).toContain('seen 2×')
  })

  it('uses an explicit runId and filters jobs by name', async () => {
    const { deps, gh } = diagnosedDeps()
    gh.listJobs.mockResolvedValue([
      fakeJob({ id: 1, name: 'lint' }),
      fakeJob({ id: 2, name: 'test' }),
    ])
    const tool = createCiDiagnoseTool(deps) as ToolDef
    const value = (await tool.execute({ runId: 42, job: 'test' }, undefined)) as CiDiagnoseValue
    expect(gh.getRun).toHaveBeenCalledWith('octo/demo', 42)
    expect(value.jobs.map(job => job.name)).toEqual(['test'])
  })

  it('reports a clean bill when no failed run exists', async () => {
    const { deps, gh } = createDepsHarness()
    gh.listFailedRuns.mockResolvedValue([])
    const tool = createCiDiagnoseTool(deps) as ToolDef
    const value = (await tool.execute({ repo: 'octo/demo' }, undefined)) as CiDiagnoseValue
    expect(value.conclusion).toBe('none')
    expect(value.runId).toBe(0)
    expect(value.markdown).toContain('nothing to diagnose')
  })

  it('renders json when format is json', async () => {
    const { deps } = diagnosedDeps()
    const tool = createCiDiagnoseTool(deps) as ToolDef
    const value = (await tool.execute({ format: 'json' }, undefined)) as CiDiagnoseValue
    const parsed = JSON.parse(value.markdown) as { runId: number; markdown?: unknown }
    expect(parsed.runId).toBe(9001)
    expect(parsed.markdown).toBeUndefined()
  })

  it('rejects invalid arguments', async () => {
    const { deps } = diagnosedDeps()
    const tool = createCiDiagnoseTool(deps) as ToolDef
    await expect(tool.execute({ runId: -3 }, undefined)).rejects.toThrow('runId')
    await expect(tool.execute({ maxLines: 2 }, undefined)).rejects.toThrow('maxLines')
    await expect(tool.execute({ repo: '' }, undefined)).rejects.toThrow('repo')
    await expect(tool.execute(null, undefined)).rejects.toThrow('object')
  })

  it('caps diagnosis at three failed jobs and notes the rest', async () => {
    const { deps, gh } = diagnosedDeps()
    gh.listJobs.mockResolvedValue([
      fakeJob({ id: 1, name: 'a' }),
      fakeJob({ id: 2, name: 'b' }),
      fakeJob({ id: 3, name: 'c' }),
      fakeJob({ id: 4, name: 'd' }),
    ])
    const tool = createCiDiagnoseTool(deps) as ToolDef
    const value = (await tool.execute({}, undefined)) as CiDiagnoseValue
    expect(value.jobs).toHaveLength(3)
    expect(value.markdown).toContain('1 more failed job')
  })
})

describe('invariant companion', () => {
  it('registers through its local host contract', async () => {
    const ctx = new Context()
    const unregister = vi.fn()
    const register = vi.fn<(packageName: string, installer: unknown) => () => void>(
      () => unregister,
    )
    ctx.provide('invariants', { register })

    const fiber = await ctx.plugin(invariant)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toBe('dsh-ci-doctor')
    expect(typeof register.mock.calls[0]?.[1]).toBe('function')

    await fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('fails when a ci_* result loses its read-only marker', async () => {
    const ctx = new Context()
    let installer: ((c: Context, fail: (m: string) => never) => void) | undefined
    ctx.provide('invariants', {
      register: (_name: string, fn: typeof installer) => {
        installer = fn
        return () => undefined
      },
    })
    const fiber = await ctx.plugin(invariant)
    expect(installer).toBeDefined()

    const fail = vi.fn((message: string): never => {
      throw new Error(message)
    })
    installer!(ctx, fail)

    const dispatch = (
      exec: { name: string },
      result: { isError?: boolean; value?: { repositoryWrites?: boolean } },
    ) =>
      ctx.waterfall('tools/post-execute', exec, result, async () => ({ kind: 'accept' as const }))

    // Conforming results pass through untouched.
    const ok = await dispatch({ name: 'ci_diagnose' }, { value: { repositoryWrites: false } })
    expect(ok.kind).toBe('accept')
    expect(fail).not.toHaveBeenCalled()

    // A result that lost the marker trips the invariant.
    await expect(
      dispatch({ name: 'ci_watch' }, { value: { repositoryWrites: true } }),
    ).rejects.toThrow('read-only marker')
    expect(fail).toHaveBeenCalledTimes(1)

    // Error results carry no value — a routine tool failure is not tool output.
    const errored = await dispatch({ name: 'ci_diagnose' }, { isError: true })
    expect(errored.kind).toBe('accept')
    expect(fail).toHaveBeenCalledTimes(1)

    // Other tools are not the companion's business.
    const alien = await dispatch({ name: 'bash' }, { value: {} })
    expect(alien.kind).toBe('accept')
    expect(fail).toHaveBeenCalledTimes(1)

    await fiber.dispose()
  })

  it('apply throws without the invariants service', async () => {
    // Same inject note as above: Cordis blocks activation, so the direct call
    // pins the fail-loud contract for inject-bypassing loaders.
    await expect(invariant.apply(new Context())).rejects.toThrow('invariants')
  })
})
