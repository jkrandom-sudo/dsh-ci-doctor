import { describe, expect, it } from 'vitest'

import {
  createMemoryLedger,
  LEDGER_DOMAIN_NAME,
  LEDGER_DOMAIN_VERSION,
  openDomainLedger,
} from '../src/ledger.ts'

const OBSERVATION = {
  repo: 'octo/demo',
  runUrl: 'https://example/run/1',
  now: new Date('2026-08-14T07:00:00Z'),
}
const INPUT = { id: 'abc123def456', text: 'AssertionError: boom', category: 'test' as const }

describe('createMemoryLedger', () => {
  it('creates a record on first observation', async () => {
    const ledger = createMemoryLedger()
    const record = await ledger.record(INPUT, OBSERVATION)
    expect(record.count).toBe(1)
    expect(record.firstSeenAt).toBe('2026-08-14T07:00:00.000Z')
    expect(record.lastRepo).toBe('octo/demo')
    expect(await ledger.size()).toBe(1)
    expect(ledger.durable).toBe(false)
  })

  it('bumps count and refreshes lastSeen on repeat observations', async () => {
    const ledger = createMemoryLedger()
    await ledger.record(INPUT, OBSERVATION)
    const later = { ...OBSERVATION, now: new Date('2026-08-14T09:30:00Z') }
    const record = await ledger.record(INPUT, later)
    expect(record.count).toBe(2)
    expect(record.firstSeenAt).toBe('2026-08-14T07:00:00.000Z')
    expect(record.lastSeenAt).toBe('2026-08-14T09:30:00.000Z')
    const lookedUp = await ledger.lookup(INPUT.id)
    expect(lookedUp?.count).toBe(2)
  })

  it('keeps distinct signatures apart', async () => {
    const ledger = createMemoryLedger()
    await ledger.record(INPUT, OBSERVATION)
    await ledger.record({ ...INPUT, id: 'fff000fff000' }, OBSERVATION)
    expect(await ledger.size()).toBe(2)
    expect((await ledger.lookup('fff000fff000'))?.count).toBe(1)
  })

  it('omits optional repo/runUrl when not observed', async () => {
    const ledger = createMemoryLedger()
    const record = await ledger.record(INPUT, { now: new Date('2026-08-14T07:00:00Z') })
    expect('lastRepo' in record).toBe(false)
    expect('lastRunUrl' in record).toBe(false)
  })
})

describe('openDomainLedger', () => {
  /** A fake storage-domain facility backed by a Map, validating the spec shape. */
  function fakeFacility() {
    const storage = new Map<string, unknown>()
    const opened: { name: string; version: number; tables: string[] }[] = []
    return {
      opened,
      closed: 0 as number,
      async open(spec: { name: string; version: number; tables: Record<string, unknown> }) {
        opened.push({ name: spec.name, version: spec.version, tables: Object.keys(spec.tables) })
        const facility = this
        return {
          table(name: string) {
            if (name !== 'signatures') throw new Error(`unknown table ${name}`)
            return {
              get: (key: string) => storage.get(key),
              async put(key: string, value: unknown) {
                storage.set(key, value)
              },
              keys: () => storage.keys(),
            }
          },
          async close() {
            facility.closed++
          },
        }
      },
    }
  }

  it('opens the ci_doctor domain with the signatures table', async () => {
    const facility = fakeFacility()
    const ledger = await openDomainLedger(facility)
    expect(facility.opened).toEqual([
      {
        name: LEDGER_DOMAIN_NAME,
        version: LEDGER_DOMAIN_VERSION,
        tables: ['signatures'],
      },
    ])
    expect(LEDGER_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(ledger.durable).toBe(true)
    await ledger.close()
    expect(facility.closed).toBe(1)
  })

  it('persists records through the table', async () => {
    const facility = fakeFacility()
    const ledger = await openDomainLedger(facility)
    await ledger.record(INPUT, OBSERVATION)
    const again = await ledger.record(INPUT, {
      ...OBSERVATION,
      now: new Date('2026-08-15T00:00:00Z'),
    })
    expect(again.count).toBe(2)
    expect(await ledger.size()).toBe(1)
    expect((await ledger.lookup(INPUT.id))?.lastSeenAt).toBe('2026-08-15T00:00:00.000Z')
    await ledger.close()
  })

  it('forwards close to the domain', async () => {
    const facility = fakeFacility()
    const ledger = await openDomainLedger(facility)
    await ledger.close()
    expect(facility.closed).toBe(1)
  })
})
