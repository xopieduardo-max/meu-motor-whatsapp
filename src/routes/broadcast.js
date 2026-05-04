const router = require('express').Router()
const manager = require('../whatsapp/manager')
const { getClient } = require('../lib/app-supabase')

// POST /broadcast
// Suporta: text, image, audio, pdf, flow — para contatos e grupos
router.post('/', async (req, res) => {
  try {
    const { instanceId, recipients, message, mediaUrl, mediaType, flowId, delayMs = 2500 } = req.body
    // recipients: array de strings (phones ou group JIDs)
    if (!instanceId || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'instanceId e recipients[] são obrigatórios' })
    }
    if (!message && !mediaUrl && !flowId) {
      return res.status(400).json({ error: 'Informe message, mediaUrl ou flowId' })
    }

    const conn = manager.obterConexao(instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    res.json({ ok: true, total: recipients.length, message: 'Disparo iniciado em background' })

    ;(async () => {
      let enviados = 0, erros = 0
      for (const to of recipients) {
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
          enviados++
        } catch (e) {
          console.error(`[broadcast] Erro ao enviar para ${to}:`, e.message)
          erros++
        }
        await new Promise(r => setTimeout(r, delayMs))
      }
      console.log(`[broadcast] Concluído: ${enviados} enviados, ${erros} erros`)
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
