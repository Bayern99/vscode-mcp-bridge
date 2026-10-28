'use strict'

// Bridge #90 real-VS-Code-Host gate runner.
//
// Loaded inside a real VS Code extension host via --extensionTestsPath.
// It drives the real bridge extension (loaded from --extensionDevelopmentPath)
// over the bridge's real authenticated loopback SSE transport with the real
// @modelcontextprotocol/sdk client. No InMemoryTransport, no mocked `vscode`.
//
// Evidence is written to BRIDGE90_EVIDENCE_DIR (ephemeral; the launcher redacts
// paths/token before anything is committed).

const vscode = require('vscode')
const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')

const TARGET_BASENAME = 'bridge90-target.txt'
const BRIDGE_EXTENSION_ID = 'jhamama.vscode-mcp-bridge-ext'
const FIXTURE_EXTENSION_ID = 'sc-agent-ide-fixture.bridge90-fixture'
const DENY_MARKER = 'is not in the allowed commands list'

// Must stay in sync with test/host-gate/fixture/extension.js. The static
// preflight (test/host-gate/runner/preflight.mjs) asserts the two lists match
// before any host is launched.
const FIXTURE_COMMANDS = {
  directAllowed: 'scAgentIdeFixture90.directAllowed',
  directDenied: 'scAgentIdeFixture90.directDenied',
  objectAllowed: 'scAgentIdeFixture90.objectAllowed',
  objectDenied: 'scAgentIdeFixture90.objectDenied',
  combinedDenied: 'scAgentIdeFixture90.combinedDenied',
  combinedAllowed: 'scAgentIdeFixture90.combinedAllowed',
  deniedBare: 'scAgentIdeFixture90.deniedBare',
}

const PHASE2_ALLOWLIST = [
  FIXTURE_COMMANDS.directAllowed,
  FIXTURE_COMMANDS.objectAllowed,
  FIXTURE_COMMANDS.combinedAllowed,
]

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

const EDITED_LINES = {
  7: 'EDITED:case07-combined-denied-before-edit',
  8: 'EDITED:case09-combined-allowed-edit-precedence',
  9: 'EDITED:case10-edit-only',
}

const REQUIRED_TOOLS = ['get_code_actions', 'apply_code_action', 'execute_vscode_command']

let EVIDENCE_DIR = ''
let FINISHED = false
let STATE = null
let TIMER = null

function progress(message) {
  try {
    if (!EVIDENCE_DIR) return
    fs.appendFileSync(
      path.join(EVIDENCE_DIR, 'progress.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, message }) + '\n',
      'utf8'
    )
  } catch {
    /* best effort */
  }
}

function clip(value, max = 600) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return null
  return text.length > max ? text.slice(0, max) + `...(${text.length} chars)` : text
}

function check(record, assertion, ok, observed) {
  const entry = { assertion, ok: !!ok, observed: observed === undefined ? null : clip(observed) }
  record.checks.push(entry)
  if (!ok) progress(`check-failed ${record.id || 'preflight'}: ${assertion} :: ${entry.observed}`)
  return !!ok
}

function requireChecks(record, what) {
  const failed = record.checks.filter((entry) => !entry.ok)
  if (failed.length > 0) {
    throw new Error(`${what} failed: ${failed.map((entry) => entry.assertion).join('; ')}`)
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function httpRequest(options) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const requestOptions = { host: '127.0.0.1', method: 'GET', ...options }
    const readBody = !!options.readBody
    delete requestOptions.readBody
    const req = http.request(requestOptions, (res) => {
      if (!readBody) {
        done({ ok: true, status: res.statusCode, headers: res.headers, body: '' })
        res.destroy()
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => done({ ok: true, status: res.statusCode, headers: res.headers, body: data }))
      res.on('error', (err) => done({ ok: false, error: String((err && err.code) || err) }))
    })
    req.setTimeout(4000, () => {
      req.destroy(new Error('socket timeout'))
    })
    req.on('error', (err) => done({ ok: false, error: String((err && err.code) || err) }))
    req.end()
  })
}

async function health(port) {
  return await httpRequest({ port, path: '/health', method: 'GET', readBody: true })
}

async function sseStatus(port, headers) {
  return await httpRequest({ port, path: '/sse', method: 'GET', headers: { Accept: 'text/event-stream', ...headers } })
}

function parseHealthBody(value) {
  try {
    return JSON.parse(value.body)
  } catch {
    return null
  }
}

async function waitForHealthUp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await health(port)
    last = res
    if (res.ok && res.status === 200) {
      const parsed = parseHealthBody(res)
      if (parsed && parsed.status === 'ok') return { up: true, body: parsed }
    }
    await delay(300)
  }
  return { up: false, last: last ? { status: last.status, error: last.error } : null }
}

async function waitForHealthStable(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  let last = null
  while (Date.now() < deadline) {
    const res = await health(port)
    last = res
    if (res.ok && res.status === 200) {
      const parsed = parseHealthBody(res)
      if (parsed && parsed.status === 'ok') {
        streak += 1
        if (streak >= 2) return { stable: true, body: parsed }
      } else {
        streak = 0
      }
    } else {
      streak = 0
    }
    await delay(500)
  }
  return { stable: false, last: last ? { status: last.status, error: last.error } : null }
}

async function waitForHealthDown(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await health(port)
    last = res
    if (!res.ok) return { down: true, last: { error: last.error } }
    await delay(250)
  }
  return { down: false, last: last ? { status: last.status } : null }
}

