import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { AppServices } from '@core/services'
import { fail } from '../exit'

/** `aras thread ...` — list / create / rename / delete / show conversation threads. */
export function threadCommand(services: AppServices): Command {
  const cmd = new Command('thread').description('Manage conversation threads')

  cmd
    .command('list')
    .description('List threads (most recently updated first)')
    .option('--json', 'Output as a JSON array')
    .action((opts: { json?: boolean }) => {
      const rows = services.threadStore.listSummaries()
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
        return
      }
      if (rows.length === 0) {
        process.stdout.write('No threads yet.\n')
        return
      }
      for (const r of rows) {
        process.stdout.write(`${r.id}  ${r.name}  (${r.messageCount} msg)\n`)
      }
    })

  cmd
    .command('new')
    .description('Create a new thread. Prints the new id on stdout.')
    .option('--name <name>', 'Display name (default: "New chat")')
    .action((opts: { name?: string }) => {
      const id = randomUUID()
      services.threadStore.create({ id, name: opts.name?.trim() || 'New chat' })
      process.stdout.write(`${id}\n`)
    })

  cmd
    .command('rename <id>')
    .description('Rename a thread')
    .requiredOption('--name <name>', 'New display name')
    .action((id: string, opts: { name: string }) => {
      const next = opts.name.trim()
      if (!next) fail(new Error('Name must not be empty.'))
      services.threadStore.rename(id, next)
    })

  cmd
    .command('delete <id>')
    .description('Delete a thread and all of its persisted events/runs')
    .action((id: string) => {
      services.deleteThread(id)
    })

  cmd
    .command('show <id>')
    .description('Print the full event stream for a thread (NDJSON by default)')
    .option('--text', 'Render as a human-readable transcript instead of NDJSON')
    .action((id: string, opts: { text?: boolean }) => {
      const events = services.eventLog.listByThread(id)
      if (!opts.text) {
        for (const ev of events) process.stdout.write(`${JSON.stringify(ev)}\n`)
        return
      }
      for (const ev of events) {
        switch (ev.type) {
          case 'user_message':
            process.stdout.write(`\n[you] ${ev.content}\n`)
            break
          case 'assistant_message':
            process.stdout.write(`[agent] ${ev.content}\n`)
            break
          case 'tool_start':
            process.stdout.write(`  → ${ev.name}(${JSON.stringify(ev.args)})\n`)
            break
          case 'tool_end':
            process.stdout.write(`  ← ${ev.toolCallId.slice(0, 6)} ${ev.isError ? 'ERR ' : ''}${truncate(ev.result, 200)}\n`)
            break
          case 'approval_request':
            process.stdout.write(`  ⚠ approval needed: ${ev.summary}\n`)
            break
          case 'error':
            process.stdout.write(`  ✗ ${ev.message}\n`)
            break
          default:
            break
        }
      }
    })

  return cmd
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
