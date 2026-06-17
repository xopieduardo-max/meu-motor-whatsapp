/**
 * provider: 'openai' | 'gemini'
 * model: pode ser só o nome ou no formato "provider/model" (ex: "google/gemini-2.5-flash")
 */
async function getAIResponse({ userMessage, history = [], systemPrompt, apiKey, provider = 'openai', model, temperature = 0.7 }) {
  // Suporte ao formato "provider/model" vindo do editor de fluxos
  if (model && model.includes('/')) {
    const [prefix, modelId] = model.split('/', 2)
    if (prefix === 'google') { provider = 'gemini'; model = modelId }
    else if (prefix === 'openai') { provider = 'openai'; model = modelId }
  }
  if (provider === 'gemini') {
    return getGeminiResponse({ userMessage, history, systemPrompt, apiKey, model: model || 'gemini-1.5-flash', temperature })
  }
  return getOpenAIResponse({ userMessage, history, systemPrompt, apiKey, model: model || 'gpt-4o-mini', temperature })
}

async function getOpenAIResponse({ userMessage, history, systemPrompt, apiKey, model, temperature = 0.7 }) {
  const messages = [
    { role: 'system', content: systemPrompt || 'Você é um assistente prestativo.' },
    ...history,
    { role: 'user', content: userMessage },
  ]
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 800, temperature }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() ?? null
}

async function getGeminiResponse({ userMessage, history, systemPrompt, apiKey, model, temperature = 0.7 }) {
  const contents = [
    ...history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ]
  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt || 'Você é um assistente prestativo.' }] },
    generationConfig: { maxOutputTokens: 800, temperature },
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  if (!res.ok) {
    const b = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${b.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null
}

module.exports = { getAIResponse }
