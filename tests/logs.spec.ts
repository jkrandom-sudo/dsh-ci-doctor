import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { trimLog } from '../src/logs.ts'

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'logs')

describe('trimLog', () => {
  it('passes short logs through unchanged', () => {
    const log = readFileSync(path.join(fixtures, 'clean.log'), 'utf8')
    expect(trimLog(log, { maxLines: 200 })).toBe(log)
  })

  it('keeps the head and error windows, marking dropped ranges', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    lines[50] = 'error: something broke'
    const trimmed = trimLog(lines.join('\n'), { maxLines: 40, contextLines: 2, headLines: 3 })
    expect(trimmed).toContain('line 0')
    expect(trimmed).toContain('line 2')
    expect(trimmed).toContain('line 48')
    expect(trimmed).toContain('error: something broke')
    expect(trimmed).toContain('line 52')
    expect(trimmed).toContain('… (skipped')
    expect(trimmed).not.toContain('line 20\n')
  })

  it('respects maxLines even with many error windows', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `error number ${i} on line`)
    const trimmed = trimLog(lines.join('\n'), { maxLines: 30, contextLines: 1 })
    const kept = trimmed.split('\n').filter(line => !line.startsWith('… (skipped'))
    expect(kept.length).toBeLessThanOrEqual(30)
    expect(trimmed).toContain('… (skipped')
  })

  it('never invents content — kept lines are raw log lines', () => {
    const log = readFileSync(path.join(fixtures, 'test-failure.log'), 'utf8')
    const trimmed = trimLog(log, { maxLines: 12, contextLines: 1, headLines: 2 })
    const rawLines = new Set(log.split('\n'))
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('… (skipped')) continue
      expect(rawLines.has(line)).toBe(true)
    }
  })

  it('keeps only the head when nothing is interesting', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `boring ${i}`)
    const trimmed = trimLog(lines.join('\n'), { maxLines: 10, headLines: 4 })
    expect(trimmed).toContain('boring 0')
    expect(trimmed).toContain('boring 3')
    expect(trimmed).not.toContain('boring 10')
    expect(trimmed).toContain('… (skipped 46 lines) …')
  })
})
