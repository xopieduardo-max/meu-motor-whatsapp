const router = require('express').Router()
const manager = require('../whatsapp/manager')

// Enviar texto
router.post('/:instanceId/text', async (req, res) => {
  try {
    const { number, text } = req.body
    if (!number || !text) return res.status(400).json({ error: 'number e text são obrigatórios' })

    const conn = manager.obterConexao(req.params.instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    await conn.enviarTexto(number, text)
    res.json({ success: true, message: 'Texto enviado' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar imagem
router.post('/:instanceId/image', async (req, res) => {
  try {
    const { number, url, caption } = req.body
    if (!number || !url) return res.status(400).json({ error: 'number e url são obrigatórios' })

    const conn = manager.obterConexao(req.params.instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    await conn.enviarImagem(number, url, caption || '')
    res.json({ success: true, message: 'Imagem enviada' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar áudio
router.post('/:instanceId/audio', async (req, res) => {
  try {
    const { number, url } = req.body
    if (!number || !url) return res.status(400).json({ error: 'number e url são obrigatórios' })

    const conn = manager.obterConexao(req.params.instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    await conn.enviarAudio(number, url)
    res.json({ success: true, message: 'Áudio enviado' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar PDF
router.post('/:instanceId/pdf', async (req, res) => {
  try {
    const { number, url, filename } = req.body
    if (!number || !url) return res.status(400).json({ error: 'number e url são obrigatórios' })

    const conn = manager.obterConexao(req.params.instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    await conn.enviarPDF(number, url, filename || 'documento.pdf')
    res.json({ success: true, message: 'PDF enviado' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Enviar sequência de mensagens com delay (o funil completo)
router.post('/:instanceId/flow', async (req, res) => {
  try {
    const { number, messages } = req.body
    if (!number || !messages?.length) {
      return res.status(400).json({ error: 'number e messages são obrigatórios' })
    }

    const conn = manager.obterConexao(req.params.instanceId)
    if (!conn) return res.status(404).json({ error: 'Instância não encontrada' })

    // Responde imediatamente e processa em background
    res.json({ success: true, message: `Iniciando envio de ${messages.length} mensagens...` })

    // Processa o fluxo em background com delays
    ;(async () => {
      for (const msg of messages) {
        try {
          if (msg.delay) {
            await new Promise(r => setTimeout(r, msg.delay * 1000))
          }

          switch (msg.type) {
            case 'text':
              await conn.enviarTexto(number, msg.content)
              break
            case 'image':
              await conn.enviarImagem(number, msg.url, msg.caption || '')
              break
            case 'audio':
              await conn.enviarAudio(number, msg.url)
              break
            case 'pdf':
              await conn.enviarPDF(number, msg.url, msg.filename || 'documento.pdf')
              break
          }

          console.log(`[Flow] Mensagem ${msg.type} enviada para ${number}`)
        } catch (err) {
          console.error(`[Flow] Erro ao enviar mensagem:`, err.message)
        }
      }
      console.log(`[Flow] Fluxo completo para ${number}`)
    })()

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
