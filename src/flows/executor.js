const { getClient } = require('../lib/app-supabase')

// ── Helpers ───────────────────────────────────────────────────────────────────

function interpolate(text, vars) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''))
}

function slugify(s) {
  return String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'opcao'
}

function nextNode(edges, from, handle) {
  if (handle) {
    const e = edges.find(ed => ed.source === from && ed.sourceHandle === handle)
    if (e) return e.target
  }
  const e = edges.find(ed => ed.source === from && (!ed.sourceHandle || ed.sourceHandle === null))
  return e?.target ?? null
}

function evalCondition(d, vars) {
  const v = String(vars[d.variable] ?? '').toLowerCase().trim()
  const cmp = String(d.value ?? '').toLowerCase().trim()
  if (d.operator === 'diferente') return v !== cmp
  if (d.operator === 'contem')   return v.includes(cmp)
  return v === cmp
}

function pickHandle(node, userText) {
  const t = node?.type
  const d = node?.data ?? {}
  const txt = (userText || '').trim().toLowerCase()

  if (t === 'buttons') {
    const opts = Array.isArray(d.options) ? d.options : []
    const idx = parseInt(txt, 10)
    let chosen = null
    if (!isNaN(idx) && opts[idx - 1]) chosen = opts[idx - 1]
    else chosen = opts.find(o => o.toLowerCase() === txt) ?? opts.find(o => txt.includes(o.toLowerCase())) ?? null
    return chosen ? `opt:${slugify(chosen)}` : null
  }

  if (t === 'question') {
    const rules = Array.isArray(d.matchRules) ? d.matchRules : []
    for (const r of rules) {
      const v = String(r.value ?? '').trim().toLowerCase()
      if (!v) continue
      let match = false
      if (r.type === 'equals') match = txt === v
      else if (r.type === 'regex') { try { match = new RegExp(r.value, 'i').test(userText) } catch { match = false } }
      else match = txt.includes(v)
      if (match) return `opt:${slugify(r.label || r.value)}`
    }
    if (rules.length > 0) return 'opt:fallback'
    return null
  }
  return null
}

function pickRandomizer(branches) {
  if (!Array.isArray(branches) || !branches.length) return null
  const total = branches.reduce((s, b) => s + (Number(b.weight) || 0), 0) || branches.length
  let r = Math.random() * total
  for (let i = 0; i < branches.length; i++) {
    const w = Number(branches[i].weight) || (total / branches.length)
    if (r < w) return `opt:${slugify(branches[i].label || `b${i+1}`)}`
    r -= w
  }
  return `opt:${slugify(branches[0].label || 'b1')}`
}

function validateAnswer(validate, text) {
  if (!validate || validate === 'any') return true
  const t = text.trim()
  if (validate === 'number') return /^-?\d+(\.\d+)?$/.test(t)
  if (validate === 'email')  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)
  if (validate === 'phone')  return t.replace(/\D/g, '').length >= 8
  return true
}

// ── Envio via Baileys ─────────────────────────────────────────────────────────

async function sendMsg(instanceId, phone, text) {
  // lazy require para evitar dependência circular com manager.js
  const manager = require('../whatsapp/manager')
  const conn = manager.obterConexao(instanceId)
  if (!conn) { console.error(`[executor] instância ${instanceId} não encontrada`); return }
  try { await conn.enviarTexto(phone, text) }
  catch (e) { console.error(`[executor] enviarTexto falhou:`, e.message) }
}

// ── Execução do fluxo ─────────────────────────────────────────────────────────

