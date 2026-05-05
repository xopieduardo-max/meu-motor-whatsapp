require('dotenv').config()

const express = require('express')
const cors = require('cors')
const manager = require('./whatsapp/manager')
const instanceRoutes = require('./routes/instance')
const messageRoutes = require('./routes/message')
const broadcastRoutes = require('./routes/broadcast')
const { iniciarJobLembretes } = require('./flows/reminder')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Log de mensagens recebidas (para debug)
const debugLog = []
global.addDebugLog = (entry) => {
  debugLog.unshift({ ...entry, ts: new Date().toISOString() })
  if (debugLog.length > 20) debugLog.pop()
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    name: 'Motor WhatsApp - Eduardo',
    version: '2.9.0',
    webhook_configured: !!process.env.WEBHOOK_URL,
    webhook_url: process.env.WEBHOOK_URL || null,
    timestamp: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Debug: mostra últimas mensagens recebidas e status do webhook
app.get('/debug', (req, res) => {
  res.json({
    webhook_url: process.env.WEBHOOK_URL || 'NÃO CONFIGURADO',
    app_supabase_url: process.env.APP_SUPABASE_URL ? process.env.APP_SUPABASE_URL.slice(0, 40) + '...' : 'NÃO CONFIGURADO',
    app_supabase_key: process.env.APP_SUPABASE_ANON_KEY ? 'OK (' + process.env.APP_SUPABASE_ANON_KEY.slice(0, 20) + '...)' : 'NÃO CONFIGURADO',
    instances_in_memory: manager.listarConexoes().map(c => ({
      id: c.id, name: c.name, status: c.status
    })),
    last_events: debugLog
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Rotas
app.use('/instance', instanceRoutes)
app.use('/message', messageRoutes)
app.use('/broadcast', broadcastRoutes)

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`Motor WhatsApp rodando na porta ${PORT}`)
  console.log(`Supabase: ${process.env.SUPABASE_URL}`)
  console.log(`Webhook URL: ${process.env.WEBHOOK_URL || 'NÃO CONFIGURADO'}`)

  // Reconectar instâncias salvas automaticamente
  try {
    await manager.iniciarTodasInstancias()
  } catch (err) {
    console.error('Erro ao iniciar instâncias:', err.message)
  }

  // Job de lembretes automáticos
  iniciarJobLembretes()
})
