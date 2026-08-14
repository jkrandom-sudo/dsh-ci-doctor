/**
 * Real-environment verification for dsh-ci-doctor.
 *
 * Boots the actual local `web` profile composition in-process through the
 * public dsh-app-boot seam (same exports the dsh launcher's profile-boot
 * chunk uses), with the webserver overlaid to port 0 so the check never
 * collides with a running instance. Against the live tree it then:
 *
 *   1. asserts ci_watch + ci_diagnose are registered on the real tools runtime
 *   2. dispatches the real host exec shape `{ name, arguments }` through the
 *      tools/pre-execute waterfall (coexistence with other plugins' guards)
 *   3. executes ci_diagnose end-to-end against a real GitHub repository via
 *      the host shell + real gh CLI (read-only), then runs the result through
 *      the tools/post-execute waterfall
 *   4. starts a real ci_watch background job on the host jobs registry, reads
 *      its streamed baseline output, kills it, and awaits settlement
 *   5. proves the signature ledger is durable: after disposal the storage
 *      unit file exists under ~/.dsh/storages and holds the recorded
 *      signature ids from step 3
 *
 * Usage: node scripts/verify-web-profile.mjs [owner/repo]
 * The default repo is cli/cli, which reliably has recent failed runs (the
 * durability proof needs a diagnosis with real signatures).
 * Exit code 0 = every assertion passed.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.argv[2] ?? 'cli/cli'
const NM = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
// The anchor must be the REAL dsh installation, not the flat fallback link in
// profiles/node_modules: healProfilesModuleFallback re-points that fallback
// directory from whatever the anchor's dependency closure resolves to, so an
// anchor inside the fallback would link every package onto itself (ELOOP).
// realpath follows the fallback symlink into the actual installation.
const INSTALL_ANCHOR = realpathSync(join(NM, 'dsh', 'package.json'))
const LEDGER_FILE = join(homedir(), '.dsh', 'storages', 'ci_doctor.json')

const importProfilePkg = name => import(pathToFileURL(join(NM, name, 'lib', 'index.js')).href)

const { boot, loadProfile, healProfilesModuleFallback, loadLayeredEnv } =
  await importProfilePkg('dsh-app-boot')
const { provideCmdline } = await importProfilePkg('dsh-cmdline')
const { DSH_LAUNCH_ENVIRONMENT_KEY } = await importProfilePkg('dsh-launch-environment')

let failures = 0
const check = (label, condition, detail) => {
  const ok = Boolean(condition)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`,
  )
  if (!ok) failures++
}

const watchdog = setTimeout(() => {
  console.error('FAIL  verification timed out after 180s')
  process.exit(2)
}, 180_000)

console.log(`== dsh-ci-doctor real-environment verification (web profile, repo ${REPO}) ==`)

// Snapshot the ledger file's mtime BEFORE boot: signature ids are
// deterministic content hashes, so an ids-substring check alone would pass
// against a stale file even if this run silently fell back to the memory
// ledger. The durability proof must show THIS run rewrote the file.
const ledgerMtimeBefore = existsSync(LEDGER_FILE) ? statSync(LEDGER_FILE).mtimeMs : 0

healProfilesModuleFallback(INSTALL_ANCHOR)
const profile = loadProfile('dsh', 'web', INSTALL_ANCHOR)
const patches = [
  ...profile.layers.flatMap(layer => layer.patches),
  ...profile.patches,
  // Overlay: never bind the default 3080 during verification.
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
]

const ctx = await boot('dsh', join(profile.dir, 'cordis.yml'), patches, hostCtx => {
  hostCtx.provide(
    DSH_LAUNCH_ENVIRONMENT_KEY,
    loadLayeredEnv('dsh', process.cwd(), () => {}),
  )
  provideCmdline(hostCtx, { args: [], exit: () => {} })
})
console.log('boot complete: web profile composition mounted in-process')

// Ids of the signatures this run records, reused by the durability check
// after the tree is disposed.
let recordedSignatureIds = []

try {
  // ── 1. registration on the real tools runtime ────────────────────────────
  const tools = ctx.get('tools')
  check('tools service is present', tools !== undefined)
  const watchDef = tools?.get('ci_watch')
  const diagnoseDef = tools?.get('ci_diagnose')
  check('ci_watch registered', watchDef !== undefined)
  check('ci_diagnose registered', diagnoseDef !== undefined)
  check('jobs service is present', ctx.get('jobs') !== undefined)
  check('shell service is present', ctx.get('shell') !== undefined)
  check('storageDomain service is present', ctx.get('storageDomain') !== undefined)

  // ── 2. real host exec shape through the pre-execute waterfall ────────────
  const exec = {
    callId: 'verify-diagnose-1',
    name: 'ci_diagnose',
    arguments: { repo: REPO },
    signal: AbortSignal.timeout(120_000),
  }
  const preDecision = await ctx.waterfall('tools/pre-execute', exec, async () => ({
    kind: 'allow',
  }))
  check(
    'tools/pre-execute accepts { name, arguments } exec shape',
    preDecision?.kind === 'allow',
    JSON.stringify(preDecision),
  )

  // ── 3. real ci_diagnose via host shell + gh CLI (read-only) ──────────────
  const diagArgs = { repo: REPO }
  const diagValue = await diagnoseDef.execute(diagArgs, { ...exec, arguments: diagArgs })
  check('ci_diagnose executed against real GitHub', diagValue?.repo === REPO)
  check('ci_diagnose result carries the read-only marker', diagValue?.repositoryWrites === false)
  console.log(
    `     conclusion: ${diagValue?.conclusion}` +
      (diagValue?.runId ? ` run #${diagValue.runId}` : '') +
      `, jobs diagnosed: ${diagValue?.jobs?.length ?? 0}`,
  )
  recordedSignatureIds = (diagValue?.jobs ?? []).flatMap(job =>
    (job?.signatures ?? []).map(signature => signature.id),
  )
  check(
    'diagnosis extracted real error signatures',
    recordedSignatureIds.length > 0,
    `run #${diagValue?.runId ?? 'none'} produced no signatures`,
  )
  // The host's post-execute payload is the registry-normalized result:
  // { isError, value, content } where content comes from output.render.
  const postDecision = await ctx.waterfall(
    'tools/post-execute',
    { name: 'ci_diagnose', arguments: diagArgs },
    {
      isError: false,
      value: diagValue,
      content: diagnoseDef.output.render(diagArgs, diagValue),
    },
    async () => ({ kind: 'accept' }),
  )
  check(
    'tools/post-execute accepts the diagnosis result',
    postDecision?.kind === 'accept',
    JSON.stringify(postDecision),
  )

  // ── 4. real ci_watch job on the host jobs registry ───────────────────────
  // The registry refuses start() while no attached job controller serves the
  // owner; in production the agent's preset composition attaches one. This
  // script has no agent session, so attach a controller at root — the same
  // public seam dsh-tool-jobs uses.
  const jobs = ctx.get('jobs')
  const detachController = jobs.attachController('ci-doctor-verify')
  try {
    const watchArgs = { repo: REPO, intervalSeconds: 5, timeoutMinutes: 1 }
    const watchValue = await watchDef.execute(watchArgs, {
      callId: 'verify-watch-1',
      name: 'ci_watch',
      arguments: watchArgs,
      signal: AbortSignal.timeout(60_000),
    })
    check('ci_watch returned a job id', typeof watchValue?.jobId === 'string', watchValue?.jobId)
    check('ci_watch result carries the read-only marker', watchValue?.repositoryWrites === false)

    let baseline = ''
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !baseline.includes('baseline')) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      baseline += jobs.read(watchValue.jobId).text
    }
    check(
      'watch job streamed its baseline line',
      baseline.includes('baseline set'),
      baseline.trim(),
    )

    check(
      'kill request accepted',
      jobs.kill(watchValue.jobId, undefined, 'verification done') === 'requested',
    )
    const settled = await jobs.wait(watchValue.jobId, 15_000)
    check(
      'watch job settled after kill',
      settled.status !== 'running' && settled.status !== 'stopping',
      settled.status,
    )
    console.log(
      `     job ${watchValue.jobId} settled as: ${settled.status} (${settled.detail ?? ''})`,
    )
  } finally {
    detachController()
  }
} finally {
  await ctx.fiber.dispose()
  clearTimeout(watchdog)
}

// ── 5. ledger durability: the unit file must hold this run's signatures ────
if (recordedSignatureIds.length > 0) {
  const fileText = existsSync(LEDGER_FILE) ? readFileSync(LEDGER_FILE, 'utf8') : ''
  check(
    'signature ledger persisted to the storage unit file',
    recordedSignatureIds.every(id => fileText.includes(id)),
    `${LEDGER_FILE} missing or incomplete`,
  )
  // Anti-vacuity: the file must have been (re)written during THIS run — a
  // stale file from an earlier run would otherwise satisfy the id check.
  const mtimeAfter = existsSync(LEDGER_FILE) ? statSync(LEDGER_FILE).mtimeMs : 0
  check(
    'ledger file was rewritten during this run (not a stale leftover)',
    mtimeAfter > ledgerMtimeBefore,
    `ledger mtime unchanged (${mtimeAfter} <= ${ledgerMtimeBefore}) — ledger likely fell back to memory`,
  )
}

console.log(
  failures === 0 ? '== all real-environment checks passed ==' : `== ${failures} check(s) FAILED ==`,
)
process.exit(failures === 0 ? 0 : 1)
