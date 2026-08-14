/**
 * Failure-log windowing: keep the error neighborhoods plus the run's opening
 * context, drop the bulk, and say exactly what was dropped.
 * @module dsh-ci-doctor/logs
 */

import { stripAnsi } from './signatures.ts'

/** Lines worth keeping a window around. Mirrors signatures.ts error cues. */
const INTERESTING_LINE_RE = new RegExp(
  [
    '\\berror\\b',
    '\\bfailed\\b',
    '\\bfailure\\b',
    '\\bexception\\b',
    '\\btraceback\\b',
    '\\bpanic\\b',
    '\\bfatal\\b',
    'exit code [1-9]',
    '\\berr!',
    'cannot find',
    '\\bfailing\\b',
  ].join('|'),
  'i',
)

/** Options controlling one log trim. */
export interface TrimOptions {
  /** Maximum lines in the returned windowed log. */
  maxLines: number
  /** Context lines kept before and after each error line. */
  contextLines?: number
  /** Opening lines always kept (setup context: runner, versions). */
  headLines?: number
}

/**
 * Trim a job log to its error neighborhoods. The first `headLines` lines are
 * always kept; every line matching the error cues contributes a
 * ±`contextLines` window; dropped ranges are marked with
 * `… (skipped N lines) …`. Never invents content: every kept line is a raw
 * log line (ANSI-stripped).
 * @param log - Raw job log text of any size.
 * @param options - Window bounds.
 * @returns The trimmed log, at most roughly `maxLines` long.
 */
export function trimLog(log: string, options: TrimOptions): string {
  const maxLines = Math.max(1, options.maxLines)
  const context = Math.max(0, options.contextLines ?? 3)
  const head = Math.max(0, Math.min(options.headLines ?? 5, maxLines))

  const lines = stripAnsi(log).split('\n')
  if (lines.length <= maxLines) return lines.join('\n')

  const keep = new Uint8Array(lines.length)
  for (let i = 0; i < head && i < lines.length; i++) keep[i] = 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && INTERESTING_LINE_RE.test(line)) {
      const from = Math.max(0, i - context)
      const to = Math.min(lines.length - 1, i + context)
      for (let j = from; j <= to; j++) keep[j] = 1
    }
  }

  const out: string[] = []
  let skipped = 0
  let kept = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep[i] === 1 && kept < maxLines) {
      if (skipped > 0) {
        out.push(`… (skipped ${skipped} lines) …`)
        skipped = 0
      }
      const line = lines[i]
      if (line !== undefined) {
        out.push(line)
        kept++
      }
    } else if (keep[i] === 1) {
      // Over budget: count the rest of the interesting lines as skipped too.
      skipped++
    } else {
      skipped++
    }
  }
  if (skipped > 0) out.push(`… (skipped ${skipped} lines) …`)
  return out.join('\n')
}
