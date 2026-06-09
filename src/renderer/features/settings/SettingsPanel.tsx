import { useEffect, useState } from 'react'
import type { LlmProviderId, LlmSettings } from '@shared/ipc'

const MODEL_SUGGESTIONS: Record<LlmProviderId, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'mistral']
}

export function SettingsPanel({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [provider, setProvider] = useState<LlmProviderId>('anthropic')
  const [model, setModel] = useState('claude-opus-4-8')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [current, setCurrent] = useState<LlmSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.settings.getLlm().then((s) => {
      if (!s) return
      setCurrent(s)
      setProvider(s.provider)
      setModel(s.model)
      setBaseUrl(s.baseUrl ?? '')
    })
  }, [])

  const save = async (): Promise<void> => {
    const result = await window.api.settings.saveLlm({
      provider,
      model,
      ...(provider === 'ollama' && baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {})
    })
    setCurrent(result)
    setApiKey('')
    setSaved(true)
    onChanged()
    setTimeout(() => setSaved(false), 1500)
  }

  const needsKey = provider === 'anthropic' || provider === 'openai'

  return (
    <div className="panel">
      <h2>LLM Settings</h2>
      <div className="card">
        <label>Provider</label>
        <select
          value={provider}
          onChange={(e) => {
            const p = e.target.value as LlmProviderId
            setProvider(p)
            setModel(MODEL_SUGGESTIONS[p][0])
          }}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama (local)</option>
        </select>

        <label>Model</label>
        <input list="models" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="models">
          {MODEL_SUGGESTIONS[provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        {provider === 'ollama' && (
          <>
            <label>Base URL</label>
            <input
              placeholder="http://localhost:11434"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </>
        )}

        {needsKey && (
          <>
            <label>
              API Key{' '}
              {current?.hasApiKey && <span className="pill green">stored</span>}{' '}
              <span className="muted">(leave blank to keep existing)</span>
            </label>
            <input
              type="password"
              value={apiKey}
              placeholder={current?.hasApiKey ? '••••••••' : 'sk-…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => void save()} disabled={!model}>
            Save
          </button>
          {saved && <span className="pill green">Saved</span>}
        </div>
      </div>
      <p className="muted">
        Keys are encrypted at rest with your OS keychain and never leave the main process.
      </p>
    </div>
  )
}
