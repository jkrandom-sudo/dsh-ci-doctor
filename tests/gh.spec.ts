import { describe, expect, it } from 'vitest'

import { createGhClient, createShellRunner, GhError, type CommandRunner } from '../src/gh.ts'

/** Build a runner that maps command substrings to queued results. */
function fakeRunner(
  routes: Record<
    string,
    { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
  >,
) {
  const calls: { command: string; stdoutMaxBytes?: number }[] = []
  const run: CommandRunner = async (command, options) => {
    calls.push({
      command,
      ...(options?.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: options.stdoutMaxBytes } : {}),
    })
    for (const [needle, result] of Object.entries(routes)) {
      if (command.includes(needle)) {
        return {
          exitCode: result.exitCode === undefined ? 0 : result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        }
      }
    }
    return { exitCode: 1, stdout: '', stderr: `no route for: ${command}` }
  }
  return { run, calls }
}

const RUN_JSON = JSON.stringify({
  id: 9001,
  name: 'CI',
  head_branch: 'main',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  conclusion: 'failure',
  status: 'completed',
  html_url: 'https://github.com/octo/demo/actions/runs/9001',
  created_at: '2026-08-14T07:00:00Z',
})

describe('createGhClient', () => {
  it('lists failed runs and normalizes fields', async () => {
    const { run, calls } = fakeRunner({
      'actions/runs': { stdout: JSON.stringify({ workflow_runs: [JSON.parse(RUN_JSON)] }) },
    })
    const gh = createGhClient(run)
    const runs = await gh.listFailedRuns({ repo: 'octo/demo' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 9001,
      name: 'CI',
      branch: 'main',
      conclusion: 'failure',
      url: 'https://github.com/octo/demo/actions/runs/9001',
    })
    expect(calls[0]?.command).toContain('repos/octo/demo/actions/runs?status=failure&per_page=10')
  })

  it('applies branch and workflow filters to the endpoint', async () => {
    const { run, calls } = fakeRunner({
      'actions/workflows/ci.yml/runs': { stdout: '{"workflow_runs":[]}' },
    })
    const gh = createGhClient(run)
    await gh.listFailedRuns({
      repo: 'octo/demo',
      branch: 'release/1.0',
      workflow: 'ci.yml',
      limit: 5,
    })
    expect(calls[0]?.command).toContain('actions/workflows/ci.yml/runs')
    expect(calls[0]?.command).toContain('per_page=5')
    expect(calls[0]?.command).toContain('branch=release%2F1.0')
  })

  it('fetches a single run', async () => {
    const { run } = fakeRunner({ 'actions/runs/9001': { stdout: RUN_JSON } })
    const gh = createGhClient(run)
    const fetched = await gh.getRun('octo/demo', 9001)
    expect(fetched.id).toBe(9001)
  })

  it('lists jobs with only failed/cancelled steps retained', async () => {
    const { run } = fakeRunner({
      '/jobs?per_page=100': {
        stdout: JSON.stringify({
          jobs: [
            {
              id: 555,
              name: 'test',
              conclusion: 'failure',
              steps: [
                { name: 'checkout', conclusion: 'success' },
                { name: 'pnpm test', conclusion: 'failure' },
                { name: 'cleanup', conclusion: 'cancelled' },
              ],
            },
          ],
        }),
      },
    })
    const gh = createGhClient(run)
    const jobs = await gh.listJobs('octo/demo', 9001)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.failedSteps).toEqual([
      { name: 'pnpm test', conclusion: 'failure' },
      { name: 'cleanup', conclusion: 'cancelled' },
    ])
  })

  it('fetches raw job logs as text', async () => {
    const { run, calls } = fakeRunner({ 'jobs/555/logs': { stdout: 'raw log text\nerror: boom' } })
    const gh = createGhClient(run)
    const log = await gh.fetchJobLog('octo/demo', 555)
    expect(log).toContain('error: boom')
    expect(calls[0]?.command).toContain('repos/octo/demo/actions/jobs/555/logs')
  })

  it('resolves the current repo from the workdir', async () => {
    const { run, calls } = fakeRunner({ 'repo view': { stdout: 'octo/demo\n' } })
    const gh = createGhClient(run)
    await expect(gh.currentRepo()).resolves.toBe('octo/demo')
    await expect(gh.currentRepo('/tmp/work')).resolves.toBe('octo/demo')
    expect(calls[1]?.command).toContain(`cd '/tmp/work'`)
  })

  it('classifies rate-limit failures', async () => {
    const { run } = fakeRunner({
      'actions/runs': { exitCode: 1, stderr: 'gh: API rate limit exceeded for user (HTTP 403)' },
    })
    const gh = createGhClient(run)
    const error = await gh.listFailedRuns({ repo: 'octo/demo' }).catch(e => e)
    expect(error).toBeInstanceOf(GhError)
    expect((error as GhError).kind).toBe('rate-limit')
  })

  it('classifies auth failures', async () => {
    const { run } = fakeRunner({
      'actions/runs': { exitCode: 1, stderr: 'gh: To get started, run: gh auth login' },
    })
    const gh = createGhClient(run)
    const error = await gh.listFailedRuns({ repo: 'octo/demo' }).catch(e => e)
    expect((error as GhError).kind).toBe('auth')
  })

  it('classifies not-found failures', async () => {
    const { run } = fakeRunner({
      'actions/runs/42': { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' },
    })
    const gh = createGhClient(run)
    const error = await gh.getRun('octo/demo', 42).catch(e => e)
    expect((error as GhError).kind).toBe('not-found')
  })

  it('rejects non-JSON output as an api error', async () => {
    const { run } = fakeRunner({ 'actions/runs': { stdout: '<html>proxy error</html>' } })
    const gh = createGhClient(run)
    const error = await gh.listFailedRuns({ repo: 'octo/demo' }).catch(e => e)
    expect((error as GhError).kind).toBe('api')
  })

  it('shell-quotes endpoints', async () => {
    const { run, calls } = fakeRunner({ 'actions/runs': { stdout: '{"workflow_runs":[]}' } })
    const gh = createGhClient(run)
    await gh.listFailedRuns({ repo: "octo/demo'$(rm -rf ~)'" })
    // The embedded single quote is escaped as '\'' so the whole endpoint stays
    // inside one single-quoted shell word — nothing is evaluated.
    expect(calls[0]?.command).toContain(`'\\''`)
    expect(calls[0]?.command).toMatch(/'gh' api 'repos\//)
  })

  it('raises the stdout capture budget for raw job logs', async () => {
    // The host shell caps captured stdout at 64 KiB by default; megabyte CI
    // logs need the budget raised — this pins the 4 MB request.
    const { run, calls } = fakeRunner({ 'jobs/555/logs': { stdout: 'log' } })
    const gh = createGhClient(run)
    await gh.fetchJobLog('octo/demo', 555)
    expect(calls[0]?.stdoutMaxBytes).toBe(4_000_000)
  })

  it('classifies runner timeouts', async () => {
    const { run } = fakeRunner({
      'actions/runs': { exitCode: null, timedOut: true, stderr: '' },
    })
    const gh = createGhClient(run)
    const error = await gh.listFailedRuns({ repo: 'octo/demo' }).catch(e => e)
    expect((error as GhError).kind).toBe('timeout')
  })

  it('fails currentRepo when the workdir is not a GitHub checkout', async () => {
    const { run } = fakeRunner({
      'repo view': { exitCode: 1, stderr: 'not a git repository' },
    })
    const gh = createGhClient(run)
    const error = await gh.currentRepo().catch(e => e)
    expect((error as GhError).kind).toBe('not-found')
    expect((error as GhError).message).toContain('could not resolve')
  })

  it('shell-quotes a custom ghBin (paths with spaces stay one word)', async () => {
    const { run, calls } = fakeRunner({ 'actions/runs': { stdout: '{"workflow_runs":[]}' } })
    const gh = createGhClient(run, '/opt/my tools/gh')
    await gh.listFailedRuns({ repo: 'octo/demo' })
    expect(calls[0]?.command.startsWith(`'/opt/my tools/gh' api`)).toBe(true)
  })
})

describe('createShellRunner', () => {
  /** A host-shaped fake: resolve takes a request, run returns nested blocks. */
  function fakeShell(result: {
    exitCode: number | null
    stdout: string
    stderr: string
    timedOut: boolean
  }) {
    const requests: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }[] = []
    return {
      requests,
      shell: {
        resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }) {
          requests.push(request)
          return request
        },
        run: async (_spec: unknown) => ({
          exitCode: result.exitCode,
          stdout: { text: result.stdout },
          stderr: { text: result.stderr },
          timedOut: result.timedOut,
        }),
      },
    }
  }

  it('unwraps the host result blocks into the flat CommandResult', async () => {
    const { shell } = fakeShell({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false })
    const run = createShellRunner(shell)
    const result = await run('echo hi')
    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false })
  })

  it('forwards stdoutMaxBytes only when given', async () => {
    const { shell, requests } = fakeShell({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    const run = createShellRunner(shell)
    await run('small')
    await run('big', { stdoutMaxBytes: 4_000_000 })
    expect(requests[0]?.stdoutMaxBytes).toBeUndefined()
    expect(requests[1]?.stdoutMaxBytes).toBe(4_000_000)
    expect(requests[0]?.timeoutMs).toBe(60_000)
  })
})
