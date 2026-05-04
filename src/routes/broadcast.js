const router = require('express').Router()
const manager = require('../whatsapp/manager')
const { getClient } = require('../lib/app-supabase')

// POST /broadcast
router.post('/', async (req, res) => {
  try {
    const { instanceId, recipients, recipientNames = {}, message, mediaUrl, mediaType, flowId, delayMs = 2500, broadcastId } = req.body
    if (!instanceId || !Array.isArray(recipients) || recipients.length === 0)
      return res.status(400).json({ error: 'instanceId e recipients[] são obrigatórios' })
    if (!message && !mediaUrl && !flowId)
      return res.status(400).json({ error: 'Informe message, mediaUrl ou flowId' })

    const conn = manager.obterConexao(instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    const db = require('../lib/app-supabase').getClient()

    // Cria registros pendentes para cada destinatário
    if (broadcastId && db) {
      const rows = recipients.map(phone => ({
        broadcast_id: broadcastId,
        phone: String(phone),
        name: recipientNames[phone] || null,
        status: 'pending',
      }))
      // Insere em lotes de 50
      for (let i = 0; i < rows.length; i += 50) {
        await db.from('broadcast_recipients').insert(rows.slice(i, i + 50))
      }
    }

    res.json({ ok: true, total: recipients.length })

    ;(async () => {
      for (const to of recipients) {
        let success = false
        let errMsg = null
        try {
          if (flowId) {
            const { processMessage } = require('../flows/executor')
            await processMessage({ instanceRemoteId: instanceId, fromJid: to, userText: '' })
          } else if (mediaType === 'image' && mediaUrl) {
            await conn.enviarImagem(to, mediaUrl, message || '')
          } else if (mediaType === 'audio' && mediaUrl) {
            await conn.enviarAudio(to, mediaUrl)
          } else if (mediaType === 'pdf' && mediaUrl) {
            await conn.enviarPDF(to, mediaUrl)
          } else if (message) {
            await conn.enviarTexto(to, message)
          }
          success = true
        } catch (e) {
          errMsg = e.message
          console.error(`[broadcast] Erro em ${to}:`, e.message)
        }

        // Atualiza status individual
        if (broadcastId && db) {
          await db.from('broadcast_recipients')
            .update({ status: success ? 'sent' : 'failed', error: errMsg, sent_at: success ? new Date().toISOString() : null })
            .eq('broadcast_id', broadcastId).eq('phone', String(to)).eq('status', 'pending')
        }

        await new Promise(r => setTimeout(r, delayMs))
      }

      // Atualiza status do broadcast principal
      if (broadcastId && db) {
        const { data: stats } = await db.from('broadcast_recipients')
          .select('status').eq('broadcast_id', broadcastId)
        const all = stats ?? []
        const failed = all.filter(r => r.status === 'failed').length
        await db.from('broadcasts').update({
          status: failed === 0 ? 'completed' : failed === all.length ? 'failed' : 'partial'
        }).eq('id', broadcastId)
      }
      console.log(`[broadcast ${broadcastId}] Concluído`)
    })()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /broadcast/resend/:broadcastId — reenvia só os que falharam
router.post('/resend/:broadcastId', async (req, res) => {
  try {
    const { broadcastId } = req.params
    const { instanceId, message } = req.body // recebe dados do frontend
    const db = require('../lib/app-supabase').getClient()
    if (!db) return res.status(500).json({ error: 'Supabase não configurado' })

    if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório' })

    const conn = manager.obterConexao(instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    // Busca destinatários que falharam
    const { data: failed } = await db.from('broadcast_recipients')
      .select('*').eq('broadcast_id', broadcastId).eq('status', 'failed')
    if (!failed?.length) return res.json({ ok: true, resending: 0, message: 'Nenhuma falha para reenviar' })

    res.json({ ok: true, resending: failed.length })

    // Marca como pending antes de reenviar
    await db.from('broadcast_recipients')
      .update({ status: 'pending', error: null })
      .eq('broadcast_id', broadcastId).eq('status', 'failed')

    ;(async () => {
      for (const r of failed) {
        let success = false; let errMsg = null
        try {
          if (message) await conn.enviarTexto(r.phone, message)
          success = true
        } catch (e) { errMsg = e.message }
        await db.from('broadcast_recipients')
          .update({ status: success ? 'sent' : 'failed', error: errMsg, sent_at: success ? new Date().toISOString() : null })
          .eq('id', r.id)
        await new Promise(resolve => setTimeout(resolve, 2500))
      }
      // Atualiza status do broadcast
      const { data: all } = await db.from('broadcast_recipients').select('status').eq('broadcast_id', broadcastId)
      const remaining = (all ?? []).filter(r => r.status === 'failed').length
      if (remaining === 0) {
        await db.from('broadcasts').update({ status: 'completed' }).eq('id', broadcastId)
      }
    })()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /broadcast/contacts?tag=leads&segment=frios|compradores
router.get('/contacts', async (req, res) => {
  try {
    const { tag, segment, userId } = req.query
    const db = getClient()
    if (!db) return res.status(500).json({ error: 'Supabase não configurado' })

    let query = db.from('contacts').select('id, name, phone, tags, last_contact')
    if (userId) query = query.eq('user_id', userId)

    if (tag) {
      query = query.contains('tags', [tag])
    } else if (segment === 'frios') {
      // Sem contato há mais de 7 dias
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      query = query.or(`last_contact.lt.${cutoff},last_contact.is.null`)
    } else if (segment === 'compradores') {
      // Têm etiqueta com "compra" ou "cliente"
      query = query.or('tags.cs.{compra_confirmada},tags.cs.{cliente},tags.cs.{comprador}')
    }

    const { data, error } = await query.order('name').limit(1000)
    if (error) return res.status(500).json({ error: error.message })

    res.json({ contacts: data ?? [], total: (data ?? []).length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
