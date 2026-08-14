/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-ci-doctor/config
 */

import z from 'schemastery'

/** Plugin configuration supplied by the profile composition. */
export interface Config {
  /** Seconds between GitHub polls while a watch is running. Default 30. */
  pollIntervalSeconds?: number
  /** Maximum wall-clock minutes one watch stays alive. Default 60. */
  watchTimeoutMinutes?: number
  /** Maximum log lines kept per failed job in a diagnosis. Default 200. */
  maxLogLines?: number
  /** GitHub CLI executable used for all API calls. Default "gh". */
  ghBin?: string
  /** Persist the failure-signature ledger via ctx.storageDomain when available. Default true. */
  ledgerEnabled?: boolean
}

/** Configuration after defaults have been resolved. */
export interface ResolvedConfig {
  /** Seconds between GitHub polls while a watch is running. */
  pollIntervalSeconds: number
  /** Maximum wall-clock minutes one watch stays alive. */
  watchTimeoutMinutes: number
  /** Maximum log lines kept per failed job in a diagnosis. */
  maxLogLines: number
  /** GitHub CLI executable used for all API calls. */
  ghBin: string
  /** Persist the failure-signature ledger via ctx.storageDomain when available. */
  ledgerEnabled: boolean
}

/** Loader-visible configuration schema and defaults. */
export const Config: z<Config> = z.object({
  pollIntervalSeconds: z
    .number()
    .description('Seconds between GitHub Actions polls while a ci_watch job is running.')
    .min(5)
    .default(30),
  watchTimeoutMinutes: z
    .number()
    .description('Maximum wall-clock minutes one ci_watch job stays alive before expiring.')
    .min(1)
    .default(60),
  maxLogLines: z
    .number()
    .description('Maximum log lines kept per failed job in a ci_diagnose report.')
    .min(20)
    .default(200),
  ghBin: z
    .string()
    .description('GitHub CLI executable used for every API call (must be authenticated).')
    .default('gh'),
  ledgerEnabled: z
    .boolean()
    .description(
      'Persist the failure-signature ledger through ctx.storageDomain when the profile provides it; otherwise kept in memory.',
    )
    .default(true),
})

/**
 * Resolve the same defaults for direct callers that bypass Cordis Loader.
 * @param config - Partial serialized configuration.
 * @returns Configuration with all defaults applied.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    pollIntervalSeconds: config.pollIntervalSeconds ?? 30,
    watchTimeoutMinutes: config.watchTimeoutMinutes ?? 60,
    maxLogLines: config.maxLogLines ?? 200,
    ghBin: config.ghBin ?? 'gh',
    ledgerEnabled: config.ledgerEnabled ?? true,
  }
}