async function waitForNoAgents(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await health(port)
    if (res.ok && res.status === 200) {
      const parsed = parseHealthBody(res)
      if (parsed && parsed.connectedAgents === 0) return { released: true, body: parsed }
    }
    await delay(200)
  }
  return { released: false }
}

function readCounter(commandId) {
  const file = path.join(EVIDENCE_DIR, 'counters', commandId + '.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { unparsed: line }
      }
    })
}

function readFixtureContext() {
  const file = path.join(EVIDENCE_DIR, 'fixture-context.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function resultText(result) {
  const content = (result && result.content) || []
  return content
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function parseJsonText(result) {
  try {
    return JSON.parse(resultText(result))
  } catch {
    return null
  }
}

async function connectClient(port, token) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')
  const url = new URL(`http://127.0.0.1:${port}/sse`)
  const transport = new SSEClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'sc-agent-ide-bridge90-host-gate', version: '0.0.1' })
  await withTimeout(client.connect(transport), 20000, 'mcp client connect')
  return client
}

async function callTool(client, name, args) {
  return await withTimeout(client.callTool({ name, arguments: args }), 20000, `tools/call ${name}`)
}

async function runCase(state, id, name, inputs, body) {
  const record = {
    id,
    name,
    inputs,
    startedAt: new Date().toISOString(),
    checks: [],
    pass: false,
  }
  state.cases.push(record)
  progress(`case-start ${id} ${name}`)
  try {
    await body(record)
  } catch (err) {
    check(record, 'case ran without an unexpected exception', false, String((err && err.stack) || err))
  }
  record.pass = record.checks.length > 0 && record.checks.every((entry) => entry.ok)
  record.finishedAt = new Date().toISOString()
  progress(`case-end ${id} pass=${record.pass}`)
  return record
}

function assertDenied(record, result, commandId) {
  const text = resultText(result)
  check(record, `MCP tool error surfaced for ${commandId}`, result && result.isError === true, {
    isError: result && result.isError,
    text: clip(text),
  })
  check(
    record,
    `denial is the allowlist rejection, not an unknown tool/command: ${commandId}`,
    typeof text === 'string' && text.includes(DENY_MARKER) && text.includes(commandId),
    clip(text)
  )
}

function assertApplied(record, result) {
  const payload = parseJsonText(result)
  check(record, 'apply_code_action reported applied:true', payload && payload.applied === true, payload)
  check(record, 'apply_code_action did not surface an MCP tool error', !(result && result.isError === true), result && result.isError)
}

function findActionIndex(parsed, expectedTitlePrefix) {
  if (!Array.isArray(parsed)) return { index: -1, matches: [], titles: parsed, count: 0 }
  const matches = []
  parsed.forEach((item, index) => {
    if (item && typeof item.title === 'string' && item.title.startsWith(expectedTitlePrefix)) matches.push(index)
  })
  return {
    index: matches.length === 1 ? matches[0] : -1,
    matches,
    titles: parsed.map((item) => (item && item.title) || null),
    count: parsed.length,
  }
}