async function runFlow(opts) {
  const { nodes, edges, startId, instanceId, phone, variables: initVars, userId } = opts
  const vars = { ...initVars }
  let cur = startId
  let safety = 0

  while (cur && safety < 50) {
    safety++
    const node = nodes.find(n => n.id === cur)
    if (!node) break
    const d = node.data ?? {}
    const t = node.type

    if (t === 'start') { cur = nextNode(edges, cur, null); continue }

    if (t === 'text') {
      const msgs = Array.isArray(d.messages) && d.messages.length ? d.messages : (d.text ? [d.text] : [])
      for (const m of msgs) await sendMsg(instanceId, phone, interpolate(m, vars))
      cur = nextNode(edges, cur, null); continue
    }

    if (t === 'image' || t === 'audio' || t === 'video' || t === 'pdf') {
      const cap = d.caption ? interpolate(d.caption, vars) : ''
      await sendMsg(instanceId, phone, `${d.url ?? ''}${cap ? '\n' + cap : ''}`)
      cur = nextNode(edges, cur, null); continue
    }

    if (t === 'delay') {
      await new Promise(r => setTimeout(r, Math.min(Number(d.seconds) || 1, 10) * 1000))
      cur = nextNode(edges, cur, null); continue
    }

    if (t === 'question') {
      await sendMsg(instanceId, phone, interpolate(d.question ?? '', vars))
      const reminder = d.timeoutEnabled
        ? new Date(Date.now() + (Number(d.timeoutMinutes) || 30) * 60_000).toISOString()
        : null
      return { stoppedAt: cur, ended: false, variables: vars, reminderDueAt: reminder }
    }

    if (t === 'buttons') {
      const optsArr = Array.isArray(d.options) ? d.options : []
      const lines = optsArr.map((o, i) => `${i + 1}. ${o}`).join('\n')
      await sendMsg(instanceId, phone, `${interpolate(d.text ?? '', vars)}\n\n${lines}`)
      const reminder = d.timeoutEnabled
        ? new Date(Date.now() + (Number(d.timeoutMinutes) || 30) * 60_000).toISOString()
        : null
      return { stoppedAt: cur, ended: false, variables: vars, reminderDueAt: reminder }
    }

    if (t === 'condition') {
      const ok = evalCondition(d, vars)
      cur = nextNode(edges, cur, ok ? 'opt:true' : 'opt:false'); continue
    }

    if (t === 'randomizer') {
      cur = nextNode(edges, cur, pickRandomizer(d.branches ?? [])); continue
    }

    if (t === 'tag') {
      await applyTag(userId, phone, String(d.tag ?? '').trim(), d.action === 'remove' ? 'remove' : 'add')
      cur = nextNode(edges, cur, null); continue
    }

    if (t === 'goto') {
      if (d.flowId) vars.__goto_flow_id = String(d.flowId)
      return { stoppedAt: null, ended: true, variables: vars, reminderDueAt: null }
    }

    if (t === 'webhook') {
      try {
        const body = d.body ? interpolate(d.body, vars) : undefined
        await fetch(d.url ?? '', { method: d.method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body })
      } catch { /* ignora */ }
      cur = nextNode(edges, cur, null); continue
    }

    cur = nextNode(edges, cur, null)
  }

  return { stoppedAt: null, ended: true, variables: vars, reminderDueAt: null }
}

async function applyTag(userId, phone, tag, action) {
  if (!tag) return
  const db = getClient()
  if (!db) return
  try {
    const { data: existing } = await db.from('contacts').select('id, tags').eq('user_id', userId).eq('phone', phone).maybeSingle()
    const cur = Array.isArray(existing?.tags) ? existing.tags : []
    const next = action === 'remove' ? cur.filter(t => t !== tag) : Array.from(new Set([...cur, tag]))
    if (existing) await db.from('contacts').update({ tags: next, last_contact: new Date().toISOString() }).eq('id', existing.id)
    else await db.from('contacts').upsert({ user_id: userId, phone, name: phone, tags: next, last_contact: new Date().toISOString() }, { onConflict: 'user_id,phone' })
  } catch (e) { console.error('[executor] applyTag:', e.message) }
}

// ── Ponto de entrada ──────────────────────────────────────────────────────────

