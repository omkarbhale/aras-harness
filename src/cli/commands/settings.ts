import { Command } from 'commander'
import type { AppServices } from '@core/services'
import type { LlmProviderId } from '@shared/ipc'
import { readStdin } from '../stdin'
import { fail } from '../exit'

/** `aras settings ...` — get/set LLM provider config and agent (timeout/retry) tuning. */
export function settingsCommand(services: AppServices): Command {
  const cmd = new Command('settings').description('Get and set LLM + agent settings')

  const llm = cmd.command('llm').description('LLM provider configuration')
  llm
    .command('get')
    .description('Print the current LLM settings as JSON')
    .action(async () => {
      const s = await services.settings.getLlmSettings()
      process.stdout.write(`${JSON.stringify(s, null, 2)}\n`)
    })
  llm
    .command('set')
    .description('Save LLM settings. API key (if any) read from stdin.')
    .requiredOption('--provider <provider>', 'anthropic | openai | ollama')
    .requiredOption('--model <model>', 'Model name, e.g. claude-opus-4-8')
    .option('--base-url <url>', 'Override base URL (Ollama / gateways)')
    .option('--api-key-stdin', 'Read API key from stdin')
    .action(
      async (opts: {
        provider: string
        model: string
        baseUrl?: string
        apiKeyStdin?: boolean
      }) => {
        const provider = opts.provider as LlmProviderId
        try {
          const apiKey = opts.apiKeyStdin ? await readStdin('API key') : undefined
          const dto = await services.settings.saveLlmSettings({
            provider,
            model: opts.model,
            ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
            ...(apiKey ? { apiKey } : {})
          })
          process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`)
        } catch (e) {
          fail(e)
        }
      }
    )

  const agent = cmd.command('agent').description('Agent tuning')
  agent
    .command('get')
    .description('Print current agent settings as JSON')
    .action(() => {
      const s = services.settings.getAgentSettings()
      process.stdout.write(`${JSON.stringify(s, null, 2)}\n`)
    })
  agent
    .command('set')
    .description('Save agent settings')
    .requiredOption('--tool-timeout <seconds>', 'Tool execution timeout (5–300)', (v) => Number(v))
    .option(
      '--max-retry-attempts <n>',
      'Cap on read-tool retries. Omit to keep infinite retries (default).',
      (v) => Number(v)
    )
    .action((opts: { toolTimeout: number; maxRetryAttempts?: number }) => {
      try {
        const dto = services.settings.saveAgentSettings({
          toolTimeoutSec: opts.toolTimeout,
          ...(opts.maxRetryAttempts !== undefined ? { maxRetryAttempts: opts.maxRetryAttempts } : {})
        })
        process.stdout.write(`${JSON.stringify(dto, null, 2)}\n`)
      } catch (e) {
        fail(e)
      }
    })

  return cmd
}
