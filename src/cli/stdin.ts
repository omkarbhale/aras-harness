/** Read all of stdin to a string. Rejects with a clear error if stdin is a TTY. */
export async function readStdin(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      `${label} expected on stdin (pipe a value, e.g. \`echo $env:SECRET | aras ...\`). ` +
        `Interactive prompts are intentionally not supported — pipe the value or omit the --stdin flag.`
    )
  }
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data.replace(/\r?\n$/, '')
}