async function main() {
  const state = STATE
  const startedAt = Date.now()
  const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0]
  if (!workspaceFolder) throw new Error('no workspace folder is open in the extension test host')
  const workspaceRoot = workspaceFolder.uri.fsPath
  const targetFile = path.join(workspaceRoot, TARGET_BASENAME)
  const targetUri = vscode.Uri.file(targetFile)

  state.host = {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web',
    extensionHostPid: process.pid,
    workspaceFolderName: path.basename(workspaceRoot),
    launchFlagsDeclaredByLauncher: process.env.BRIDGE90_LAUNCH_FLAGS || null,
  }
  progress('host-info captured')

  // ---- Identity: the loaded artifacts must be exactly the hashed ones ----
  const bridgeDir = process.env.BRIDGE90_BRIDGE_DIR
  const fixtureDir = process.env.BRIDGE90_FIXTURE_DIR
  const expectedBundleSha = process.env.BRIDGE90_EXPECT_BUNDLE_SHA
  const expectedFixtureSha = process.env.BRIDGE90_EXPECT_FIXTURE_SHA
  const appRoot = process.env.BRIDGE90_APP_ROOT || ''

  const bridgeExt = vscode.extensions.getExtension(BRIDGE_EXTENSION_ID)
  if (!bridgeExt) throw new Error(`bridge extension ${BRIDGE_EXTENSION_ID} is not registered in this host`)
  await withTimeout(bridgeExt.activate(), 20000, 'activate bridge extension')
  const bundlePath = path.join(bridgeExt.extensionPath, 'out', 'extension.js')
  const bundleSha = sha256File(bundlePath)

  const fixtureExt = vscode.extensions.getExtension(FIXTURE_EXTENSION_ID)
  if (!fixtureExt) throw new Error(`fixture extension ${FIXTURE_EXTENSION_ID} is not registered in this host`)
  await withTimeout(fixtureExt.activate(), 20000, 'activate fixture extension')
  const fixtureEntry = path.join(fixtureExt.extensionPath, 'extension.js')
  const fixtureSha = sha256File(fixtureEntry)
  const fixtureContext = readFixtureContext()

  const samePath = (a, b) => a && b && fs.realpathSync(a) === fs.realpathSync(b)

  state.identity = {
    bridge: {
      id: bridgeExt.id,
      version: bridgeExt.packageJSON.version,
      extensionPath: bridgeExt.extensionPath,
      expectedExtensionPath: bridgeDir,
      pathMatchesLaunchArg: samePath(bridgeExt.extensionPath, bridgeDir),
      bundlePath,
      bundleSha256: bundleSha,
      expectedBundleSha256: expectedBundleSha,
      bundleShaMatches: bundleSha === expectedBundleSha,
      isActive: bridgeExt.isActive,
    },
    fixture: {
      id: fixtureExt.id,
      version: fixtureExt.packageJSON.version,
      extensionPath: fixtureExt.extensionPath,
      expectedExtensionPath: fixtureDir,
      pathMatchesLaunchArg: samePath(fixtureExt.extensionPath, fixtureDir),
      entryPath: fixtureEntry,
      entrySha256: fixtureSha,
      expectedEntrySha256: expectedFixtureSha,
      entryShaMatches: fixtureSha === expectedFixtureSha,
      isActive: fixtureExt.isActive,
      contextModeObserved: fixtureContext && fixtureContext.extensionMode,
      contextModeName: fixtureContext && fixtureContext.extensionModeName,
      contextVscodeVersion: fixtureContext && fixtureContext.vscodeVersion,
    },
    targetModeAttribution: {
      bridge:
        'not directly observable: Extension has no extensionMode property and the extension host exposes ExtensionContext.extensionMode only to the extension itself; provenance = loaded from --extensionDevelopmentPath into an extension-test host (see host.launchFlagsDeclaredByLauncher)',
      fixture: 'observed from the fixture ExtensionContext (fixture.contextModeObserved/contextModeName)',
    },
    sdkClientVersion: process.env.BRIDGE90_SDK_VERSION || null,
  }

  const loaded = vscode.extensions.all.map((ext) => ({
    id: ext.id,
    version: ext.packageJSON.version,
    extensionPath: ext.extensionPath,
  }))
  const builtinCount = appRoot ? loaded.filter((ext) => ext.extensionPath.startsWith(appRoot)).length : null
  const nonBuiltin = appRoot ? loaded.filter((ext) => !ext.extensionPath.startsWith(appRoot)) : loaded
  const deployedDir = process.env.BRIDGE90_DEPLOYED_DIR || ''
  state.extensionsLoaded = {
    total: loaded.length,
    builtinCount,
    nonBuiltin,
    deployedExtensionLoaded: deployedDir
      ? loaded.some((ext) => ext.extensionPath === deployedDir)
      : null,
    deployedDirDeclared: deployedDir || null,
  }

  const preflight = { id: 'preflight', checks: [] }
  check(preflight, 'bridge bundle sha256 equals the pre-launch controlled build hash', bundleSha === expectedBundleSha, {
    expected: expectedBundleSha,
    actual: bundleSha,
  })
  check(preflight, 'bridge extension path is the controlled worktree, not the deployed build', state.identity.bridge.pathMatchesLaunchArg, {
    expected: bridgeDir,
    actual: bridgeExt.extensionPath,
  })
  check(preflight, 'fixture entry sha256 equals the committed fixture hash', fixtureSha === expectedFixtureSha, {
    expected: expectedFixtureSha,
    actual: fixtureSha,
  })
  check(preflight, 'fixture extension path is the committed fixture directory', state.identity.fixture.pathMatchesLaunchArg, {
    expected: fixtureDir,
    actual: fixtureExt.extensionPath,
  })
  check(preflight, 'exactly the two development extensions are loaded (no installed extras)', nonBuiltin.length === 2, nonBuiltin)
  check(preflight, 'deployed 0.2.5 bridge extension is not loaded', state.extensionsLoaded.deployedExtensionLoaded === false, state.extensionsLoaded.deployedExtensionLoaded)
  check(preflight, 'fixture reports a real ExtensionContext mode', fixtureContext && typeof fixtureContext.extensionMode === 'number', fixtureContext)
  state.preflight = preflight
  progress('identity/preflight checks complete')
  requireChecks(preflight, 'identity preflight')

  // ---- Settings, read through the same API the bridge uses ----
  const configuration = vscode.workspace.getConfiguration('mcpServer')
  const port = Number(configuration.get('port'))
  const token = String(configuration.get('authToken') || '')
  const allowlistPhase1 = configuration.get('allowedCommands')

  state.server = {
    port,
    portMatchesLauncher: String(port) === String(process.env.BRIDGE90_PORT),
    tokenConfigured: token.length >= 32,
    tokenNeverRecorded: true,
    phase1AllowedCommands: allowlistPhase1,
  }
  if (!Number.isInteger(port) || port <= 0 || port === 3333) throw new Error(`invalid/unexpected mcpServer.port: ${port}`)
  if (token.length < 32) throw new Error('mcpServer.authToken is missing from the workspace settings')

  const initialHealth = await waitForHealthUp(port, 20000)
  state.server.initialHealth = initialHealth.up ? initialHealth.body : null
  if (!initialHealth.up) throw new Error(`bridge HTTP server never became reachable on 127.0.0.1:${port}`)

  // ---- Real transport auth controls (negative controls) ----
  const unauth = await sseStatus(port, {})
  const wrongToken = await sseStatus(port, { Authorization: 'Bearer deliberately-wrong-token' })
  state.server.authControls = {
    sseWithoutAuthorization: { status: unauth.status || unauth.error },
    sseWithWrongToken: { status: wrongToken.status || wrongToken.error },
  }
  const authRecord = { id: 'auth-controls', checks: [] }
  check(authRecord, 'unauthenticated SSE request is rejected with 401', unauth.status === 401, unauth.status || unauth.error)
  check(authRecord, 'wrong bearer token SSE request is rejected with 401', wrongToken.status === 401, wrongToken.status || wrongToken.error)
  state.authControlsChecks = authRecord
  requireChecks(authRecord, 'transport authentication preflight')

  // ---- Target document + baseline ----
  const doc = await withTimeout(vscode.workspace.openTextDocument(targetUri), 15000, 'open target document')
  const baselineText = doc.getText()
  const baselineDisk = fs.readFileSync(targetFile, 'utf8')
  const baselineLines = baselineText.split('\n')
  if (baselineLines.length > 0 && baselineLines[baselineLines.length - 1] === '') baselineLines.pop()
  state.target = {
    basename: TARGET_BASENAME,
    lineCount: doc.lineCount,
    languageId: doc.languageId,
    baselineLines,
    baselineDiskMatchesDocument: baselineDisk === baselineText,
    effectiveFilesAutoSave: vscode.workspace.getConfiguration('files').get('autoSave'),
    effectiveFilesHotExit: vscode.workspace.getConfiguration('files').get('hotExit'),
  }
  const targetRecord = { id: 'target-baseline', checks: [] }
  check(targetRecord, 'fixture target has the expected 10-line baseline', baselineLines.length === EXPECTED_LINES.length && baselineLines.every((line, index) => line === EXPECTED_LINES[index]), baselineLines)
  check(targetRecord, 'on-disk target equals the in-memory baseline', baselineDisk === baselineText, state.target.baselineDiskMatchesDocument)
  state.targetBaselineChecks = targetRecord
  requireChecks(targetRecord, 'target document preflight')

  const changeLog = []
  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() === targetUri.toString()) {
      changeLog.push({
        at: Date.now(),
        reason: event.reason === undefined ? 'edit' : String(event.reason),
        contentChanges: (event.contentChanges || []).length,
      })
    }
  })

  const lineText = (line) => doc.lineAt(line).text
  const markerCount = (text, marker) => text.split(marker).length - 1
  const snapshot = () => ({ version: doc.version, text: doc.getText() })

  async function applyAction(client, line, actionIndex) {
    const before = snapshot()
    const eventBase = changeLog.length
    const result = await callTool(client, 'apply_code_action', {
      filePath: targetFile,
      startLine: line,
      startChar: 0,
      endLine: line,
      endChar: 1,
      actionIndex,
    })
    await delay(120)
    return { result, before, after: snapshot(), events: changeLog.slice(eventBase), afterDirty: doc.isDirty }
  }

  async function listActions(client, line) {
    const result = await callTool(client, 'get_code_actions', {
      filePath: targetFile,
      startLine: line,
      startChar: 0,
      endLine: line,
      endChar: 1,
    })
    return { parsed: parseJsonText(result), text: resultText(result), isError: result && result.isError === true }
  }

  // ---- Phase 1: empty allowlist ----
  state.phases = []
  let client = await connectClient(port, token)
  const liveness1 = await callTool(client, 'get_workspace_info', {})
  const tools1 = await withTimeout(client.listTools(), 15000, 'tools/list phase 1')
  const toolNames1 = (tools1.tools || []).map((tool) => tool.name)
  const phase1 = {
    name: 'empty-allowlist',
    allowedCommands: Array.isArray(allowlistPhase1) ? allowlistPhase1 : null,
    toolCount: toolNames1.length,
    tools: toolNames1,
    livenessCallSucceeded: !(liveness1 && liveness1.isError === true),
    startedAt: new Date().toISOString(),
  }
  state.phases.push(phase1)
  const toolsRecord = { id: 'tools-list', checks: [] }
  check(toolsRecord, 'all required tools are advertised over the real transport', REQUIRED_TOOLS.every((name) => toolNames1.includes(name)), toolNames1)
  state.toolsListChecks = toolsRecord
  requireChecks(toolsRecord, 'tools/list preflight')
  if (!phase1.livenessCallSucceeded) throw new Error('phase 1 MCP session liveness call failed')
  progress(`phase1 connected tools=${toolNames1.length}`)

  await runCase(
    state,
    'case01',
    'empty allowlist: direct execute_vscode_command is denied',
    { tool: 'execute_vscode_command', command: FIXTURE_COMMANDS.directDenied, allowedCommands: [] },
    async (record) => {
      check(record, 'phase 1 effective allowedCommands is empty', Array.isArray(allowlistPhase1) && allowlistPhase1.length === 0, allowlistPhase1)
      const before = snapshot()
      const result = await callTool(client, 'execute_vscode_command', { command: FIXTURE_COMMANDS.directDenied, args: [] })
      await delay(100)
      const after = snapshot()
      assertDenied(record, result, FIXTURE_COMMANDS.directDenied)
      check(record, 'denied command counter is 0', readCounter(FIXTURE_COMMANDS.directDenied).length === 0, readCounter(FIXTURE_COMMANDS.directDenied).length)
      check(record, 'no document side effect', after.version === before.version, { before: before.version, after: after.version })
    }
  )

  await runCase(
    state,
    'case04',
    'empty allowlist: CodeAction.command object is denied',
    { tool: 'apply_code_action', line: 3, allowedCommands: [] },
    async (record) => {
      const listed = await listActions(client, 3)
      const found = findActionIndex(listed.parsed, 'case04-empty-object-command')
      check(record, 'positive control: fixture provider offered the case04 object-command action', found.index >= 0, found)
      const outcome = await applyAction(client, 3, found.index >= 0 ? found.index : 0)
      assertDenied(record, outcome.result, FIXTURE_COMMANDS.objectDenied)
      check(record, 'denied object command counter is 0', readCounter(FIXTURE_COMMANDS.objectDenied).length === 0, readCounter(FIXTURE_COMMANDS.objectDenied).length)
      check(record, 'rejection produced no edit', outcome.after.version === outcome.before.version && outcome.events.length === 0, {
        beforeVersion: outcome.before.version,
        afterVersion: outcome.after.version,
        changeEvents: outcome.events,
      })
      check(record, 'target line 3 is unchanged', lineText(3) === EXPECTED_LINES[3], lineText(3))
    }
  )

  await runCase(
    state,
    'case05',
    'empty allowlist: bare string CodeAction.command is denied',
    { tool: 'apply_code_action', line: 4, allowedCommands: [] },
    async (record) => {
      const listed = await listActions(client, 4)
      const found = findActionIndex(listed.parsed, 'case05-empty-bare-command')
      check(record, 'positive control: fixture provider offered the case05 bare-command action', found.index >= 0, found)
      const outcome = await applyAction(client, 4, found.index >= 0 ? found.index : 0)
      assertDenied(record, outcome.result, FIXTURE_COMMANDS.deniedBare)
      check(record, 'denied bare command counter is 0', readCounter(FIXTURE_COMMANDS.deniedBare).length === 0, readCounter(FIXTURE_COMMANDS.deniedBare).length)
      check(record, 'rejection produced no edit', outcome.after.version === outcome.before.version && outcome.events.length === 0, {
        beforeVersion: outcome.before.version,
        afterVersion: outcome.after.version,
        changeEvents: outcome.events,
      })
      check(record, 'target line 4 is unchanged', lineText(4) === EXPECTED_LINES[4], lineText(4))
    }
  )

  await runCase(
    state,
    'case10',
    'empty allowlist: edit-only CodeAction is applied',
    { tool: 'apply_code_action', line: 9, allowedCommands: [] },
    async (record) => {
      const listed = await listActions(client, 9)
      const found = findActionIndex(listed.parsed, 'case10-edit-only')
      check(record, 'positive control: fixture provider offered the edit-only action', found.index >= 0, found)
      const outcome = await applyAction(client, 9, found.index >= 0 ? found.index : 0)
      assertApplied(record, outcome.result)
      check(record, 'edit applied exactly once (line 9 replaced)', lineText(9) === EDITED_LINES[9], lineText(9))
      const effectiveEvents = outcome.events.filter((event) => event.contentChanges > 0)
      check(record, 'exactly one content-bearing document change event', effectiveEvents.length === 1, {
        effective: effectiveEvents.length,
        all: outcome.events,
      })
      check(record, 'document version advanced once', outcome.after.version === outcome.before.version + 1, {
        before: outcome.before.version,
        after: outcome.after.version,
      })
      check(record, 'document became dirty (edit not auto-saved)', outcome.afterDirty === true, outcome.afterDirty)
      check(record, 'edit was not written to disk', fs.readFileSync(targetFile, 'utf8') === baselineText, {
        diskEqualsBaseline: fs.readFileSync(targetFile, 'utf8') === baselineText,
      })
      const anyCounters = Object.values(FIXTURE_COMMANDS).map((commandId) => readCounter(commandId).length)
      check(record, 'edit-only action executed no command at all', anyCounters.every((count) => count === 0), anyCounters)
    }
  )

  // ---- Deterministic restart into phase 2 (different allowlist) ----
  phase1.finishedAt = new Date().toISOString()
  progress('phase1 complete; closing client')
  await withTimeout(client.close(), 10000, 'close phase 1 client')
  const released = await waitForNoAgents(port, 8000)
  phase1.sessionReleased = released.released
  await withTimeout(vscode.commands.executeCommand('mcpServer.stop'), 20000, 'mcpServer.stop before reconfigure')
  const down1 = await waitForHealthDown(port, 10000)
  phase1.serverStoppedForReconfigure = down1.down
  progress(`phase1 server stopped=${down1.down}`)

  await withTimeout(
    vscode.workspace.getConfiguration('mcpServer').update('allowedCommands', PHASE2_ALLOWLIST.slice(), vscode.ConfigurationTarget.Workspace),
    20000,
    'update mcpServer.allowedCommands'
  )
  const up2 = await waitForHealthUp(port, 25000)
  const stable2 = up2.up ? await waitForHealthStable(port, 8000) : { stable: false }
  const effectiveAllowlist = vscode.workspace.getConfiguration('mcpServer').get('allowedCommands')
  const phase2 = {
    name: 'nonempty-allowlist',
    allowedCommands: Array.isArray(effectiveAllowlist) ? effectiveAllowlist : null,
    requestedAllowedCommands: PHASE2_ALLOWLIST,
    restartObservedDown: down1.down,
    restartObservedUp: up2.up,
    restartStable: stable2.stable,
    healthAfterRestart: up2.body || null,
    startedAt: new Date().toISOString(),
  }
  state.phases.push(phase2)
  progress(`phase2 server up=${up2.up} stable=${stable2.stable} allowlist=${JSON.stringify(effectiveAllowlist)}`)
  if (!up2.up) throw new Error('bridge HTTP server did not come back after the allowlist reconfiguration')
  if (!stable2.stable) throw new Error('bridge HTTP server did not stabilise after the allowlist reconfiguration')
  if (!Array.isArray(effectiveAllowlist) || JSON.stringify(effectiveAllowlist) !== JSON.stringify(PHASE2_ALLOWLIST)) {
    throw new Error(`effective allowedCommands after reconfiguration is ${JSON.stringify(effectiveAllowlist)}`)
  }

  client = await connectClient(port, token)
  const liveness2 = await callTool(client, 'get_workspace_info', {})
  const tools2 = await withTimeout(client.listTools(), 15000, 'tools/list phase 2')
  phase2.toolCount = (tools2.tools || []).length
  phase2.livenessCallSucceeded = !(liveness2 && liveness2.isError === true)
  if (phase2.toolCount < 1) throw new Error('phase 2 session advertised no tools')
  if (!phase2.livenessCallSucceeded) throw new Error('phase 2 MCP session liveness call failed')

  await runCase(
    state,
    'case02',
    'nonempty allowlist: allowlisted direct execute_vscode_command executes exactly once',
    { tool: 'execute_vscode_command', command: FIXTURE_COMMANDS.directAllowed, allowedCommands: PHASE2_ALLOWLIST },
    async (record) => {
      const result = await callTool(client, 'execute_vscode_command', { command: FIXTURE_COMMANDS.directAllowed, args: [{ case: '02' }] })
      const payload = parseJsonText(result)
      check(record, 'tool call succeeded (positive control for the whole command path)', !(result && result.isError === true), payload)
      check(record, 'fixture command observed the real execution', payload && payload.result && payload.result.ok === true, payload)
      const entries = readCounter(FIXTURE_COMMANDS.directAllowed)
      check(record, 'allowlisted command counter is exactly 1', entries.length === 1, entries.length)
      check(record, 'command received the forwarded arguments', entries[0] && JSON.stringify(entries[0].args) === JSON.stringify([{ case: '02' }]), entries[0] && entries[0].args)
    }
  )

  await runCase(
    state,
    'case03',
    'nonempty allowlist: nonmember direct command is denied',
    { tool: 'execute_vscode_command', command: FIXTURE_COMMANDS.directDenied, allowedCommands: PHASE2_ALLOWLIST },
    async (record) => {
      const result = await callTool(client, 'execute_vscode_command', { command: FIXTURE_COMMANDS.directDenied, args: [] })
      assertDenied(record, result, FIXTURE_COMMANDS.directDenied)
      check(record, 'denied command counter is 0', readCounter(FIXTURE_COMMANDS.directDenied).length === 0, readCounter(FIXTURE_COMMANDS.directDenied).length)
    }
  )

  await runCase(
    state,
    'case06',
    'object carrier: same allowlist membership decides positive and negative',
    { tool: 'apply_code_action', lines: [5, 6], allowedCommands: PHASE2_ALLOWLIST },
    async (record) => {
      const listedPositive = await listActions(client, 5)
      const foundPositive = findActionIndex(listedPositive.parsed, 'case06a-object-carrier-member')
      check(record, 'positive control: member action was offered by the provider', foundPositive.index >= 0, foundPositive)
      const positive = await applyAction(client, 5, foundPositive.index >= 0 ? foundPositive.index : 0)
      assertApplied(record, positive.result)
      const positiveEntries = readCounter(FIXTURE_COMMANDS.objectAllowed)
      check(record, 'member object command executed exactly once', positiveEntries.length === 1, positiveEntries.length)
      check(record, 'member object command received its arguments', positiveEntries[0] && JSON.stringify(positiveEntries[0].args) === JSON.stringify([{ case: '06a' }]), positiveEntries[0] && positiveEntries[0].args)
      check(record, 'member action produced no edit', positive.after.version === positive.before.version && positive.events.length === 0, {
        beforeVersion: positive.before.version,
        afterVersion: positive.after.version,
        changeEvents: positive.events,
      })

      const listedNegative = await listActions(client, 6)
      const foundNegative = findActionIndex(listedNegative.parsed, 'case06b-object-carrier-nonmember')
      check(record, 'positive control: nonmember action was offered by the provider', foundNegative.index >= 0, foundNegative)
      const negative = await applyAction(client, 6, foundNegative.index >= 0 ? foundNegative.index : 0)
      assertDenied(record, negative.result, FIXTURE_COMMANDS.objectDenied)
      check(record, 'nonmember object command counter is 0', readCounter(FIXTURE_COMMANDS.objectDenied).length === 0, readCounter(FIXTURE_COMMANDS.objectDenied).length)
      check(record, 'nonmember action produced no edit', negative.after.version === negative.before.version && negative.events.length === 0, {
        beforeVersion: negative.before.version,
        afterVersion: negative.after.version,
        changeEvents: negative.events,
      })
      check(record, 'target line 6 is unchanged', lineText(6) === EXPECTED_LINES[6], lineText(6))
    }
  )

  await runCase(
    state,
    'case07',
    'denied combined edit+command action is rejected before the edit',
    { tool: 'apply_code_action', line: 7, allowedCommands: PHASE2_ALLOWLIST },
    async (record) => {
      const listed = await listActions(client, 7)
      const found = findActionIndex(listed.parsed, 'case07-combined-denied-before-edit')
      check(record, 'positive control: combined denied action was offered by the provider', found.index >= 0, found)
      const outcome = await applyAction(client, 7, found.index >= 0 ? found.index : 0)
      assertDenied(record, outcome.result, FIXTURE_COMMANDS.combinedDenied)
      check(record, 'no edit was applied before the rejection', outcome.after.version === outcome.before.version, {
        beforeVersion: outcome.before.version,
        afterVersion: outcome.after.version,
      })
      check(record, 'no document change event was emitted', outcome.events.length === 0, outcome.events)
      check(record, 'target line 7 still holds its baseline text', lineText(7) === EXPECTED_LINES[7], lineText(7))
      check(record, 'denied combined command counter is 0', readCounter(FIXTURE_COMMANDS.combinedDenied).length === 0, readCounter(FIXTURE_COMMANDS.combinedDenied).length)
    }
  )

  await runCase(
    state,
    'case09',
    'allowed combined edit+command action applies the edit once and skips the command',
    { tool: 'apply_code_action', line: 8, allowedCommands: PHASE2_ALLOWLIST },
    async (record) => {
      const listed = await listActions(client, 8)
      const found = findActionIndex(listed.parsed, 'case09-combined-allowed-edit-precedence')
      check(record, 'positive control: combined allowed action was offered by the provider', found.index >= 0, found)
      const outcome = await applyAction(client, 8, found.index >= 0 ? found.index : 0)
      assertApplied(record, outcome.result)
      check(record, 'edit applied exactly once', lineText(8) === EDITED_LINES[8], lineText(8))
      check(record, 'marker appears exactly once in the document', markerCount(doc.getText(), EDITED_LINES[8]) === 1, markerCount(doc.getText(), EDITED_LINES[8]))
      const effectiveEvents = outcome.events.filter((event) => event.contentChanges > 0)
      check(record, 'exactly one content-bearing document change event', effectiveEvents.length === 1, {
        effective: effectiveEvents.length,
        all: outcome.events,
      })
      check(record, 'document version advanced once', outcome.after.version === outcome.before.version + 1, {
        before: outcome.before.version,
        after: outcome.after.version,
      })
      check(record, 'edit was not written to disk', fs.readFileSync(targetFile, 'utf8') === baselineText, {
        diskEqualsBaseline: fs.readFileSync(targetFile, 'utf8') === baselineText,
      })
      check(record, 'carried allowed command was NOT executed (existing edit precedence)', readCounter(FIXTURE_COMMANDS.combinedAllowed).length === 0, readCounter(FIXTURE_COMMANDS.combinedAllowed).length)
    }
  )

  await runCase(
    state,
    'case08',
    'aggregate: all denied commands have zero executions and the target document is unchanged',
    {
      counters: [
        FIXTURE_COMMANDS.directDenied,
        FIXTURE_COMMANDS.objectDenied,
        FIXTURE_COMMANDS.deniedBare,
        FIXTURE_COMMANDS.combinedDenied,
      ],
    },
    async (record) => {
      const denied = [
        FIXTURE_COMMANDS.directDenied,
        FIXTURE_COMMANDS.objectDenied,
        FIXTURE_COMMANDS.deniedBare,
        FIXTURE_COMMANDS.combinedDenied,
      ]
      const counts = {}
      for (const commandId of denied) counts[commandId] = readCounter(commandId).length
      check(record, 'every denied command counter is 0', Object.values(counts).every((count) => count === 0), counts)

      const untouched = [0, 1, 2, 3, 4, 5, 6, 7]
      const drifted = untouched.filter((line) => lineText(line) !== EXPECTED_LINES[line])
      check(record, 'all non-authorized lines keep their baseline text', drifted.length === 0, drifted)

      const diskNow = fs.readFileSync(targetFile, 'utf8')
      check(record, 'target document is unchanged on disk (no write leaked through)', diskNow === baselineText, {
        diskEqualsBaseline: diskNow === baselineText,
      })
      check(record, 'only the two authorized edit markers exist', markerCount(doc.getText(), EDITED_LINES[8]) === 1 && markerCount(doc.getText(), EDITED_LINES[9]) === 1, {
        case09Marker: markerCount(doc.getText(), EDITED_LINES[8]),
        case10Marker: markerCount(doc.getText(), EDITED_LINES[9]),
      })
    }
  )

  phase2.finishedAt = new Date().toISOString()

  // ---- Cleanup ----
  progress('cleanup-start')
  changeSub.dispose()
  const cleanup = { startedAt: new Date().toISOString() }
  try {
    await withTimeout(client.close(), 10000, 'close phase 2 client')
    cleanup.clientClosed = true
  } catch (err) {
    cleanup.clientClosed = false
    cleanup.clientCloseError = String((err && err.message) || err)
  }
  cleanup.dirtyDocumentsBeforeCleanup = vscode.workspace.textDocuments.filter((document) => document.isDirty).length
  cleanup.textBeforeRevert = clip(doc.getText(), 400)
  cleanup.versionBeforeRevert = doc.version
  cleanup.diskBeforeRevertEqualsBaseline = fs.readFileSync(targetFile, 'utf8') === baselineText
  try {
    await withTimeout(vscode.commands.executeCommand('_workbench.revertAllDirty'), 15000, 'revert dirty documents')
    cleanup.revertDirty = true
  } catch (err) {
    cleanup.revertDirty = String((err && err.message) || err)
  }
  // The revert is driven from the main thread; the extension-host document
  // content arrives asynchronously, so poll briefly before judging.
  const revertDeadline = Date.now() + 5000
  while (doc.getText() !== baselineText && Date.now() < revertDeadline) {
    await delay(150)
  }
  cleanup.documentTextRestored = doc.getText() === baselineText
  cleanup.documentDirtyAfterRevert = doc.isDirty
  cleanup.versionAfterRevert = doc.version
  if (!cleanup.documentTextRestored) {
    // Fallback: revert through an editor, which is a different code path.
    try {
      await withTimeout(vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true }), 10000, 'show target document')
      await withTimeout(vscode.commands.executeCommand('workbench.action.files.revert'), 10000, 'editor revert')
      cleanup.editorRevert = true
    } catch (err) {
      cleanup.editorRevert = String((err && err.message) || err)
    }
    await delay(200)
    cleanup.documentTextRestoredAfterEditorRevert = doc.getText() === baselineText
    cleanup.documentDirtyAfterEditorRevert = doc.isDirty
    cleanup.versionAfterEditorRevert = doc.version
  }
  // Reopen to rule out a stale TextDocument reference after the revert.
  try {
    const reopened = await withTimeout(vscode.workspace.openTextDocument(targetUri), 10000, 'reopen target document')
    cleanup.reopenedDocumentTextRestored = reopened.getText() === baselineText
    cleanup.reopenedDocumentDirty = reopened.isDirty
  } catch (err) {
    cleanup.reopenedDocumentTextRestored = String((err && err.message) || err)
  }
  const diskAfterRevert = fs.readFileSync(targetFile, 'utf8')
  cleanup.diskAfterRevertEqualsBaseline = diskAfterRevert === baselineText
  if (!cleanup.diskAfterRevertEqualsBaseline) {
    // Disposable fixture workspace: restore the fixture file if any code path saved it.
    fs.writeFileSync(targetFile, baselineText, 'utf8')
    cleanup.diskRestoredByHarness = fs.readFileSync(targetFile, 'utf8') === baselineText
    cleanup.diskAfterRevertEqualsBaseline = cleanup.diskRestoredByHarness
  }
  const afterRevertText = doc.getText()
  cleanup.afterRevertDiff = (() => {
    if (afterRevertText === baselineText) return null
    const length = Math.min(afterRevertText.length, baselineText.length)
    let index = 0
    while (index < length && afterRevertText[index] === baselineText[index]) index += 1
    return {
      baselineLength: baselineText.length,
      actualLength: afterRevertText.length,
      firstDifferenceIndex: index,
      expectedSnippet: clip(baselineText.slice(Math.max(0, index - 20), index + 60), 120),
      actualSnippet: clip(afterRevertText.slice(Math.max(0, index - 20), index + 60), 120),
    }
  })()
  try {
    await withTimeout(vscode.commands.executeCommand('mcpServer.stop'), 20000, 'mcpServer.stop cleanup')
    cleanup.stopCommand = 'ok'
  } catch (err) {
    cleanup.stopCommand = String((err && err.message) || err)
  }
  const targetDocuments = vscode.workspace.textDocuments.filter((document) => document.uri.toString() === targetUri.toString())
  cleanup.targetDocumentDirtyStates = targetDocuments.map((document) => document.isDirty)
  cleanup.noDirtyTargetDocument = targetDocuments.every((document) => !document.isDirty)
  const downCleanup = await waitForHealthDown(port, 10000)
  cleanup.serverStopped = downCleanup.down
  cleanup.portClosed = downCleanup.down
  cleanup.finishedAt = new Date().toISOString()
  state.cleanup = cleanup
  state.durationMs = Date.now() - startedAt
}

