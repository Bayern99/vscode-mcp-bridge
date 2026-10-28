#!/usr/bin/env node
// Static (no VS Code launch) contract preflight for the Bridge #90 host gate.
//
// Cross-checks the producer (bridge source + built bundle + fixture extension)
// against the consumer (host runner) before any real extension host is started:
//   - the built bundle is the controlled artifact and contains the shipped logic
//   - every MCP tool the runner calls is registered by the bridge
//   - every fixture command id / action title the runner expects exists in the fixture
//   - the settings keys the runner/bridge use exist in package.json
//   - VS Code app version, SDK identity, deployed-build absence, port availability
// No process is started and no VS Code API is touched.

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

export const DEFAULTS = {
  bridgeDir: REPO_ROOT,
  fixtureDir: path.join(REPO_ROOT, 'test', 'host-gate', 'fixture'),
  runnerPath: path.join(REPO_ROOT, 'test', 'host-gate', 'host', 'index.js'),
  appPath: '/Applications/Visual Studio Code.app',
  expectedVscodeVersion: '1.143.1',
  expectedSourceSha: '1827501466c9c81e408e04a2a6a9f0698ec535c1',
  deployedDir: path.join(process.env.HOME || '', '.vscode', 'extensions', 'jhamama.vscode-mcp-bridge-ext-0.2.5'),
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort()
}

function extractAll(source, regex) {
  const out = []
  let match
  while ((match = regex.exec(source)) !== null) out.push(match[1])
  return out
}

function git(bridgeDir, args) {
  return execFileSync('git', args, { cwd: bridgeDir, encoding: 'utf8' }).trim()
}

