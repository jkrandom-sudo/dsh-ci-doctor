/**
 * Watch loop behind ci_watch: poll GitHub for NEW failed runs, back off on
 * errors, and settle with a diagnosis-ready summary. Pure orchestration —
 * the GitHub client, clock, and sleep are injected, so tests drive the whole
 * state machine deterministically.
 *
 * Output contract: the watch is a STREAMING job (it provides readOutput), so
 * per the host job-registry docs it leaves `JobOutcome.output` unset — every
 * status line, including the terminal detection summary, flows through the
 * readOutput buffer.
 * @module dsh-ci-doctor/watcher
 */

import { GhError, type GhClient, type GhRun } from './gh.ts'

/** What to watch. */
export interface WatchSpec {
  /** `owner/name` repository. */
  repo: string
  /** Optional workflow name/filename filter. */
  workflow?: string
  /** Optional branch filter. */
  branch?: string
  /** Seconds between polls. */
  intervalSeconds: number
  /** Wall-clock minutes before the watch expires. */
  timeoutMinutes: number
  /** Stop at the first detected failure (default true). */
  once?: boolean
}

/** Terminal outcome of a watch, mirroring the host's JobOutcome shape. */
export interface WatchOutcome {
  /** completed: detection or clean expiry; killed: cancelled; failed: unrecoverable error. */
  status: 'completed' | 'killed' | 'failed'
  /** Status detail ('cancelled by user', 'auth failure', …). */
  detail?: string
}

/** Job-hooks shape the host's job registry consumes. */
export interface WatchHandle {
  /** Synchronous, idempotent termination request; also interrupts an in-flight sleep. */
  cancel(reason?: string): void
  /** Settles after the loop releases its resources; never rejects. */
  done: Promise<WatchOutcome>
  /** Drain heartbeat lines produced since the previous call. */
  readOutput(): string
}

/** Injectable watch dependencies. */
export interface WatchDeps {
  /** GitHub client. */
  gh: GhClient
  /**
   * Sleep one interval. The watcher never passes a signal; cancellation is
   * delivered by racing this against the cancel latch, so any resolve-on-time
   * implementation works.
   */
  sleep(ms: number): Promise<void>
  /** Epoch-ms clock. */
  now(): number
}

/** Maximum backoff multiplier on consecutive poll errors. */
const MAX_BACKOFF_FACTOR = 8

/** Consecutive poll errors after which the watch gives up. */
const MAX_CONSECUTIVE_FAILURES = 5

function describeRun(run: GhRun): string {
  return [
    `run #${run.id} (${run.name || 'workflow'}) on ${run.branch || '?'} @ ${run.headSha.slice(0, 7) || '?'}`,
    `conclusion: ${run.conclusion}`,
    `url: ${run.url}`,
  ].join('\n')
}

/**
 * Start one watch loop. The first poll establishes the baseline: only runs
 * observed after the watch started count as detections, so historical red
 * runs never fire the alarm.
 * @param spec - What to watch.
 * @param deps - Injected client/clock/sleep.
 * @returns Job hooks for the host registry (or direct awaiting in tests).
 */
