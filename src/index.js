require('dotenv').config()

// Validação de variáveis obrigatórias antes de iniciar
const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const missing = REQUIRED_VARS.filter(v => !process.env[v])
if (missing.length > 0) {
  console.error(`[startup] Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}`)
  process.exit(1)
}

// Handler global para promises não capturadas
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] Promise rejeitada sem .catch():', reason)
})

const express = require('express')
const cors = require('cors')
const manager = require('./whatsapp/manager')
const instanceRoutes = require('./routes/instance')
const messageRoutes = require('./routes/message')
const broadcastRoutes = require('./routes/broadcast')
const triggerRoutes = require('./routes/trigger')
const { iniciarJobLembretes } = require('./flows/reminder')
const { requireApiKey } = require('./middleware/auth')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Health check público
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    name: 'Motor WhatsApp',
    version: '3.1.2',
    webhook_configured: !!process.env.WEBHOOK_URL,
    timestamp: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Rotas protegidas por API key
app.use('/instance', requireApiKey, instanceRoutes)
app.use('/message', requireApiKey, messageRoutes)
app.use('/broadcast', requireApiKey, broadcastRoutes)
app.use('/trigger', requireApiKey, triggerRoutes)

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`Motor WhatsApp rodando na porta ${PORT}`)
  console.log(`Supabase configurado: ${!!process.env.SUPABASE_URL}`)
  console.log(`Webhook configurado: ${!!process.env.WEBHOOK_URL}`)

  try {
    await manager.iniciarTodasInstancias()
  } catch (err) {
    console.error('Erro ao iniciar instâncias:', err.message)
  }

  iniciarJobLembretes()
})
