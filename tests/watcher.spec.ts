import { describe, expect, it } from 'vitest'

import { GhError } from '../src/gh.ts'
import { createWatch, type WatchDeps, type WatchSpec } from '../src/watcher.ts'
import { createFakeClock, createFakeGh, fakeRun } from './harness.ts'

function makeDeps(overrides: Partial<WatchDeps> = {}) {
  const clock = createFakeClock()
  const gh = createFakeGh()
  const deps: WatchDeps = {
    gh,
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  }
  return { deps, gh, clock }
}

const SPEC: WatchSpec = {
  repo: 'octo/demo',
  intervalSeconds: 30,
  timeoutMinutes: 60,
}

describe('createWatch', () => {
  it('ignores historical failures and completes on the first NEW failure', async () => {
    const { deps, gh } = makeDeps()
    gh.listFailedRuns
      .mockResolvedValueOnce([fakeRun({ id: 100 })]) // baseline
      .mockResolvedValueOnce([fakeRun({ id: 100 })]) // first poll: nothing new
      .mockResolvedValue([fakeRun({ id: 101 }), fakeRun({ id: 100 })]) // new failure

    const watch = createWatch(SPEC, deps)
    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('failure detected')
    const output = watch.readOutput()
    expect(output).toContain('NEW CI FAILURE on octo/demo')
    expect(output).toContain('run #101')
    expect(output).toContain('ci_diagnose with repo="octo/demo" runId=101')
  })

  it('expires cleanly when no failure lands before the deadline', async () => {
    const { deps, gh, clock } = makeDeps()
    gh.listFailedRuns.mockResolvedValue([fakeRun({ id: 100 })])
    const watch = createWatch(SPEC, deps)
    // Jump beyond the 60-minute deadline before the loop iterates.
    clock.advance(61 * 60_000)
    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toContain('expired')
    expect(watch.readOutput()).toContain('no new CI failures')
  })

  it('settles killed on cancel, interrupting an in-flight sleep', async () => {
    // A sleep that never resolves on its own — only cancel can wake the loop.
    const { deps, gh } = makeDeps({ sleep: () => new Promise<void>(() => undefined) })
    gh.listFailedRuns.mockResolvedValue([])
    const watch = createWatch(SPEC, deps)
    // Let the baseline poll complete and the loop enter its sleep.
    await new Promise(resolve => setTimeout(resolve, 10))
    watch.cancel('user asked')
    const outcome = await watch.done
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('user asked')
    expect(watch.readOutput()).toContain('cancelled (user asked)')
  })

  it('cancel is idempotent', async () => {
    const { deps, gh } = makeDeps({ sleep: () => new Promise<void>(() => undefined) })
    gh.listFailedRuns.mockResolvedValue([])
    const watch = createWatch(SPEC, deps)
    await new Promise(resolve => setTimeout(resolve, 10))
    watch.cancel('first')
    watch.cancel('second')
    const outcome = await watch.done
    expect(outcome.detail).toBe('first')
  })

  it('fails immediately on gh auth errors during baseline', async () => {
    const { deps, gh } = makeDeps()
    gh.listFailedRuns.mockRejectedValue(new GhError('auth', 'gh auth login required'))
    const watch = createWatch(SPEC, deps)
    const outcome = await watch.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('authentication')
  })

  it('backs off on consecutive poll errors and gives up after five', async () => {
    const { deps, gh } = makeDeps()
    const sleeps: number[] = []
    const trackingSleep = async (ms: number) => {
      sleeps.push(ms)
    }
    deps.sleep = trackingSleep
    gh.listFailedRuns
      .mockResolvedValueOnce([]) // baseline ok
      .mockRejectedValue(new GhError('api', 'boom'))
    const watch = createWatch(SPEC, deps)
    const outcome = await watch.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('5')
    // Backoff: 1x, 2x, 4x, 8x, 8x (capped) of the 30s interval.
    expect(sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 240_000])
    expect(watch.readOutput()).toContain('giving up after 5 consecutive errors')
  })

  it('keeps watching after a detection when once=false', async () => {
    const { deps, gh } = makeDeps()
    gh.listFailedRuns
      .mockResolvedValueOnce([fakeRun({ id: 100 })]) // baseline
      .mockResolvedValueOnce([fakeRun({ id: 101 }), fakeRun({ id: 100 })]) // first new failure
      .mockResolvedValue([fakeRun({ id: 100 })]) // nothing newer yet
    const watch = createWatch({ ...SPEC, once: false }, deps)
    // Let the loop run a few iterations.
    await new Promise(resolve => setTimeout(resolve, 20))
    watch.cancel('done testing')
    const outcome = await watch.done
    expect(outcome.status).toBe('killed')
    const output = watch.readOutput()
    expect(output).toContain('NEW CI FAILURE')
    expect(output).toContain('run #101')
  })

  it('readOutput drains the buffer', async () => {
    const { deps, gh, clock } = makeDeps()
    gh.listFailedRuns.mockResolvedValue([fakeRun({ id: 100 })])
    const watch = createWatch({ ...SPEC, timeoutMinutes: 1 }, deps)
    const first = watch.readOutput()
    expect(first).toContain('watching octo/demo')
    expect(watch.readOutput()).toBe('')
    clock.advance(61_000) // past the 1-minute deadline
    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
  })

  it('never reports historical failures when the baseline poll fails first', async () => {
    // Regression: a transient baseline failure must not turn every
    // pre-existing red run into a "NEW CI FAILURE" on the next good poll —
    // detection stays suppressed until a baseline is actually established.
    const { deps, gh } = makeDeps()
    gh.listFailedRuns
      .mockRejectedValueOnce(new GhError('rate-limit', 'API rate limit exceeded')) // baseline fails
      .mockResolvedValueOnce([fakeRun({ id: 100 })]) // retry: establishes the baseline
      .mockResolvedValue([fakeRun({ id: 101 }), fakeRun({ id: 100 })]) // then something new
    const watch = createWatch(SPEC, deps)
    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('failure detected')
    const output = watch.readOutput()
    expect(output).toContain('baseline set — ignoring 1 historical failed run(s)')
    expect(output).toContain('run #101')
    expect(output).not.toContain('run #100 (CI)') // never flagged as a detection
  })

  it('caps the sleep at the remaining lifetime instead of overshooting the deadline', async () => {
    // intervalSeconds 3600 with a 1-minute timeout: the watch must expire
    // after ~1 minute, not sleep an hour and then poll past its deadline.
    const { deps, gh } = makeDeps()
    const sleeps: number[] = []
    const clock = createFakeClock()
    deps.sleep = async ms => {
      sleeps.push(ms)
      clock.advance(ms) // time actually passes during the sleep
    }
    deps.now = clock.now
    gh.listFailedRuns.mockResolvedValue([])
    const watch = createWatch({ ...SPEC, intervalSeconds: 3600, timeoutMinutes: 1 }, deps)
    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toContain('expired')
    expect(sleeps[0]).toBe(60_000) // capped to the remaining minute, not 3600s
  })

  it('honors a cancel delivered while a poll is in flight', async () => {
    const { deps, gh } = makeDeps()
    let cancel: (reason?: string) => void = () => undefined
    gh.listFailedRuns
      .mockResolvedValueOnce([fakeRun({ id: 100 })]) // baseline
      .mockImplementation(async () => {
        cancel('stop now') // kill lands mid-poll, before the result returns
        return [fakeRun({ id: 101 }), fakeRun({ id: 100 })]
      })
    const watch = createWatch(SPEC, deps)
    cancel = reason => watch.cancel(reason)
    const outcome = await watch.done
    // The in-flight detection must not settle the watch as completed.
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('stop now')
  })
})
