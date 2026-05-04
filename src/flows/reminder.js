const { getClient } = require('../lib/app-supabase')

// Roda a cada 60 segundos: envia lembretes para leads que pararam no meio do fluxo
async function processReminders() {
  const db = getClient()
  if (!db) return

  try {
    // Sessões ativas com lembrete pendente
    const { data: sessions } = await db
      .from('flow_sessions')
      .select('*, instances(remote_id, user_id)')
      .eq('status', 'active')
      .not('reminder_due_at', 'is', null)
      .lt('reminder_due_at', new Date().toISOString())

    if (!sessions?.length) return
    console.log(`[reminder] ${sessions.length} sessão(ões) com lembrete pendente`)

    const manager = require('../whatsapp/manager')

    for (const session of sessions) {
      try {
        const remoteId = session.instances?.remote_id
        if (!remoteId) continue

        const conn = manager.obterConexao(remoteId)
        if (!conn || conn.status !== 'connected') continue

        // Busca a mensagem de lembrete do nó atual no fluxo
        const { data: flow } = await db.from('flows').select('nodes').eq('id', session.flow_id).maybeSingle()
        const nodes = flow?.nodes ?? []
        const currentNode = nodes.find(n => n.id === session.current_node_id)
        const timeoutMsg = currentNode?.data?.timeoutMessage ||
          `Oi! Vejo que você parou aqui. Quando quiser continuar, é só me mandar uma mensagem! 😊`

        await conn.enviarTexto(session.contact_phone, timeoutMsg)

        const remindersEnviados = (session.reminders_sent || 0) + 1
        const maxReminders = 2

        await db.from('flow_sessions').update({
          reminders_sent: remindersEnviados,
          // Após max lembretes, encerra a sessão
          status: remindersEnviados >= maxReminders ? 'ended' : 'active',
          // Próximo lembrete em 2h (só se ainda não atingiu o max)
          reminder_due_at: remindersEnviados >= maxReminders
            ? null
            : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', session.id)

        console.log(`[reminder] Lembrete #${remindersEnviados} enviado para ${session.contact_phone}`)
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
