'use strict'

// Benign, test-only fixture extension for the Bridge #90 real-VS-Code-Host gate.
// It registers counter commands (one JSONL line per execution) and a deterministic
// CodeAction provider for the fixture target document. It never touches the
// filesystem outside BRIDGE90_EVIDENCE_DIR and never spawns processes.

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

const TARGET_BASENAME = 'bridge90-target.txt'

const COMMANDS = {
  directAllowed: 'scAgentIdeFixture90.directAllowed',
  directDenied: 'scAgentIdeFixture90.directDenied',
  objectAllowed: 'scAgentIdeFixture90.objectAllowed',
  objectDenied: 'scAgentIdeFixture90.objectDenied',
  combinedDenied: 'scAgentIdeFixture90.combinedDenied',
  combinedAllowed: 'scAgentIdeFixture90.combinedAllowed',
  deniedBare: 'scAgentIdeFixture90.deniedBare',
}

const EDITED_LINES = {
  7: 'EDITED:case07-combined-denied-before-edit',
  8: 'EDITED:case09-combined-allowed-edit-precedence',
  9: 'EDITED:case10-edit-only',
}

function evidenceDir() {
  return process.env.BRIDGE90_EVIDENCE_DIR || ''
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

function recordCommand(commandId, args) {
  const file = path.join(evidenceDir(), 'counters', commandId + '.jsonl')
  const entry = { command: commandId, args, at: Date.now(), extHostPid: process.pid }
  appendJsonl(file, entry)
  return { ok: true, command: commandId, args }
}

function modeName(mode) {
  if (mode === 1) return 'Production'
  if (mode === 2) return 'Development'
  if (mode === 3) return 'Test'
  return 'Unknown'
}

function activate(context) {
  const dir = evidenceDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'fixture-context.json'),
    JSON.stringify(
      {
        extensionId: context.extension.id,
        extensionVersion: context.extension.packageJSON.version,
        extensionMode: context.extensionMode,
        extensionModeName: modeName(context.extensionMode),
        vscodeVersion: vscode.version,
        appName: vscode.env.appName,
        appHost: vscode.env.appHost,
        extHostPid: process.pid,
      },
      null,
      2
    ),
    'utf8'
  )

  for (const commandId of Object.values(COMMANDS)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, (...args) => recordCommand(commandId, args))
    )
  }

  const objectCommand = (title, command, args) => ({
    title,
    command: { title, command, arguments: args },
  })

  const provider = {
    provideCodeActions(document, range) {
      const filePath = document && document.uri && document.uri.fsPath
      if (!filePath || path.basename(filePath) !== TARGET_BASENAME) return []
      const line = range.start.line
      appendJsonl(path.join(dir, 'provider-calls.jsonl'), { line, at: Date.now() })

      const editFor = (lineNo) => {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(document.uri, document.lineAt(lineNo).range, EDITED_LINES[lineNo])
        return edit
      }

      switch (line) {
        case 3:
          return [objectCommand('case04-empty-object-command', COMMANDS.objectDenied, [{ case: '04' }])]
        case 4:
          return [{ title: 'case05-empty-bare-command', command: COMMANDS.deniedBare }]
        case 5:
          return [objectCommand('case06a-object-carrier-member', COMMANDS.objectAllowed, [{ case: '06a' }])]
        case 6:
          return [objectCommand('case06b-object-carrier-nonmember', COMMANDS.objectDenied, [{ case: '06b' }])]
        case 7:
          return [
            {
              title: 'case07-combined-denied-before-edit',
              edit: editFor(7),
              command: {
                title: 'case07-combined-denied-before-edit',
                command: COMMANDS.combinedDenied,
                arguments: [{ case: '07' }],
              },
            },
          ]
        case 8:
          return [
            {
              title: 'case09-combined-allowed-edit-precedence',
              edit: editFor(8),
              command: {
                title: 'case09-combined-allowed-edit-precedence',
                command: COMMANDS.combinedAllowed,
                arguments: [{ case: '09' }],
              },
            },
          ]
        case 9:
          return [{ title: 'case10-edit-only', edit: editFor(9) }]
        default:
          return []
      }
    },
  }

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ pattern: `**/${TARGET_BASENAME}` }, { language: 'plaintext' }],
      provider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor] }
    )
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
