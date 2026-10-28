#!/usr/bin/env node
// Bridge #90 real-VS-Code-Host gate launcher.
//
// Runs the static preflight, then starts EXACTLY ONE real VS Code extension host
// (extension-development + extension-test mode) with the controlled bridge build
// and the harmless fixture extension, and finally writes a redacted evidence
// bundle plus cleanup proof.
//
// Usage: node test/host-gate/runner/launch.mjs [--expect-bundle-sha <sha>] [--timeout-sec 300]

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runPreflight, DEFAULTS } from './preflight.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const EVIDENCE_OUT = path.join(REPO_ROOT, 'test', 'host-gate', 'evidence')

const TARGET_BASENAME = 'bridge90-target.txt'
const EXPECTED_LINES = [
  'case01-direct-empty-list',
  'case02-direct-allowlisted',
  'case03-direct-nonmember',
  'case04-object-command-empty-list',
  'case05-bare-command-empty-list',
  'case06a-object-carrier-member',
  'case06b-object-carrier-nonmember',
  'case07-combined-denied-before-edit',
  'case09-combined-allowed-edit-precedence',
  'case10-edit-only-empty-list',
]

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(1500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function processGroupMembers(pgid) {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim())
      .filter((line) => {
        const parts = line.split(/\s+/)
        return parts[2] === String(pgid)
      })
  } catch {
    return []
  }
}

