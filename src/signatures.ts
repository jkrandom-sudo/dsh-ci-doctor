/**
 * Pure log analysis: error-signature extraction, normalization, failure
 * classification, and suspect-file mining. No IO — every function is
 * deterministic and unit-tested against fixtures.
 * @module dsh-ci-doctor/signatures
 */

import { createHash } from 'node:crypto'

/** Failure categories the doctor reports. */
export type FailureCategory =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'dependency'
  | 'network'
  | 'permission'
  | 'timeout'
  | 'infra'
  | 'unknown'

/** One extracted, normalized error signature. */
export interface ErrorSignature {
  /** Stable short id derived from the normalized text. */
  id: string
  /** Normalized one-line signature text. */
  text: string
  /** Best-effort failure category. */
  category: FailureCategory
  /** Raw log line the signature was extracted from. */
  evidence: string
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** Strip ANSI escape sequences (colors, cursor moves, hyperlinks). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

const TIMESTAMP_RES = [
  // GitHub Actions log prefix: 2026-08-14T07:12:33.1234567Z
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s*/,
  // ISO-ish anywhere in the line
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g,
  // Clock-only timestamps: 07:12:33
  /\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g,
]

const HEX_RE = /\b[0-9a-f]{7,40}\b/gi
const NUMBER_RE = /\b\d+\b/g
const WHITESPACE_RE = /\s+/g

/**
 * Normalize a log line into a stable signature text: timestamps, hex ids
 * (SHAs), and standalone numbers are masked so the same failure produces the
 * same signature across runs.
 * @param line - One raw log line.
 * @returns Normalized signature text, trimmed and single-spaced.
 */
export function normalizeLine(line: string): string {
  let out = stripAnsi(line)
  for (const re of TIMESTAMP_RES) out = out.replace(re, '')
  out = out.replace(HEX_RE, '<hex>')
  out = out.replace(NUMBER_RE, '<n>')
  return out.replace(WHITESPACE_RE, ' ').trim()
}

/** Lines that carry failure information worth a signature. */
const ERROR_LINE_RE = new RegExp(
  [
    '\\berror\\b',
    '\\berrors\\b',
    '\\bfailed\\b',
    '\\bfailure\\b',
    '\\bexception\\b',
    '\\btraceback\\b',
    '\\bpanic\\b',
    '\\bfatal\\b',
    '\\berrno\\b',
    'exit code [1-9]',
    '\\bfailing\\b',
    '\\bfail:',
    '\\berr!',
    '\\berror:',
    '\\bfail\\b',
    '\\bassertion',
    'cannot find',
    'compilation terminated',
    '\\bdied\\b',
    '\\btimed? ?out\\b',
  ].join('|'),
  'i',
)

/** Lines that look noisy rather than diagnostic; dropped from signatures. */
const NOISE_LINE_RE = new RegExp(
  [
    '^##\\[', // GitHub Actions group/notice markers
    '^\\s*$',
    'npm warn',
    'deprecated',
    '^\\s*at ', // stack-trace frames repeat the headline error
  ].join('|'),
  'i',
)

const MAX_SIGNATURE_LENGTH = 200

/**
 * Stable short id for a normalized signature (first 12 hex chars of sha1).
 * @param text - Normalized signature text.
 * @returns 12-char hex id.
 */
export function signatureId(text: string): string {
  return createHash('sha1').update(text.toLowerCase()).digest('hex').slice(0, 12)
}

const CATEGORY_RULES: [FailureCategory, RegExp][] = [
  [
    'test',
    /(\btests?\b.*(fail|error)|\bfail(ed)?\b.*\btests?\b|assertion|expect(ed)?\b.*\b(received|to be)|✕|✗|\bfailing tests?\b|jest|vitest|pytest|mocha|junit)/i,
  ],
  [
    'typecheck',
    /(ts\d{4}|typescript|type error|typecheck|mypy|pyright|cannot find name|is not assignable)/i,
  ],
  ['lint', /(\blint\b|eslint|stylelint|ruff|flake8|pylint|prettier.*(error|fail)|golangci)/i],
  [
    'dependency',
    /(e404|not found.*(package|module|dependency)|cannot find module|no matching version|resolve.*dependenc|pip install.*(error|fail)|npm err!.*(eresolve|404)|package .* not found|modulenotfounderror)/i,
  ],
  [
    'permission',
    /(eacces|eperm|permission denied|forbidden|401\b|403\b|unauthorized|authentication failed|bad credentials)/i,
  ],
  [
    'network',
    /(econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network error|dns|fetch failed|502\b|503\b|504\b)/i,
  ],
  ['timeout', /(\btimed? ?out\b|deadline exceeded|timeout of \d+ms exceeded|killed.*timeout)/i],
  [
    'build',
    /(compilation|compile error|build failed|linker|ld:|rustc|gcc|g\+\+|cargo|go build|webpack|vite build|esbuild|tsc\b)/i,
  ],
  [
    'infra',
    /(runner.*(offline|lost)|out of memory|oomkilled|no space left|disk quota|rate limit|internal server error|service unavailable)/i,
  ],
]

/**
 * Best-effort category for one normalized signature.
 * @param text - Normalized signature text.
 * @returns The matching category, or 'unknown'.
 */
export function classifySignature(text: string): FailureCategory {
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(text)) return category
  }
  return 'unknown'
}

