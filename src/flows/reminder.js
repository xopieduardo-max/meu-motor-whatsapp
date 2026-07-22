const { getClient } = require('../lib/app-supabase')

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeReminders(d) {
  const arr = Array.isArray(d?.reminders) && d.reminders.length > 0 ? d.reminders : null
  if (arr) return arr.map(r => ({ minutes: Math.max(1, Number(r?.minutes) || 30), text: String(r?.text ?? '') }))
  // legado: timeoutMinutes + reminderText
  const count = Math.max(1, Number(d?.maxReminders) || 1)
  const minutes = Math.max(1, Number(d?.timeoutMinutes) || 30)
  return Array.from({ length: count }, () => ({ minutes, text: String(d?.reminderText ?? '') }))
}

// Quantos lembretes enviar antes de acionar o timeout
function continueAfterCount(d, remindersLen) {
  const v = Number(d?.continueAfterReminder)
  if (!v || v <= 0) return remindersLen // 0 = "só depois de todos"
  return Math.min(v, remindersLen)
}

// ── Avança o fluxo pelo caminho "Sem resposta (timeout)" ─────────────────────

async function advanceFlowTimeout(session, flow, db) {
  const edges = flow.edges ?? []
  const nodes = flow.nodes ?? []
  const nextNodeId = edges.find(
    e => e.source === session.current_node_id && e.sourceHandle === 'opt:timeout'
  )?.target

  if (!nextNodeId) {
    console.log(`[reminder] Sem conexão "opt:timeout" → encerra sessão ${session.id}`)
    await db.from('flow_sessions').update({
      status: 'ended', reminder_due_at: null, updated_at: new Date().toISOString(),
    }).eq('id', session.id)
    return
  }

  const remoteId = session.instances?.remote_id
  const userId   = session.instances?.user_id
  console.log(`[reminder] Avançando fluxo via opt:timeout → node=${nextNodeId} phone=${session.contact_phone}`)

  try {
    const { runFlow, updateSession } = require('./executor')
    const result = await runFlow({
      nodes, edges,
      startId: nextNodeId,
      instanceId: remoteId,
      phone: session.contact_phone,
      variables: session.variables ?? {},
      userId,
      assistantId: null,
    })

    // Recicla o objeto "inst" mínimo que updateSession precisa
    const instLike = { id: session.instance_id, user_id: userId, remote_id: remoteId }
    await updateSession(db, session, session.flow_id, result, instLike, session.contact_phone)
    console.log(`[reminder] Fluxo avançado com sucesso — ended=${result.ended}`)
  } catch (e) {
    console.error(`[reminder] Erro ao avançar fluxo:`, e.message)
    await db.from('flow_sessions').update({
      status: 'ended', reminder_due_at: null, updated_at: new Date().toISOString(),
    }).eq('id', session.id)
  }
}

// ── Job principal ─────────────────────────────────────────────────────────────

async function processReminders() {
  const db = getClient()
  if (!db) return

  try {
    const { data: sessions } = await db
      .from('flow_sessions')
      .select('*, instances(remote_id, user_id, assistant_id)')
      .eq('status', 'active')
      .not('reminder_due_at', 'is', null)
      .lt('reminder_due_at', new Date().toISOString())
      .limit(50)

    if (!sessions?.length) return
    console.log(`[reminder] ${sessions.length} sessão(ões) com lembrete pendente`)

    const manager = require('../whatsapp/manager')

    for (const session of sessions) {
      try {
        const remoteId = session.instances?.remote_id
        if (!remoteId) continue

        const conn = manager.obterConexao(remoteId)
        if (!conn || conn.status !== 'connected') {
          console.log(`[reminder] Instância ${remoteId} offline, pulando`)
          continue
        }

        // Carrega o fluxo e o nó atual
        const { data: flow } = await db.from('flows').select('nodes, edges').eq('id', session.flow_id).maybeSingle()
        const nodes = flow?.nodes ?? []
        const currentNode = nodes.find(n => n.id === session.current_node_id)
        const d = currentNode?.data ?? {}

        const reminders     = normalizeReminders(d)
        const triggerAt     = continueAfterCount(d, reminders.length)
        const graceMinutes  = Number(d?.reminderGraceMinutes ?? 2)
        const autoAdvance   = !!d?.autoAdvanceAfterTimeout
        const sentCount     = session.reminders_sent || 0

        // ── Estado: ainda tem lembrete para enviar ─────────────────────────
        if (sentCount < triggerAt) {
          const rem  = reminders[sentCount] ?? reminders[reminders.length - 1]
          const text = rem.text?.trim() || 'Oi! Ainda está aí? 😊'

          await conn.enviarTexto(session.contact_phone, text)
          const newSent = sentCount + 1
          console.log(`[reminder] Lembrete #${newSent}/${triggerAt} → ${session.contact_phone}: "${text.slice(0, 40)}"`)

          let nextDueAt = null
          let nextStatus = 'active'

          if (newSent < triggerAt) {
            // Tem mais lembretes
            const nextMin = (reminders[newSent] ?? rem).minutes
            nextDueAt = new Date(Date.now() + nextMin * 60_000).toISOString()
          } else {
            // Último lembrete enviado → agenda período de graça se auto-avanço estiver ativo
            if (autoAdvance) {
              nextDueAt = new Date(Date.now() + graceMinutes * 60_000).toISOString()
            } else {
              // Sem auto-avanço: encerra a sessão após todos os lembretes
              nextStatus = 'ended'
            }
          }

          await db.from('flow_sessions').update({
            reminders_sent: newSent,
            status: nextStatus,
            reminder_due_at: nextDueAt,
            updated_at: new Date().toISOString(),
          }).eq('id', session.id)

          continue
        }

        // ── Estado: lembretes esgotados + período de graça expirou ────────
        if (autoAdvance) {
          await advanceFlowTimeout(session, flow, db)
        } else {
          console.log(`[reminder] Sem auto-avanço configurado → encerra sessão ${session.id}`)
          await db.from('flow_sessions').update({
            status: 'ended', reminder_due_at: null, updated_at: new Date().toISOString(),
          }).eq('id', session.id)
        }

      } catch (e) {
        console.error(`[reminder] Erro na sessão ${session.id}:`, e.message)
      }
    }
  } catch (e) {
    console.error('[reminder] Erro geral:', e.message)
  }
}

function iniciarJobLembretes() {
  console.log('[reminder] Job de lembretes iniciado (intervalo: 60s)')
  setInterval(processReminders, 60 * 1000)
}

module.exports = { iniciarJobLembretes }
