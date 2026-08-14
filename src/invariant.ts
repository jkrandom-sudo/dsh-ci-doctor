/**
 * Package-owned invariant companion for `dsh-ci-doctor`.
 *
 * The package's authoritative contract: ci_watch and ci_diagnose are
 * read-only against the repository and CI state — they call the GitHub API
 * for reads only and never push, merge, cancel, or rerun anything. Their
 * canonical values carry the `repositoryWrites: false` marker; the companion
 * observes the post-execute waterfall and fails if a result ever loses it.
 * @module dsh-ci-doctor/invariant
 */

import type { Context } from 'cordis'

import type { PendingExecution, PostToolDecision } from './events.ts'

const PACKAGE_NAME = 'dsh-ci-doctor'

/** Tools covered by the read-only contract. */
const WATCHED_TOOLS = new Set(['ci_watch', 'ci_diagnose'])

/** A package-attributed invariant failure reported by the host registry. */
type InvariantFailure = (message: string) => never

/** Installer callback accepted by the host's invariant registry. */
type InvariantInstaller = (ctx: Context, fail: InvariantFailure) => void | Promise<void>

/** Minimal runtime contract used by the companion without a host checkout. */
interface InvariantRegistry {
  register(packageName: string, installer: InvariantInstaller): () => void
}

/** Cordis companion plugin name. */
export const name = 'dsh-ci-doctor-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface DoctorResultValue {
  /** Failed tool calls carry isError and no value — they are not tool output. */
  isError?: boolean
  value?: { repositoryWrites?: boolean }
}

/**
 * Watch ci_* results and enforce the read-only contract.
 * @param ctx - Cordis context carrying the event bus.
 * @param fail - Registry-provided failure reporter.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on(
    'tools/post-execute',
    async (
      exec: PendingExecution,
      result: DoctorResultValue,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      if (
        exec?.name !== undefined &&
        WATCHED_TOOLS.has(exec.name) &&
        result?.isError !== true &&
        result?.value?.repositoryWrites !== false
      ) {
        fail(`${exec.name} result lost its read-only marker (repositoryWrites !== false)`)
      }
      return next()
    },
  )
}

/**
 * Resolve the host registry through Cordis's named service lookup.
 * @param ctx - Cordis context carrying the host service.
 * @returns the host invariant registry.
 * @throws {Error} when the companion is loaded without its host service.
 */
function getInvariantRegistry(ctx: Context): InvariantRegistry {
  const registry = ctx.get('invariants') as InvariantRegistry | undefined
  if (registry === undefined) {
    throw new Error(`invariant companion requires the "invariants" service for ${PACKAGE_NAME}`)
  }
  return registry
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = async (ctx: Context): Promise<() => void> =>
  getInvariantRegistry(ctx).register(PACKAGE_NAME, install)
