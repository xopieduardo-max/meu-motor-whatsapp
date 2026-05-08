const router = require('express').Router()

// POST /trigger — dispara o fluxo diretamente para um contato (sem passar pelo Lovable)
router.post('/', async (req, res) => {
  try {
    const { instanceRemoteId, fromJid, text = 'oi' } = req.body
    if (!instanceRemoteId || !fromJid) {
      return res.status(400).json({ error: 'instanceRemoteId e fromJid são obrigatórios' })
    }
    const { processMessage } = require('../flows/executor')
    res.json({ ok: true, message: 'Fluxo disparado' })
    processMessage({ instanceRemoteId, fromJid, userText: text })
      .catch(e => console.error('[trigger] erro:', e.message))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