export function createWatch(spec: WatchSpec, deps: WatchDeps): WatchHandle {
  const once = spec.once ?? true
  const deadline = deps.now() + spec.timeoutMinutes * 60_000
  let cancelReason: string | undefined
  let wake: (() => void) | undefined
  let buffer: string[] = []
  let settle!: (outcome: WatchOutcome) => void
  const done = new Promise<WatchOutcome>(resolve => {
    settle = resolve
  })

  const push = (line: string): void => {
    buffer.push(line)
    if (buffer.length > 200) buffer = buffer.slice(-200)
  }

  /** Sleep that resolves early when cancel() fires. */
  const cancellableSleep = async (ms: number): Promise<void> => {
    await Promise.race([
      deps.sleep(ms),
      new Promise<void>(resolve => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  push(
    `ci_watch: watching ${spec.repo}` +
      (spec.workflow !== undefined ? ` workflow=${spec.workflow}` : '') +
      (spec.branch !== undefined ? ` branch=${spec.branch}` : '') +
      ` every ${spec.intervalSeconds}s for up to ${spec.timeoutMinutes}m`,
  )

  const finish = (outcome: WatchOutcome, finalLines?: string): void => {
    if (finalLines !== undefined && finalLines !== '') push(finalLines)
    settle(outcome)
  }

  void (async () => {
    let failures = 0
    // Runs already failed before the watch started are the baseline, never
    // detections. The baseline is only established by a SUCCESSFUL poll — a
    // failed baseline poll must not turn every historical red run into a
    // fresh "detection" on the next successful one, so detection stays
    // suppressed while baselineId is undefined.
    let baselineId: number | undefined
    let firstPoll = true

    while (cancelReason === undefined) {
      if (deps.now() >= deadline) {
        finish(
          { status: 'completed', detail: 'watch expired without new failures' },
          `ci_watch: no new CI failures on ${spec.repo} within ${spec.timeoutMinutes}m — stopping.`,
        )
        return
      }
      if (firstPoll) {
        // Establish (or retry) the baseline immediately, no initial wait.
        firstPoll = false
      } else {
        const backoff = Math.min(2 ** failures, MAX_BACKOFF_FACTOR)
        // Never sleep past the deadline: a long (or backed-off) interval must
        // not let the watch overshoot its lifetime and detect after expiry.
        const remaining = deadline - deps.now()
        await cancellableSleep(Math.min(spec.intervalSeconds * 1000 * backoff, remaining))
        if (cancelReason !== undefined) break
        if (deps.now() >= deadline) continue // loop top settles the expiry
      }
      try {
        const runs = await deps.gh.listFailedRuns({
          repo: spec.repo,
          ...(spec.branch !== undefined ? { branch: spec.branch } : {}),
          ...(spec.workflow !== undefined ? { workflow: spec.workflow } : {}),
          limit: 10,
        })
        // A cancel delivered while the poll was in flight wins over anything
        // the poll returned — never settle a detection for a killed watch.
        if (cancelReason !== undefined) break
        failures = 0
        if (baselineId === undefined) {
          baselineId = Math.max(0, ...runs.map(run => run.id))
          push(`ci_watch: baseline set — ignoring ${runs.length} historical failed run(s)`)
          continue
        }
        const baseline = baselineId
        const fresh = runs.filter(run => run.id > baseline)
        if (fresh.length > 0) {
          const latest = fresh[0]
          if (latest === undefined) continue
          const summary = [
            `ci_watch: NEW CI FAILURE on ${spec.repo}`,
            describeRun(latest),
            ``,
            `Next step: call ci_diagnose with repo="${spec.repo}" runId=${latest.id}` +
              ` to fetch logs, extract error signatures, and start the fix loop.`,
          ].join('\n')
          if (once) {
            finish({ status: 'completed', detail: 'failure detected' }, summary)
            return
          }
          push(summary)
          baselineId = Math.max(baselineId, ...fresh.map(run => run.id))
        }
        // Quiet polls push nothing: the buffer is for state transitions
        // (start, baseline, detections, errors, terminal), and a capped
        // buffer full of heartbeats would evict the detection summary.
      } catch (error) {
        if (error instanceof GhError && error.kind === 'auth') {
          finish(
            { status: 'failed', detail: 'gh authentication failed' },
            `ci_watch: ${error.message}`,
          )
          return
        }
        failures++
        const message = error instanceof Error ? error.message : String(error)
        push(`ci_watch: poll error (${failures} consecutive): ${message}`)
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          finish(
            { status: 'failed', detail: `poll failed ${failures} times` },
            `ci_watch: giving up after ${failures} consecutive errors. Last: ${message}`,
          )
          return
        }
      }
    }
    finish(
      { status: 'killed', detail: cancelReason ?? 'cancelled' },
      `ci_watch: watch on ${spec.repo} cancelled (${cancelReason ?? 'no reason'})`,
    )
  })().catch((error: unknown) => {
    settle({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
  })

  return {
    cancel(reason) {
      if (cancelReason === undefined) {
        cancelReason = reason ?? 'cancelled'
        wake?.()
      }
    },
    done,
    readOutput() {
      const text = buffer.join('\n')
      buffer = []
      return text
    },
  }
}
