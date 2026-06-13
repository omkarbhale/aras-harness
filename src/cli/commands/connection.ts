import { Command } from 'commander'
import type { AppServices } from '@core/services'
import { readStdin } from '../stdin'
import { fail } from '../exit'

/**
 * `aras connection ...` — CRUD over Aras connections, set-active, test.
 * Passwords come from stdin only (never argv) so they don't end up in shell history.
 *
 * Commands that take `<id-or-name>` accept either the UUID id or a unique connection
 * name — names are what humans remember, so making them work is the kinder default.
 * Ambiguity (two connections sharing a name) falls back to requiring the id.
 */
export function connectionCommand(services: AppServices): Command {
  const cmd = new Command('connection').description('Manage Aras Innovator connections')

  cmd
    .command('list')
    .description('List stored connections')
    .action(async () => {
      const list = await services.settings.listConnections()
      const active = services.settings.getActiveConnectionId()
      if (list.length === 0) {
        process.stdout.write('No connections configured.\n')
        return
      }
      for (const c of list) {
        const marker = c.id === active ? '*' : ' '
        const pw = c.hasPassword ? '✓' : '✗'
        process.stdout.write(
          `${marker} ${c.id}  ${c.name}\n      ${c.username}@${c.database} — ${c.instanceUrl}  [pw ${pw}]\n`
        )
      }
    })

  cmd
    .command('add')
    .description('Add a new connection. Password read from stdin.')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--url <url>', 'Aras instance base URL, e.g. http://host/InnovatorServer')
    .requiredOption('--db <db>', 'Innovator database name')
    .requiredOption('--user <user>', 'Username')
    .option('--password-stdin', 'Read password from stdin (required)')
    .action(async (opts: { name: string; url: string; db: string; user: string; passwordStdin?: boolean }) => {
      if (!opts.passwordStdin) {
        fail(new Error('Pass --password-stdin and pipe the password on stdin.'))
      }
      try {
        const password = await readStdin('Password')
        const dto = await services.settings.saveConnection({
          name: opts.name,
          instanceUrl: opts.url,
          database: opts.db,
          username: opts.user,
          password
        })
        process.stdout.write(`${dto.id}\n`)
      } catch (e) {
        fail(e)
      }
    })

  cmd
    .command('remove <idOrName>')
    .description('Delete a connection (and its stored password)')
    .action(async (ref: string) => {
      try {
        const id = await resolveConnectionRef(services, ref)
        await services.settings.deleteConnection(id)
      } catch (e) {
        fail(e)
      }
    })

  cmd
    .command('set-active <idOrName>')
    .description('Mark a connection as the active one')
    .action(async (ref: string) => {
      try {
        const id = await resolveConnectionRef(services, ref)
        services.settings.setActiveConnection(id)
      } catch (e) {
        fail(e)
      }
    })

  cmd
    .command('get-active')
    .description('Print the active connection id')
    .action(() => {
      const id = services.settings.getActiveConnectionId()
      if (id) process.stdout.write(`${id}\n`)
    })

  cmd
    .command('test <idOrName>')
    .description('Test that a connection can authenticate against its Aras instance')
    .action(async (ref: string) => {
      try {
        const id = await resolveConnectionRef(services, ref)
        const client = await services.buildClientFor(id)
        const { latencyMs } = await client.testConnection()
        process.stdout.write(`ok (${latencyMs} ms)\n`)
      } catch (e) {
        fail(e)
      }
    })

  return cmd
}

/** Resolve a CLI-provided ref to a connection id: exact id match, else unique name match. */
async function resolveConnectionRef(services: AppServices, ref: string): Promise<string> {
  const list = await services.settings.listConnections()
  const byId = list.find((c) => c.id === ref)
  if (byId) return byId.id
  const byName = list.filter((c) => c.name === ref)
  if (byName.length === 1) return byName[0]!.id
  if (byName.length > 1) {
    throw new Error(
      `Multiple connections named "${ref}". Disambiguate by id:\n` +
        byName.map((c) => `  ${c.id}`).join('\n')
    )
  }
  throw new Error(`Unknown connection "${ref}". Run \`aras connection list\` to see ids.`)
}