exports.run = function (testsRoot, callback) {
  EVIDENCE_DIR = process.env.BRIDGE90_EVIDENCE_DIR || ''
  STATE = {
    gate: 'bridge90-real-vscode-host',
    method: 'real VS Code extension host + real @modelcontextprotocol/sdk client over authenticated loopback SSE',
    startedAt: new Date().toISOString(),
    testsRoot,
    evidenceDir: EVIDENCE_DIR || null,
    envNamesPresent: {
      BRIDGE90_EVIDENCE_DIR: !!process.env.BRIDGE90_EVIDENCE_DIR,
      BRIDGE90_PORT: !!process.env.BRIDGE90_PORT,
      BRIDGE90_EXPECT_BUNDLE_SHA: !!process.env.BRIDGE90_EXPECT_BUNDLE_SHA,
      BRIDGE90_EXPECT_FIXTURE_SHA: !!process.env.BRIDGE90_EXPECT_FIXTURE_SHA,
      BRIDGE90_BRIDGE_DIR: !!process.env.BRIDGE90_BRIDGE_DIR,
      BRIDGE90_FIXTURE_DIR: !!process.env.BRIDGE90_FIXTURE_DIR,
      BRIDGE90_APP_ROOT: !!process.env.BRIDGE90_APP_ROOT,
      BRIDGE90_DEPLOYED_DIR: !!process.env.BRIDGE90_DEPLOYED_DIR,
      BRIDGE90_SDK_VERSION: !!process.env.BRIDGE90_SDK_VERSION,
      BRIDGE90_LAUNCH_FLAGS: !!process.env.BRIDGE90_LAUNCH_FLAGS,
    },
    cases: [],
    phases: [],
    errors: [],
  }

  const writeEvidence = () => {
    try {
      STATE.finishedAt = new Date().toISOString()
      STATE.failedCases = STATE.cases.filter((record) => !record.pass).map((record) => record.id)
      STATE.passedCases = STATE.cases.filter((record) => record.pass).map((record) => record.id)
      STATE.caseCount = STATE.cases.length
      STATE.verdict = STATE.errors.length === 0 && STATE.cases.length === 10 && STATE.failedCases.length === 0 ? 'PASS' : 'FAIL'
      if (EVIDENCE_DIR) {
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'host-evidence.json'), JSON.stringify(STATE, null, 2), 'utf8')
      }
    } catch (err) {
      console.error('[bridge90-host-gate] failed to write evidence', err)
    }
  }

  const finish = (error) => {
    if (FINISHED) return
    FINISHED = true
    clearTimeout(TIMER)
    if (error) STATE.errors.push(String((error && error.stack) || error))
    writeEvidence()
    const failures = STATE.errors.length + STATE.cases.filter((record) => !record.pass).length
    progress(`finish errors=${STATE.errors.length} failedCases=${STATE.failedCases ? STATE.failedCases.join(',') : ''}`)
    try {
      callback(error || null, failures)
    } catch (err) {
      console.error('[bridge90-host-gate] callback failed', err)
    }
  }

  TIMER = setTimeout(() => {
    progress('global-timeout')
    finish(new Error('bridge90 host gate exceeded its 180s budget'))
  }, 180000)

  main().then(
    () => finish(null),
    (error) => finish(error || new Error('unknown harness failure'))
  )
}
