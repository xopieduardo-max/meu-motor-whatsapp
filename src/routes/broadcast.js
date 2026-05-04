const router = require('express').Router()
const manager = require('../whatsapp/manager')
const { getClient } = require('../lib/app-supabase')
const { processMessage } = require('../flows/executor')

// POST /broadcast
// Body: { instanceId, contacts: ["phone1", "phone2"], message } (mensagem simples)
//    OU { instanceId, contacts: ["phone1"], flowId }            (dispara um fluxo)
router.post('/', async (req, res) => {
  try {
    const { instanceId, contacts, message, flowId, delayMs = 2000 } = req.body

    if (!instanceId || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'instanceId e contacts[] são obrigatórios' })
    }
    if (!message && !flowId) {
      return res.status(400).json({ error: 'Informe message (texto) ou flowId (fluxo)' })
    }

    const conn = manager.obterConexao(instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    res.json({ ok: true, total: contacts.length, message: 'Disparo iniciado em background' })

    // Executa em background com delay entre cada contato
    ;(async () => {
      let enviados = 0, erros = 0
      for (const phone of contacts) {
        try {
          if (flowId) {
            // Dispara o fluxo para esse contato
            const db = getClient()
            const { data: flow } = await db.from('flows').select('*').eq('id', flowId).maybeSingle()
            if (!flow) { erros++; continue }
            const nodes = flow.nodes ?? []
            const start = nodes.find(n => n.type === 'start') ?? nodes[0]
            if (!start) { erros++; continue }
            // Encerra sessão anterior se houver
            await db.from('flow_sessions')
              .update({ status: 'ended' })
              .eq('contact_phone', phone)
              .eq('status', 'active')
            // Executa o fluxo
            await processMessage({ instanceRemoteId: instanceId, fromJid: phone, userText: '' })
          } else {
            await conn.enviarTexto(phone, message)
          }
          enviados++
        } catch (e) {
          console.error(`[broadcast] Erro ao enviar para ${phone}:`, e.message)
          erros++
        }
        // Delay entre mensagens para evitar ban
        await new Promise(r => setTimeout(r, delayMs))
      }
      console.log(`[broadcast] Concluído: ${enviados} enviados, ${erros} erros`)
    })()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /broadcast/contacts?tag=leads&userId=xxx
// Lista contatos para disparar
router.get('/contacts', async (req, res) => {
  try {
    const { tag, userId } = req.query
    const db = getClient()
    if (!db) return res.status(500).json({ error: 'Supabase não configurado' })

    let query = db.from('contacts').select('id, name, phone, tags')
    if (userId) query = query.eq('user_id', userId)
    if (tag) query = query.contains('tags', [tag])

    const { data, error } = await query.order('created_at', { ascending: false }).limit(500)
    if (error) return res.status(500).json({ error: error.message })

    res.json({ contacts: data ?? [], total: (data ?? []).length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
