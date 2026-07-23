const { getClient } = require('../lib/app-supabase')

// Job que dispara broadcasts agendados cujo scheduled_at já passou.
// Roda a cada 60s — mesma cadência do job de lembretes.

async function processScheduledBroadcasts() {
  const db = getClient()
  if (!db) return

  try {
    const { data: scheduled } = await db
      .from('broadcasts')
      .select('*')
      .eq('status', 'scheduled')
      .lt('scheduled_at', new Date().toISOString())
      .limit(10)

    if (!scheduled?.length) return
    console.log(`[scheduler] ${scheduled.length} disparo(s) agendado(s) prontos para executar`)

    const manager = require('../whatsapp/manager')

    for (const brd of scheduled) {
      try {
        // Marca como "pending" para não processar duas vezes em caso de reinício
        await db.from('broadcasts').update({ status: 'pending' }).eq('id', brd.id)

        const payload   = brd.payload ?? {}
        const recipients = Array.isArray(brd.recipients_phones) ? brd.recipients_phones : []

        if (recipients.length === 0) {
          console.warn(`[scheduler] Broadcast ${brd.id} sem destinatários salvos`)
          await db.from('broadcasts').update({ status: 'failed' }).eq('id', brd.id)
          continue
        }

        // Busca nome do contato para personalização
        const { data: contactRows } = await db
          .from('contacts')
          .select('phone, name')
          .in('phone', recipients.slice(0, 500))
        const nameMap = {}
        for (const c of (contactRows ?? [])) nameMap[c.phone] = c.name

        // Busca a instância
        const { data: inst } = await db.from('instances').select('remote_id').eq('id', brd.instance_id).maybeSingle()
        const instanceId = inst?.remote_id || brd.instance_id
        const conn = manager.obterConexao(instanceId)

        if (!conn || conn.status !== 'connected') {
          console.warn(`[scheduler] Instância ${instanceId} offline — reagendando em 15min`)
          const newTime = new Date(Date.now() + 15 * 60_000).toISOString()
          await db.from('broadcasts').update({ status: 'scheduled', scheduled_at: newTime }).eq('id', brd.id)
          continue
        }

        const delayMs = payload.delayMs ?? 2500
        const { processMessage } = require('./executor')

        let sent = 0; let failed = 0
        for (const phone of recipients) {
          try {
            const vars = { nome: nameMap[phone] || '', primeiro_nome: (nameMap[phone] || '').split(' ')[0] || '' }
            const interpolate = (text) => String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''))

            if (payload.flowId) {
              await processMessage({ instanceRemoteId: instanceId, fromJid: phone, userText: '' })
            } else if (payload.contentType === 'image' && payload.mediaUrl) {
              await conn.enviarImagem(phone, payload.mediaUrl, interpolate(payload.message) || '')
            } else if (payload.contentType === 'audio' && payload.mediaUrl) {
              await conn.enviarAudio(phone, payload.mediaUrl)
            } else if (payload.contentType === 'pdf' && payload.mediaUrl) {
              await conn.enviarPDF(phone, payload.mediaUrl)
            } else if (payload.message) {
              await conn.enviarTexto(phone, interpolate(payload.message))
            }

            await db.from('broadcast_recipients')
              .update({ status: 'sent', sent_at: new Date().toISOString() })
              .eq('broadcast_id', brd.id).eq('phone', phone).eq('status', 'pending')
            sent++
          } catch (e) {
            await db.from('broadcast_recipients')
              .update({ status: 'failed', error: e.message })
              .eq('broadcast_id', brd.id).eq('phone', phone).eq('status', 'pending')
            failed++
          }

          await new Promise(r => setTimeout(r, delayMs))
        }

        const finalStatus = failed === 0 ? 'completed' : failed === recipients.length ? 'failed' : 'partial'
        await db.from('broadcasts').update({ status: finalStatus }).eq('id', brd.id)
        console.log(`[scheduler] Broadcast ${brd.id} concluído — ${sent} enviados, ${failed} falharam`)
      } catch (e) {
        console.error(`[scheduler] Erro no broadcast ${brd.id}:`, e.message)
        await db.from('broadcasts').update({ status: 'failed' }).eq('id', brd.id)
      }
    }
  } catch (e) {
    console.error('[scheduler] Erro geral:', e.message)
  }
}

function iniciarJobAgendados() {
  console.log('[scheduler] Job de disparos agendados iniciado (intervalo: 60s)')
  setInterval(processScheduledBroadcasts, 60 * 1000)
}

module.exports = { iniciarJobAgendados }
