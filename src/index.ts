/**
 * Standalone function plugin for DeepSeek Harness.
 * @module dsh-ci-doctor
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'dsh-ci-doctor'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['tools']

export { Config } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { apply } from './runtime.ts'
export type { CiDiagnoseValue, CiWatchValue, DoctorDeps, JobDiagnosis } from './runtime.ts'
