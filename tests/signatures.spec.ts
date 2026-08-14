import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  classifySignature,
  extractSignatures,
  extractSuspectFiles,
  normalizeLine,
  signatureId,
  stripAnsi,
} from '../src/signatures.ts'

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'logs')

function readFixture(name: string): string {
  return readFileSync(path.join(fixtures, name), 'utf8')
}

describe('stripAnsi', () => {
  it('removes color and cursor sequences', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m happened')).toBe('error happened')
    expect(stripAnsi('\x1b[1;32mok\x1b[39m')).toBe('ok')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain line')).toBe('plain line')
  })
})

describe('normalizeLine', () => {
  it('masks GitHub Actions timestamp prefixes', () => {
    expect(normalizeLine('2026-08-14T07:12:08.5000000Z AssertionError: boom')).toBe(
      'AssertionError: boom',
    )
  })

  it('masks hex ids and standalone numbers', () => {
    expect(normalizeLine('commit 0123456789abcdef failed after 30 retries')).toBe(
      'commit <hex> failed after <n> retries',
    )
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeLine('  error:   cannot   find   module  ')).toBe('error: cannot find module')
  })

  it('produces the same text for two runs of the same failure', () => {
    const a = normalizeLine('2026-08-14T07:12:08.5Z error TS6133: x unused (exit 2)')
    const b = normalizeLine('2026-08-15T09:44:11.9Z error TS6133: x unused (exit 2)')
    expect(a).toBe(b)
    expect(signatureId(a)).toBe(signatureId(b))
  })
})

describe('signatureId', () => {
  it('is case-insensitive and stable', () => {
    expect(signatureId('Error: Boom')).toBe(signatureId('error: boom'))
    expect(signatureId('Error: Boom')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('differs for different texts', () => {
    expect(signatureId('error A')).not.toBe(signatureId('error B'))
  })
})

describe('classifySignature', () => {
  const cases: [string, string][] = [
    ['AssertionError: expected x to be y', 'test'],
    ['FAIL tests/watcher.spec.ts > expires', 'test'],
    ['error TS6133: declared but never read', 'typecheck'],
    ['eslint error: no-unused-vars', 'lint'],
    ['npm ERR! code E404 not found', 'dependency'],
    ['Cannot find module left-pad', 'dependency'],
    ['EACCES: permission denied, open /root/x', 'permission'],
    ['403 forbidden: authentication failed', 'permission'],
    ['fetch failed: ECONNREFUSED', 'network'],
    ['timeout of 30000ms exceeded', 'timeout'],
    ['compilation terminated with errors', 'build'],
    ['no space left on device', 'infra'],
    ['something utterly unrecognizable blorp', 'unknown'],
  ]
  it.each(cases)('classifies %s as %s', (text, category) => {
    expect(classifySignature(text)).toBe(category)
  })
})

describe('extractSignatures', () => {
  it('extracts test-failure signatures from the fixture', () => {
    const signatures = extractSignatures(readFixture('test-failure.log'))
    expect(signatures.length).toBeGreaterThan(0)
    const categories = signatures.map(s => s.category)
    expect(categories).toContain('test')
    const texts = signatures.map(s => s.text)
    expect(texts.some(t => t.includes('AssertionError'))).toBe(true)
  })

  it('classifies typecheck failures from the fixture', () => {
    const signatures = extractSignatures(readFixture('typecheck-failure.log'))
    expect(signatures.some(s => s.category === 'typecheck')).toBe(true)
  })

  it('classifies dependency failures from the fixture', () => {
    const signatures = extractSignatures(readFixture('dependency-failure.log'))
    expect(signatures.some(s => s.category === 'dependency')).toBe(true)
  })

  it('returns nothing for a clean log', () => {
    expect(extractSignatures(readFixture('clean.log'))).toEqual([])
  })

  it('dedupes repeated error lines', () => {
    const log = [
      'error: boom happened',
      'error: boom happened',
      '2026-08-14T07:00:00Z error: boom happened',
    ].join('\n')
    expect(extractSignatures(log)).toHaveLength(1)
  })

  it('skips noise lines (actions markers, stack frames, npm warnings)', () => {
    const log = [
      '##[group]Run pnpm test', // dropped — group/notice marker
      'npm warn deprecated something',
      '    at Object.<anonymous> (x.ts:1:1)',
      '',
    ].join('\n')
    expect(extractSignatures(log)).toEqual([])
  })

  it('keeps the canonical ##[error] failure line, unwrapped', () => {
    // GitHub Actions marks its headline failure line with ##[error]; the
    // noise filter drops other ##[ markers but this one must survive.
    const signatures = extractSignatures('##[error]Process completed with exit code 1.')
    expect(signatures).toHaveLength(1)
    expect(signatures[0]?.text).toBe('Process completed with exit code <n>.')
  })

  it('masks long hex digests (sha256) so signatures stay stable', () => {
    const first = extractSignatures(
      'error: checksum mismatch a94a8fe5ccb19ba61c4c0873d391e987982fbbd3e5c8b2e9f4a0c1d2e3f40506',
    )
    const second = extractSignatures(
      'error: checksum mismatch 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.id).toBe(second[0]?.id)
  })

  it('caps the number of signatures', () => {
    const log = Array.from({ length: 30 }, (_, i) => `error: failure kind ${i}`).join('\n')
    // All lines normalize to the same masked text? No — the number is masked,
    // so they dedupe to one. Use distinct words instead.
    expect(extractSignatures(log).length).toBeLessThanOrEqual(1)
    const distinct = Array.from(
      { length: 30 },
      (_, i) => `error: failure-kind-${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i}`,
    ).join('\n')
    expect(extractSignatures(distinct, 5)).toHaveLength(5)
  })
})

describe('extractSuspectFiles', () => {
  it('mines repo-relative files from the test fixture', () => {
    const files = extractSuspectFiles(readFixture('test-failure.log'))
    expect(files).toContain('tests/watcher.spec.ts')
  })

  it('mines files from the typecheck fixture', () => {
    const files = extractSuspectFiles(readFixture('typecheck-failure.log'))
    expect(files).toContain('src/gh.ts')
    expect(files).toContain('src/runtime.ts')
  })

  it('drops vendor and absolute toolchain paths', () => {
    const log =
      'error in node_modules/left-pad/index.js and /usr/lib/node_modules/npm/cli.js but also src/app.ts'
    const files = extractSuspectFiles(log)
    expect(files).toEqual(['src/app.ts'])
  })

  it('dedupes and caps results', () => {
    const log = Array.from({ length: 20 }, (_, i) => `error at src/file${i % 5}.ts:1:1`).join('\n')
    const files = extractSuspectFiles(log)
    expect(files).toHaveLength(5)
    const many = Array.from({ length: 30 }, (_, i) => `error at src/unique${i}.ts:1:1`).join('\n')
    expect(extractSuspectFiles(many, 10)).toHaveLength(10)
  })
})
