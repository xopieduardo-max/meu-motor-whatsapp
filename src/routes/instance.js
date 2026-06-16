const router = require('express').Router()
const supabase = require('../lib/supabase')
const manager = require('../whatsapp/manager')

// Listar todas as instâncias
router.get('/', async (req, res) => {
  try {
    const { data } = await supabase.from('instances').select('*').order('created_at', { ascending: false })
    const ativas = manager.listarConexoes()

    const resultado = (data || []).map(inst => {
      const ativa = ativas.find(c => c.id === inst.id)
      return {
        ...inst,
        status: ativa?.status || inst.status,
        qr: ativa?.qr || null
      }
    })

    res.json({ instances: resultado })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Criar nova instância
router.post('/create', async (req, res) => {
  try {
    const { name } = req.body
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' })

    const { data, error } = await supabase
      .from('instances').insert({ name, status: 'connecting' }).select().single()

    if (error) throw error

    await manager.conectarInstancia(data.id, data.name)

    res.json({ success: true, instance: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Obter QR Code de uma instância
router.get('/:id/qr', async (req, res) => {
  try {
    const conn = manager.obterConexao(req.params.id)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    res.json({
      instanceId: req.params.id,
      status: conn.status,
      qr: conn.qrBase64
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Status de uma instância
router.get('/:id/status', async (req, res) => {
  try {
    const conn = manager.obterConexao(req.params.id)
    const { data } = await supabase.from('instances').select('*').eq('id', req.params.id).single()

    res.json({
      instanceId: req.params.id,
      name: data?.name,
      status: conn?.status || data?.status || 'disconnected',
      phone: data?.phone
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reconectar instância
router.post('/:id/reconnect', async (req, res) => {
  try {
    const { data } = await supabase.from('instances').select('*').eq('id', req.params.id).single()
    if (!data) return res.status(404).json({ error: 'Instância não encontrada' })

    await manager.conectarInstancia(data.id, data.name)
    res.json({ success: true, message: 'Reconectando...' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Foto de perfil de um contato
router.get('/:id/profile-pic', async (req, res) => {
  try {
    const conn = manager.obterConexao(req.params.id)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })
    if (!conn.socket) return res.status(400).json({ error: 'WhatsApp não está conectado' })
    const phone = req.query.phone || ''
    const jid = String(phone).replace(/@.*$/, '').replace(/\D/g, '') + '@s.whatsapp.net'
    const url = await conn.socket.profilePictureUrl(jid, 'image').catch(() => null)
    res.json({ url })
  } catch (err) {
    res.json({ url: null })
  }
})

// Buscar e salvar chats recentes no inbox da plataforma
router.post('/:id/sync-inbox', async (req, res) => {
  try {
    const conn = manager.obterConexao(req.params.id)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })
    const socket = conn.socket
    if (!socket) return res.status(400).json({ error: 'WhatsApp não conectado' })

    // Solicita histórico de mensagens recentes
    const chats = await socket.groupFetchAllParticipating().catch(() => ({}))
    // Para conversas individuais, usa o store de chats (se disponível)
    let count = 0
    // Vai sincronizar quando o evento messaging-history.set disparar
    // Por enquanto retorna ok
    res.json({ ok: true, message: 'Sync solicitado. As mensagens aparecerão em alguns segundos.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Listar grupos do WhatsApp com foto de perfil
router.get('/:id/groups', async (req, res) => {
  try {
    const conn = manager.obterConexao(req.params.id)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })
    if (!conn.socket) return res.status(400).json({ error: 'WhatsApp não está conectado' })
    const raw = await conn.socket.groupFetchAllParticipating()
    const entries = Object.entries(raw || {})

    // Busca fotos em paralelo (ignora erros)
    const groups = await Promise.all(entries.map(async ([jid, g]) => {
      let photo = null
      try { photo = await conn.socket.profilePictureUrl(jid, 'image') } catch {}
      return {
        id: jid,
        name: g.subject || jid,
        participants: Array.isArray(g.participants) ? g.participants.length : 0,
        photo,
      }
    }))

    res.json({ groups: groups.sort((a, b) => a.name.localeCompare(b.name)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Deletar instância
router.delete('/:id', async (req, res) => {
  try {
    manager.removerConexao(req.params.id)
    await supabase.from('instances').delete().eq('id', req.params.id)
    res.json({ success: true, message: 'Instância removida' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