function redact(value, rules) {
  if (typeof value === 'string') {
    let out = value
    for (const [needle, replacement] of rules) {
      if (!needle) continue
      out = out.split(needle).join(replacement)
    }
    out = out.replace(/\/private\/var\/folders\/[^\s"',\]}]*/g, '<TMP_PATH>')
    out = out.replace(/\/var\/folders\/[^\s"',\]}]*/g, '<TMP_PATH>')
    out = out.replace(/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"',\]}]*)?/g, '<USER_PATH>')
    return out
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, rules))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redact(item, rules)
    return out
  }
  return value
}

async function main() {
  const timeoutSec = Number(argValue('--timeout-sec', '300'))
  const preflight = await runPreflight({ expectedBundleSha: argValue('--expect-bundle-sha') })
  if (!preflight.pass) {
    const failed = preflight.checks.filter((entry) => !entry.ok).map((entry) => entry.name)
    console.error('STATIC PREFLIGHT FAILED:', failed)
    process.exitCode = 2
    return
  }
  const bundleSha = preflight.bundle.sha256
  const bridgeDir = fs.realpathSync(preflight.bridgeDir)
  const fixtureDir = fs.realpathSync(preflight.fixtureDir)
  const runnerPath = path.resolve(preflight.runnerPath)
  const appPath = preflight.app.appPath
  const appRoot = preflight.app.appRoot
  const appExe = preflight.app.executable
  const fixtureEntry = preflight.fixture.entryPath

  const port = await getFreePort()
  if (port === 3333) throw new Error('ephemeral port collided with the reserved 3333')

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-agent-ide-bridge90-'))
  const workspaceDir = path.join(tmpRoot, 'workspace')
  const userDataDir = path.join(tmpRoot, 'user-data')
  const extensionsDir = path.join(tmpRoot, 'extensions')
  const evidenceDir = path.join(tmpRoot, 'evidence')
  const logsDir = path.join(tmpRoot, 'logs')
  for (const dir of [workspaceDir, userDataDir, extensionsDir, evidenceDir, logsDir, path.join(workspaceDir, '.vscode')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const token = crypto.randomBytes(24).toString('hex')
  const targetFile = path.join(workspaceDir, TARGET_BASENAME)
  fs.writeFileSync(targetFile, EXPECTED_LINES.join('\n') + '\n', 'utf8')

  const workspaceSettings = {
    'mcpServer.port': port,
    'mcpServer.authToken': token,
    'mcpServer.allowedCommands': [],
    'mcpServer.enableContextPush': false,
    'files.autoSave': 'off',
    'files.hotExit': 'off',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'window.restoreWindows': 'none',
  }
  fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), JSON.stringify(workspaceSettings, null, 2), 'utf8')

  const fixtureSha = sha256File(fixtureEntry)
  const sdkVersion = preflight.sdk.version
  const deployedDir = preflight.deployed.directory

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
  }
  Object.assign(env, {
    BRIDGE90_EVIDENCE_DIR: evidenceDir,
    BRIDGE90_PORT: String(port),
    BRIDGE90_EXPECT_BUNDLE_SHA: bundleSha,
    BRIDGE90_EXPECT_FIXTURE_SHA: fixtureSha,
    BRIDGE90_BRIDGE_DIR: bridgeDir,
    BRIDGE90_FIXTURE_DIR: fixtureDir,
    BRIDGE90_APP_ROOT: appRoot,
    BRIDGE90_DEPLOYED_DIR: deployedDir,
    BRIDGE90_SDK_VERSION: sdkVersion,
  })

  const flags = [
    ['user-data-dir', userDataDir],
    ['extensions-dir', extensionsDir],
    ['extensionDevelopmentPath', bridgeDir],
    ['extensionDevelopmentPath', fixtureDir],
    ['extensionTestsPath', runnerPath],
    ['disable-workspace-trust', null],
    ['disable-updates', null],
    ['disable-crash-reporter', null],
    ['disable-telemetry', null],
    ['skip-welcome', null],
    ['skip-release-notes', null],
    ['disable-gpu', null],
    ['preserve-env', null],
    ['new-window', null],
  ]
  env.BRIDGE90_LAUNCH_FLAGS = JSON.stringify([
    'user-data-dir',
    'extensions-dir',
    'extensionDevelopmentPath',
    'extensionDevelopmentPath',
    'extensionTestsPath',
    'disable-workspace-trust',
    'disable-updates',
    'disable-crash-reporter',
    'disable-telemetry',
    'skip-welcome',
    'skip-release-notes',
    'disable-gpu',
    'preserve-env',
    'new-window',
  ])
  const args = flags.map(([name, value]) => (value === null ? `--${name}` : `--${name}=${value}`))
  const displayArgs = flags.map(([name, value]) => {
    if (value === null) return `--${name}`
    if (name === 'user-data-dir') return `--${name}=<TMP_ROOT>/user-data`
    if (name === 'extensions-dir') return `--${name}=<TMP_ROOT>/extensions`
    if (name === 'extensionDevelopmentPath' && value === bridgeDir) return `--${name}=<BRIDGE_DIR>`
    if (name === 'extensionDevelopmentPath') return `--${name}=<FIXTURE_DIR>`
    if (name === 'extensionTestsPath') return `--${name}=<REPO>/test/host-gate/host/index.js`
    return `--${name}=<TMP_ROOT>/workspace`
  })
  displayArgs.push('<TMP_ROOT>/workspace')

  const launchIdentity = {
    generatedAt: new Date().toISOString(),
    purpose: 'bridge #90 command-authorization real VS Code host gate (one launch)',
    source: {
      repoHead: preflight.source.head,
      branch: preflight.source.branch,
      expectedHead: preflight.source.expectedHeadSha,
      trackedSourcesClean: preflight.source.trackedSourcesClean,
    },
    controlledBundle: { path: '<BRIDGE_DIR>/out/extension.js', sha256: bundleSha, size: preflight.bundle.size, buildCommand: 'node esbuild.config.js --production', typecheckCommand: 'npx tsc --noEmit' },
    fixture: { id: preflight.fixture.id, version: preflight.fixture.version, entrySha256: fixtureSha },
    deployedBuild: preflight.deployed,
    vscode: preflight.app,
    sdk: preflight.sdk,
    port,
    tokenLength: token.length,
    tokenRecorded: false,
    cliArgsNamesOnly: displayArgs,
    envNamesPassed: Object.keys(env).filter((key) => key.startsWith('BRIDGE90_')),
    modeProvenance: {
      host: 'real VS Code extension development host launched from the installed app executable',
      bridge: 'loaded via --extensionDevelopmentPath (development extension; extensionMode not directly observable)',
      fixture: 'loaded via --extensionDevelopmentPath; reports its own ExtensionContext.extensionMode',
      notProduction: true,
    },
  }
  fs.writeFileSync(path.join(evidenceDir, 'launch-identity.json'), JSON.stringify(launchIdentity, null, 2), 'utf8')

  const stdoutPath = path.join(logsDir, 'host-stdout.log')
  const stderrPath = path.join(logsDir, 'host-stderr.log')
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' })
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' })

  console.log(`[bridge90] launching real VS Code host (pid pending) port=${port} bundle=${bundleSha.slice(0, 12)}`)
  const startedAt = Date.now()
  const child = spawn(appExe, [...args, workspaceDir], {
    cwd: workspaceDir,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  child.stdout.pipe(stdoutStream)
  child.stderr.pipe(stderrStream)

  let exitInfo = null
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal, at: new Date().toISOString(), durationMs: Date.now() - startedAt }
      resolve(exitInfo)
    })
    child.once('error', (err) => {
      exitInfo = { error: String(err && err.message), at: new Date().toISOString() }
      resolve(exitInfo)
    })
  })

  const evidenceFile = path.join(evidenceDir, 'host-evidence.json')
  const deadline = Date.now() + timeoutSec * 1000
  let observedMembers = []
  let sampled = false
  while (!exitInfo && Date.now() < deadline) {
    await delay(500)
    if (!sampled) {
      observedMembers = processGroupMembers(pid)
      sampled = true
    }
    if (fs.existsSync(evidenceFile)) {
      await delay(1500)
      if (!exitInfo) break
    }
  }

  if (!exitInfo) {
    // Evidence exists (run finished) or the budget expired; stop only our own group.
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    const killDeadline = Date.now() + 8000
    while (!exitInfo && Date.now() < killDeadline) await delay(250)
    if (!exitInfo) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      await Promise.race([exited, delay(5000)])
    }
  }
  await Promise.race([exited, delay(5000)])
  stdoutStream.end()
  stderrStream.end()
  await delay(300)
  const finalExit = exitInfo || { code: null, signal: 'still-running' }

  const initialGroupMembers = observedMembers
  const scInGroup = initialGroupMembers.filter((line) => /\b(sclang|scsynth|supernova)\b/i.test(line))
  const remainingMembers = processGroupMembers(pid)
  const groupAlive = processGroupAlive(pid)
  const portStillOpen = await portOpen(port)

  let hostEvidence = null
  let hostEvidenceReadError = null
  try {
    hostEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  } catch (err) {
    hostEvidenceReadError = String((err && err.message) || err)
  }
  const rawProgress = fs.existsSync(path.join(evidenceDir, 'progress.jsonl'))
    ? fs
        .readFileSync(path.join(evidenceDir, 'progress.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
    : []
  const logTail = (file) => {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-25)
  }

  const cases = (hostEvidence && hostEvidence.cases) || []
  const failedCases = cases.filter((record) => !record.pass).map((record) => record.id)
  const harnessErrors = (hostEvidence && hostEvidence.errors) || []
  const hostCleanup = (hostEvidence && hostEvidence.cleanup) || {}
  const cleanupOk =
    hostCleanup.serverStopped === true &&
    hostCleanup.noDirtyTargetDocument === true &&
    hostCleanup.diskAfterRevertEqualsBaseline === true
  const verdict =
    hostEvidence && hostEvidence.caseCount === 10 && failedCases.length === 0 && harnessErrors.length === 0 && cleanupOk ? 'PASS' : 'FAIL'

  const rules = [
    [token, '<REDACTED_TOKEN>'],
    [tmpRoot, '<TMP_ROOT>'],
    [fs.realpathSync(tmpRoot), '<TMP_ROOT>'],
    [bridgeDir, '<BRIDGE_DIR>'],
    [fixtureDir, '<FIXTURE_DIR>'],
    [appRoot, '<VSCODE_APP>/Contents/Resources/app'],
    [appPath, '<VSCODE_APP>'],
    [deployedDir, '<DEPLOYED_DIR>'],
    [os.homedir(), '<HOME>'],
    [REPO_ROOT, '<REPO>'],
    ['/private' + tmpRoot, '<TMP_ROOT>'],
  ]

  const evidence = redact(
    {
      gate: 'bridge90-real-vscode-host',
      verdict,
      generatedAt: new Date().toISOString(),
      note:
        'Bridge source/artefact unchanged by this gate. No SuperCollider, no current Bridge (:3333) deployment, no GitHub write, no product deployment.',
      oneLaunch: {
        pid,
        pgid: pid,
        executable: '<VSCODE_APP>/Contents/MacOS/' + path.basename(appExe),
        argsNamesOnly: displayArgs,
        envNames: launchIdentity.envNamesPassed,
        exit: finalExit,
        port,
        timeoutSec,
        launchCount: 1,
      },
      processTree: {
        sampledGroupMembers: initialGroupMembers,
        sampledGroupMemberCount: initialGroupMembers.length,
        superColliderMembers: scInGroup,
        remainingGroupMembersAfterExit: remainingMembers,
        processGroupAliveAfterExit: groupAlive,
        portOpenAfterExit: portStillOpen,
      },
      preflight: {
        pass: preflight.pass,
        checks: preflight.checks,
        bundle: preflight.bundle,
        toolContract: preflight.toolContract,
        fixtureContract: preflight.fixtureContract,
        settingsContract: preflight.settingsContract,
        sdk: preflight.sdk,
        deployed: preflight.deployed,
        app: preflight.app,
        source: preflight.source,
        superCollider: preflight.superCollider,
      },
      launchIdentity,
      hostEvidence,
      hostEvidenceReadError,
      progressTail: rawProgress.slice(-60),
      hostLogTail: logTail(stderrPath),
      cleanup: {
        tmpRoot,
        tmpRootRemoved: null,
        evidenceCopiedBeforeRemoval: true,
      },
    },
    rules
  )

  fs.mkdirSync(EVIDENCE_OUT, { recursive: true })
  const outFile = path.join(EVIDENCE_OUT, 'host-gate-run.json')
  evidence.cleanup.tmpRootRemoved = true
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8')

  // Remove only the directory this run created.
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  evidence.cleanup.tmpRootRemoved = !fs.existsSync(tmpRoot)
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8')

  const summary = {
    verdict,
    launchCount: 1,
    pid,
    exitCode: finalExit.code === undefined ? null : finalExit.code,
    signal: finalExit.signal || null,
    port,
    caseCount: cases.length,
    passed: cases.filter((record) => record.pass).map((record) => record.id),
    failed: failedCases,
    harnessErrors,
    cleanupVerifiedByHost: {
      serverStopped: hostCleanup.serverStopped === true,
      documentDirtyAfterRevert: hostCleanup.documentDirtyAfterRevert,
      noDirtyTargetDocument: hostCleanup.noDirtyTargetDocument,
      documentTextRestored: hostCleanup.documentTextRestored,
      reopenedDocumentTextRestored: hostCleanup.reopenedDocumentTextRestored,
      diskAfterRevertEqualsBaseline: hostCleanup.diskAfterRevertEqualsBaseline,
    },
    authControls: (hostEvidence && hostEvidence.server && hostEvidence.server.authControls) || null,
    cleanup: {
      superColliderInOwnedTree: scInGroup.length,
      processGroupAliveAfterExit: groupAlive,
      portOpenAfterExit: portStillOpen,
      tmpRemoved: !fs.existsSync(tmpRoot),
    },
    evidence: '<REPO>/test/host-gate/evidence/host-gate-run.json',
  }
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = verdict === 'PASS' && !groupAlive && !portStillOpen && scInGroup.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[bridge90] launcher failed:', err && err.stack ? err.stack : err)
  process.exit(2)
})