export async function runPreflight(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const expectedBundleSha = options.expectedBundleSha
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'static-preflight (no VS Code launch)',
    bridgeDir: opts.bridgeDir,
    fixtureDir: opts.fixtureDir,
    runnerPath: opts.runnerPath,
    checks: [],
  }
  const check = (name, ok, observed) => {
    const entry = { name, ok: !!ok, observed: observed === undefined ? null : observed }
    report.checks.push(entry)
    return !!ok
  }

  // ---- repository / source identity ----
  const packageJsonPath = path.join(opts.bridgeDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  let head = null
  let branch = null
  let sourceDirty = null
  try {
    head = git(opts.bridgeDir, ['rev-parse', 'HEAD'])
    branch = git(opts.bridgeDir, ['branch', '--show-current'])
    sourceDirty = git(opts.bridgeDir, ['status', '--porcelain', '--', 'src', 'package.json', 'esbuild.config.js', 'tsconfig.json'])
  } catch (err) {
    report.gitError = String(err.message || err)
  }
  report.source = {
    head,
    branch,
    expectedHeadSha: opts.expectedSourceSha,
    headMatchesExpected: head === opts.expectedSourceSha,
    trackedSourcesClean: sourceDirty === '',
    trackedSourcesDirtyOutput: sourceDirty,
    bridgeExtensionId: `${packageJson.publisher}.${packageJson.name}`,
    bridgeVersion: packageJson.version,
    bridgeMain: packageJson.main,
  }
  check('git HEAD is the controlled source commit', head === opts.expectedSourceSha, { expected: opts.expectedSourceSha, actual: head })
  check('bridge tracked sources/config are unmodified (bundle input is the reviewed tree)', sourceDirty === '', sourceDirty)

  // ---- built bundle identity ----
  const bundlePath = path.join(opts.bridgeDir, 'out', 'extension.js')
  const bundleExists = fs.existsSync(bundlePath)
  const bundleSha = bundleExists ? sha256File(bundlePath) : null
  const bundleStat = bundleExists ? fs.statSync(bundlePath) : null
  const srcStat = fs.statSync(path.join(opts.bridgeDir, 'src', 'tools', 'index.ts'))
  report.bundle = {
    path: bundlePath,
    exists: bundleExists,
    size: bundleStat ? bundleStat.size : null,
    sha256: bundleSha,
    expectedSha256: expectedBundleSha || null,
    matchesExpected: !expectedBundleSha ? null : bundleSha === expectedBundleSha,
    newerThanToolSource: bundleStat && srcStat ? bundleStat.mtimeMs >= srcStat.mtimeMs : null,
  }
  check('controlled bundle exists', bundleExists != false, bundlePath)
  if (expectedBundleSha) check('controlled bundle sha256 matches the declared build hash', bundleSha === expectedBundleSha, { expected: expectedBundleSha, actual: bundleSha })
  check('bundle is newer than the tool source it was built from', report.bundle.newerThanToolSource === true, report.bundle.newerThanToolSource)

  const bundleSource = bundleExists ? fs.readFileSync(bundlePath, 'utf8') : ''
  const bridgeSource = fs.readFileSync(path.join(opts.bridgeDir, 'src', 'bridge', 'VsCodeBridge.ts'), 'utf8')
  const bridgeDenyMessage = (bridgeSource.match(/Command '\$\{command\}' is not in the allowed commands list/) || [null])[0]
  const denyLiteral = 'is not in the allowed commands list'
  report.bundleMarkers = {
    denyMessageLiteralInSource: !!bridgeDenyMessage,
    denyMessageInBundle: bundleSource.includes(denyLiteral),
    sseEndpointInBundle: bundleSource.includes("'/sse'") || bundleSource.includes('"/sse"') || bundleSource.includes('/sse'),
    messagesEndpointInBundle: bundleSource.includes('/messages'),
    healthEndpointInBundle: bundleSource.includes('/health'),
    codeActionProviderCommandInBundle: bundleSource.includes('vscode.executeCodeActionProvider'),
  }
  check('bundle contains the authorization denial message', report.bundleMarkers.denyMessageInBundle, report.bundleMarkers)
  check('bundle contains the real SSE transport endpoints', report.bundleMarkers.sseEndpointInBundle && report.bundleMarkers.messagesEndpointInBundle && report.bundleMarkers.healthEndpointInBundle, report.bundleMarkers)
  check('bundle routes code actions through vscode.executeCodeActionProvider', report.bundleMarkers.codeActionProviderCommandInBundle, report.bundleMarkers)

  // ---- tool producer/consumer contract ----
  const toolsSource = fs.readFileSync(path.join(opts.bridgeDir, 'src', 'tools', 'index.ts'), 'utf8')
  const registeredTools = uniqueSorted(extractAll(toolsSource, /server\.tool\(\s*'([A-Za-z0-9_]+)'/g))
  const runnerSource = fs.readFileSync(opts.runnerPath, 'utf8')
  const runnerTools = uniqueSorted([
    ...extractAll(runnerSource, /callTool\(client, '([A-Za-z0-9_]+)'/g),
    ...extractAll(runnerSource, /REQUIRED_TOOLS = \[([\s\S]*?)\]/g).flatMap((block) => extractAll(block, /'([A-Za-z0-9_]+)'/g)),
  ])
  const missingTools = runnerTools.filter((name) => !registeredTools.includes(name))
  const missingFromBundle = runnerTools.filter((name) => !bundleSource.includes(`"${name}"`) && !bundleSource.includes(`'${name}'`))
  report.toolContract = { registeredTools, runnerTools, missingTools, missingFromBundle }
  check('bridge source registers every tool the runner calls', missingTools.length === 0, report.toolContract)
  check('built bundle contains every tool name the runner calls', missingFromBundle.length === 0, report.toolContract)

  // ---- fixture producer/consumer contract ----
  const fixturePackagePath = path.join(opts.fixtureDir, 'package.json')
  const fixturePackage = JSON.parse(fs.readFileSync(fixturePackagePath, 'utf8'))
  const fixtureEntry = path.join(opts.fixtureDir, fixturePackage.main || 'extension.js')
  const fixtureSource = fs.readFileSync(fixtureEntry, 'utf8')
  const fixtureIds = uniqueSorted(extractAll(fixtureSource, /(scAgentIdeFixture90\.[A-Za-z0-9_]+)/g))
  const runnerIds = uniqueSorted(extractAll(runnerSource, /(scAgentIdeFixture90\.[A-Za-z0-9_]+)/g))
  const fixtureTitles = uniqueSorted(extractAll(fixtureSource, /'(case(?:04|05|06a|06b|07|09|10)[a-z0-9-]+)'/g))
  const runnerTitles = uniqueSorted(extractAll(runnerSource, /findActionIndex\([^,]+,\s*'([^']+)'\)/g))
  const fixtureId = `${fixturePackage.publisher}.${fixturePackage.name}`
  const runnerFixtureId = (runnerSource.match(/FIXTURE_EXTENSION_ID = '([^']+)'/) || [null, null])[1]
  report.fixture = {
    directory: opts.fixtureDir,
    id: fixtureId,
    version: fixturePackage.version,
    main: fixturePackage.main,
    entryPath: fixtureEntry,
    entrySha256: sha256File(fixtureEntry),
    packageSha256: sha256File(fixturePackagePath),
    engines: fixturePackage.engines,
    activationEvents: fixturePackage.activationEvents,
    ids: fixtureIds,
    actionTitles: fixtureTitles,
  }
  report.fixtureContract = {
    idsMatchRunner: JSON.stringify(fixtureIds) === JSON.stringify(runnerIds),
    fixtureIds,
    runnerIds,
    titlesMatchRunner: JSON.stringify(fixtureTitles) === JSON.stringify(runnerTitles),
    fixtureTitles,
    runnerTitles,
    idMatchesRunnerConstant: fixtureId === runnerFixtureId,
    runnerFixtureId,
  }
  check('fixture activation entry exists', fs.existsSync(fixtureEntry), fixtureEntry)
  check('fixture package declares an activation event and engine compatibility', Array.isArray(fixturePackage.activationEvents) && !!fixturePackage.engines?.vscode, {
    activationEvents: fixturePackage.activationEvents,
    engines: fixturePackage.engines,
  })
  check('fixture extension id matches the runner expectation', report.fixtureContract.idMatchesRunnerConstant, report.fixtureContract)
  check('fixture command ids match the runner consumer list', report.fixtureContract.idsMatchRunner, report.fixtureContract)
  check('fixture CodeAction titles match the runner expectations', report.fixtureContract.titlesMatchRunner, report.fixtureContract)
  check(
    'runner target basename matches the fixture provider basename',
    fixtureSource.includes('bridge90-target.txt') && runnerSource.includes("TARGET_BASENAME = 'bridge90-target.txt'"),
    'bridge90-target.txt'
  )

  // ---- settings key contract ----
  const configProps = packageJson.contributes?.configuration?.properties || {}
  const settingsKeysUsed = ['port', 'authToken', 'allowedCommands', 'enableContextPush']
  const missingSettings = settingsKeysUsed.filter((key) => !configProps[`mcpServer.${key}`])
  report.settingsContract = { keys: settingsKeysUsed, missing: missingSettings, defaults: Object.fromEntries(settingsKeysUsed.map((key) => [key, configProps[`mcpServer.${key}`]?.default])) }
  check('every mcpServer setting used by runner/bridge is contributed with a default', missingSettings.length === 0, report.settingsContract)

  // ---- VS Code app identity ----
  const appExeCandidates = [
    path.join(opts.appPath, 'Contents', 'MacOS', 'Electron'),
    path.join(opts.appPath, 'Contents', 'MacOS', 'Code'),
  ]
  const appExe = appExeCandidates.find((candidate) => fs.existsSync(candidate)) || appExeCandidates[0]
  const cli = path.join(opts.appPath, 'Contents', 'Resources', 'app', 'bin', 'code')
  const appRoot = path.join(opts.appPath, 'Contents', 'Resources', 'app')
  let version = null
  let commit = null
  try {
    version = execFileSync(cli, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim()
    commit = execFileSync(cli, ['--version'], { encoding: 'utf8' }).split('\n')[1].trim()
  } catch (err) {
    report.appError = String(err.message || err)
  }
  report.app = { appPath: opts.appPath, executable: appExe, cli, appRoot, cliVersion: version, cliCommit: commit, expectedVersion: opts.expectedVscodeVersion }
  check('real VS Code executable exists', fs.existsSync(appExe), appExe)
  check('installed VS Code CLI matches the expected package version', version === opts.expectedVscodeVersion, { expected: opts.expectedVscodeVersion, actual: version })

  // ---- SDK identity ----
  const sdkPackagePath = path.join(opts.bridgeDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')
  const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, 'utf8'))
  const requireFromBridge = createRequire(path.join(opts.bridgeDir, 'package.json'))
  let clientResolved = null
  let sseResolved = null
  try {
    clientResolved = requireFromBridge.resolve('@modelcontextprotocol/sdk/client/index.js')
    sseResolved = requireFromBridge.resolve('@modelcontextprotocol/sdk/client/sse.js')
  } catch (err) {
    report.sdkError = String(err.message || err)
  }
  const zodVersion = JSON.parse(fs.readFileSync(path.join(opts.bridgeDir, 'node_modules', 'zod', 'package.json'), 'utf8')).version
  report.sdk = { version: sdkPackage.version, sdkPackagePath, clientResolved, sseResolved, zodVersion }
  check('real MCP SDK client transport resolves for the host runner', !!clientResolved && !!sseResolved, report.sdk)

  // ---- deployed build must be absent/not-loaded ----
  const deployedEntry = path.join(opts.deployedDir, 'out', 'extension.js')
  report.deployed = {
    directory: opts.deployedDir,
    present: fs.existsSync(opts.deployedDir),
    entryPresent: fs.existsSync(deployedEntry),
    sha256: fs.existsSync(deployedEntry) ? sha256File(deployedEntry) : null,
    differsFromControlled: fs.existsSync(deployedEntry) && bundleSha ? sha256File(deployedEntry) !== bundleSha : null,
  }
  check('controlled bundle is not the deployed 0.2.5 artifact', report.deployed.differsFromControlled !== false, report.deployed)

  // ---- no SuperCollider involvement ----
  const harnessFiles = [opts.runnerPath, fixtureEntry, path.join(opts.fixtureDir, 'package.json')]
  const scReferences = []
  for (const file of harnessFiles) {
    const text = fs.readFileSync(file, 'utf8')
    for (const token of ['sclang', 'scsynth', 'supernova', 'SuperCollider']) {
      if (text.includes(token)) scReferences.push({ file, token })
    }
  }
  let preexistingSc = []
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    preexistingSc = ps
      .split('\n')
      .filter((line) => /\b(sclang|scsynth|supernova)\b/.test(line))
      .map((line) => line.trim())
  } catch {
    preexistingSc = []
  }
  report.superCollider = {
    harnessReferences: scReferences,
    preexistingProcessesObserved: preexistingSc.length,
    preexistingProcessesRedacted: preexistingSc.map((line) => line.replace(/\s+\/.*$/, ' <redacted-args>')),
  }
  check('host harness/fixture contain no SuperCollider spawn or reference', scReferences.length === 0, scReferences)

  // ---- port availability probe (no VS Code) ----
  const portProbe = await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve({ ok: false, error: String(err.code || err) }))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve({ ok: true, port, notReservedBridgePort: port !== 3333 }))
    })
  })
  report.portProbe = portProbe
  check('loopback ephemeral port is bindable for the gate', portProbe.ok === true, portProbe)

  report.pass = report.checks.every((entry) => entry.ok)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expectedBundleSha = process.argv[2]
  const report = await runPreflight({ expectedBundleSha })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}