async function processMessage({ instanceRemoteId, fromJid, userText }) {
  const db = getClient()
  if (!db) { console.error('[executor] Supabase não configurado'); return }

  // Número limpo (usado como contact_phone e para envio)
  const phone = fromJid

  // 1. Busca instância
  const { data: inst } = await db.from('instances').select('*').eq('remote_id', instanceRemoteId).maybeSingle()
  if (!inst) { console.log('[executor] instância não encontrada:', instanceRemoteId); return }

  // 2. Sessão ativa
  const { data: session } = await db.from('flow_sessions').select('*')
    .eq('instance_id', inst.id).eq('contact_phone', phone).eq('status', 'active').maybeSingle()

  // 3. Busca fluxos ativos
  const { data: allFlows } = await db.from('flows').select('*').eq('user_id', inst.user_id).eq('status', 'active')
  const instFlows = (allFlows ?? []).filter(f => !f.instance_id || f.instance_id === inst.id)

  const txtLower = userText.toLowerCase()
  const keywordMatch = instFlows.find(f => {
    const kws = Array.isArray(f.keywords) ? f.keywords : []
    return kws.some(k => {
      const rawWord = (typeof k === 'string' ? k : k?.word ?? '').toLowerCase().trim()
      if (!rawWord) return false
      const exact = typeof k === 'object' && k?.mode === 'exact'
      // Suporta lista separada por vírgula dentro de um único item
      const words = rawWord.split(',').map(w => w.trim()).filter(Boolean)
      return words.some(word => exact ? txtLower === word : txtLower.includes(word))
    })
  })

  let flow = null
  if (keywordMatch) {
    flow = keywordMatch
    if (session && session.flow_id !== flow.id) {
      await db.from('flow_sessions').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('id', session.id)
    }
  } else if (session) {
    const { data: f } = await db.from('flows').select('*').eq('id', session.flow_id).maybeSingle()
    flow = f
  } else {
    flow = instFlows.find(f => !Array.isArray(f.keywords) || f.keywords.length === 0) ?? instFlows[0] ?? null
  }

  if (!flow) { console.log('[executor] nenhum fluxo ativo para:', phone); return }

  const useSession = (!keywordMatch || (session && session.flow_id === flow.id)) ? session : null

  const nodes = flow.nodes ?? []
  const edges = flow.edges ?? []
  let startId, variables = {}

  if (useSession?.current_node_id) {
    const cur = nodes.find(n => n.id === useSession.current_node_id)
    variables = { ...((useSession.variables) ?? {}), last_message: userText }

    if (cur?.type === 'question') {
      const ok = validateAnswer(cur.data?.validate, userText)
      if (!ok) {
        const invalidNext = nextNode(edges, useSession.current_node_id, 'opt:invalid')
        if (invalidNext) {
          variables.invalid_answer = userText
          const result = await runFlow({ nodes, edges, startId: invalidNext, instanceId: inst.remote_id, phone, variables, userId: inst.user_id })
          await updateSession(db, useSession, flow.id, result)
          return
        }
        const errMsg = cur.data?.validationError || 'Resposta inválida. Por favor, tente novamente.'
        await sendMsg(inst.remote_id, phone, errMsg)
        return
      }
      if (cur.data?.variable) variables[cur.data.variable] = userText
    }

    if (cur?.type === 'buttons') {
      const opts = Array.isArray(cur.data?.options) ? cur.data.options : []
      const idx = parseInt(userText, 10)
      variables.last_choice = !isNaN(idx) && opts[idx - 1] ? opts[idx - 1] : userText
    }

    const handle = pickHandle(cur, userText)
    const next = nextNode(edges, useSession.current_node_id, handle)
    if (!next) {
      await db.from('flow_sessions').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('id', useSession.id)
      return
    }
    startId = next
  } else {
    const start = nodes.find(n => n.type === 'start') ?? nodes[0]
    if (!start) return
    startId = start.id
    variables = { last_message: userText }
  }

  let result = await runFlow({ nodes, edges, startId, instanceId: inst.remote_id, phone, variables, userId: inst.user_id })

  // Cross-flow goto
  let activeFlowId = flow.id
  let safety = 0
  while (result.ended && result.variables.__goto_flow_id && safety < 5) {
    safety++
    const targetId = String(result.variables.__goto_flow_id)
    delete result.variables.__goto_flow_id
    const { data: nextFlow } = await db.from('flows').select('*').eq('id', targetId).maybeSingle()
    if (!nextFlow) break
    activeFlowId = nextFlow.id
    const ns = nextFlow.nodes ?? []
    const es = nextFlow.edges ?? []
    const startNode = ns.find(n => n.type === 'start') ?? ns[0]
    if (!startNode) break
    result = await runFlow({ nodes: ns, edges: es, startId: startNode.id, instanceId: inst.remote_id, phone, variables: result.variables, userId: inst.user_id })
  }

  await updateSession(db, useSession, activeFlowId, result, inst, phone)

  // Atualiza contato
  if (result.ended) {
    try {
      const name = String(result.variables.nome ?? result.variables.name ?? '').trim() || phone
      await db.from('contacts').upsert({ user_id: inst.user_id, phone, name, last_contact: new Date().toISOString() }, { onConflict: 'user_id,phone' })
    } catch { /* ignora */ }
  }
}

async function updateSession(db, session, flowId, result, inst, phone) {
  const updates = {
    status: result.ended ? 'ended' : 'active',
    current_node_id: result.ended ? null : result.stoppedAt,
    variables: result.variables,
    reminder_due_at: result.reminderDueAt ?? null,
    updated_at: new Date().toISOString(),
  }
  if (session) {
    await db.from('flow_sessions').update({ ...updates, flow_id: flowId }).eq('id', session.id)
  } else if (!result.ended && inst && phone) {
    await db.from('flow_sessions').insert({
      instance_id: inst.id, flow_id: flowId, contact_phone: phone, ...updates,
    })
  }
}

module.exports = { processMessage }