/**
 * Extract deduplicated error signatures from a job log, first occurrences
 * first. Signatures are normalized (timestamps/hex/numbers masked), capped in
 * length, and capped in count.
 * @param log - Raw job log text (any size).
 * @param max - Maximum signatures returned (default 8).
 * @returns Extracted signatures in log order.
 */
export function extractSignatures(log: string, max = 8): ErrorSignature[] {
  const seen = new Set<string>()
  const out: ErrorSignature[] = []
  for (const rawLine of log.split('\n')) {
    const line = stripAnsi(rawLine).trim()
    if (line === '' || NOISE_LINE_RE.test(line)) continue
    if (!ERROR_LINE_RE.test(line)) continue
    const text = normalizeLine(line).slice(0, MAX_SIGNATURE_LENGTH)
    if (text === '') continue
    const id = signatureId(text)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, text, category: classifySignature(text), evidence: line.slice(0, 400) })
    if (out.length >= max) break
  }
  return out
}

/** Extensions that mark a token as a plausible source file. */
const SOURCE_FILE_RE =
  /(?:^|[\s('"`])((?:[\w@.-]+\/)*[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|svelte|yml|yaml|json|toml))(?::\d+(?::\d+)?)?/g

/** Path prefixes that identify noise rather than repo files. */
const VENDOR_PATH_RE =
  /^(node_modules|site-packages|vendor|dist|build|\.git|usr\/|opt\/|home\/runner\/work\/_)/

/**
 * Mine repo-relative file paths mentioned near log errors. Vendor and
 * absolute toolchain paths are dropped; results are deduplicated in first-seen
 * order.
 * @param log - Raw job log text.
 * @param max - Maximum paths returned (default 10).
 * @returns Plausible suspect file paths.
 */
export function extractSuspectFiles(log: string, max = 10): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of log.split('\n')) {
    if (!ERROR_LINE_RE.test(line) && !line.includes(':')) continue
    for (const match of line.matchAll(SOURCE_FILE_RE)) {
      const candidate = match[1]
      if (candidate === undefined) continue
      const cleaned = candidate.replace(/^\.\//, '')
      if (VENDOR_PATH_RE.test(cleaned)) continue
      if (cleaned.includes('://')) continue
      if (seen.has(cleaned)) continue
      seen.add(cleaned)
      out.push(cleaned)
      if (out.length >= max) return out
    }
  }
  return out
}
