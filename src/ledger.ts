/**
 * Failure-signature ledger: remembers how often each normalized CI failure
 * has been seen. Durable through the host's storage domain when the profile
 * provides one; in-memory otherwise. The ledger is the plugin's compounding
 * asset — it survives DSH API drift because it is plain data.
 * @module dsh-ci-doctor/ledger
 */

import type { FailureCategory } from './signatures.ts'

/** One ledger record for a normalized error signature. */
export interface SignatureRecord {
  /** Stable signature id (see signatures.ts). */
  id: string
  /** Normalized signature text. */
  text: string
  /** Best-effort failure category. */
  category: FailureCategory
  /** How many diagnoses observed this signature. */
  count: number
  /** ISO timestamp of the first observation. */
  firstSeenAt: string
  /** ISO timestamp of the latest observation. */
  lastSeenAt: string
  /** Repository of the latest observation (`owner/name`), when known. */
  lastRepo?: string
  /** Workflow run URL of the latest observation, when known. */
  lastRunUrl?: string
}

/** Observation context attached to one upsert. */
export interface Observation {
  /** Repository being diagnosed (`owner/name`). */
  repo?: string
  /** Workflow run URL being diagnosed. */
  runUrl?: string
  /** Observation time. */
  now: Date
}

/** The ledger interface both backends implement. */
export interface LedgerStore {
  /** True when records survive restarts. */
  readonly durable: boolean
  /** Read one record by signature id. */
  lookup(id: string): Promise<SignatureRecord | undefined>
  /**
   * Insert or refresh one observation: first observation creates the record
   * with count 1; later ones bump count and lastSeen/lastRepo/lastRunUrl.
   * @returns The stored record after the upsert.
   */
  record(
    input: { id: string; text: string; category: FailureCategory },
    observation: Observation,
  ): Promise<SignatureRecord>
  /** Total records held. */
  size(): Promise<number>
  /** Release the backend. Idempotent. */
  close(): Promise<void>
}

function mergeRecord(
  existing: SignatureRecord | undefined,
  input: { id: string; text: string; category: FailureCategory },
  observation: Observation,
): SignatureRecord {
  const iso = observation.now.toISOString()
  if (existing === undefined) {
    return {
      id: input.id,
      text: input.text,
      category: input.category,
      count: 1,
      firstSeenAt: iso,
      lastSeenAt: iso,
      ...(observation.repo !== undefined ? { lastRepo: observation.repo } : {}),
      ...(observation.runUrl !== undefined ? { lastRunUrl: observation.runUrl } : {}),
    }
  }
  return {
    ...existing,
    text: input.text,
    category: input.category,
    count: existing.count + 1,
    lastSeenAt: iso,
    ...(observation.repo !== undefined ? { lastRepo: observation.repo } : {}),
    ...(observation.runUrl !== undefined ? { lastRunUrl: observation.runUrl } : {}),
  }
}

/**
 * In-memory ledger. Used when the profile provides no storage domain or the
 * domain open fails; the tools behave identically, records just do not
 * survive restarts.
 */
export function createMemoryLedger(): LedgerStore {
  const records = new Map<string, SignatureRecord>()
  return {
    durable: false,
    lookup: async id => records.get(id),
    async record(input, observation) {
      const merged = mergeRecord(records.get(input.id), input, observation)
      records.set(input.id, merged)
      return merged
    },
    size: async () => records.size,
    close: async () => undefined,
  }
}

/** Minimal structural view of the host's storage-domain facility. */
interface DomainFacilityLike {
  open(spec: {
    name: string
    version: number
    tables: Record<string, { valueSchema: unknown }>
  }): Promise<DomainLike>
}

interface DomainLike {
  table(name: string): {
    get(key: string): unknown
    put(key: string, value: unknown): Promise<void>
    keys(): IterableIterator<string>
  }
  close(): Promise<void>
}

/** Domain name; must match the host's UNIT_NAME_RE (`/^[a-z][a-z0-9_]*$/`). */
export const LEDGER_DOMAIN_NAME = 'ci_doctor'
/** Domain format version; bump on record shape changes. */
export const LEDGER_DOMAIN_VERSION = 1

/**
 * Open the durable ledger over the host's storage domain. zod is imported
 * lazily so the plugin loads without it when no storage domain exists (zod is
 * an optional peer dependency, present in every stock profile through
 * dsh-storage-domain).
 * @param facility - The host's `ctx.storageDomain` facility.
 * @returns The durable ledger.
 * @throws When zod is unavailable or the domain open fails; callers fall back
 *   to the memory ledger.
 */
export async function openDomainLedger(facility: unknown): Promise<LedgerStore> {
  const { z } = await import('zod')
  const recordSchema = z.object({
    id: z.string(),
    text: z.string(),
    category: z.enum([
      'test',
      'build',
      'lint',
      'typecheck',
      'dependency',
      'network',
      'permission',
      'timeout',
      'infra',
      'unknown',
    ]),
    count: z.number().int().nonnegative(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    lastRepo: z.string().optional(),
    lastRunUrl: z.string().optional(),
  })
  const domain = await (facility as DomainFacilityLike).open({
    name: LEDGER_DOMAIN_NAME,
    version: LEDGER_DOMAIN_VERSION,
    tables: { signatures: { valueSchema: recordSchema } },
  })
  const table = domain.table('signatures')
  // record() is a read-modify-write across an await (put), and the diagnose
  // tool advertises isConcurrencySafe — serialize upserts so two concurrent
  // diagnoses of the same signature can't both read count N and write N+1.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    durable: true,
    lookup: async id => table.get(id) as SignatureRecord | undefined,
    record(input, observation) {
      const op = queue.then(async () => {
        const merged = mergeRecord(
          table.get(input.id) as SignatureRecord | undefined,
          input,
          observation,
        )
        await table.put(input.id, merged)
        return merged
      })
      queue = op.catch(() => undefined)
      return op
    },
    size: async () => {
      let count = 0
      for (const _ of table.keys()) count++
      return count
    },
    close: () => domain.close(),
  }
}
