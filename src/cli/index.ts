#!/usr/bin/env node
import { Command } from 'commander'
import { buildCliServices } from './buildCliServices'
import { connectionCommand } from './commands/connection'
import { settingsCommand } from './commands/settings'
import { threadCommand } from './commands/thread'
import { fail } from './exit'

async function main(): Promise<void> {
  const services = buildCliServices()
  const program = new Command()
    .name('aras')
    .description('Headless Aras Innovator harness — connections, settings, and conversation threads.')
    .version('0.1.0')

  program.addCommand(connectionCommand(services))
  program.addCommand(settingsCommand(services))
  program.addCommand(threadCommand(services))

  await program.parseAsync(process.argv)
}

main().catch((err) => fail(err))
