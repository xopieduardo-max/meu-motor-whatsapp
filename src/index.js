require('dotenv').config()

const express = require('express')
const cors = require('cors')
const manager = require('./whatsapp/manager')
const instanceRoutes = require('./routes/instance')
const messageRoutes = require('./routes/message')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    name: 'Motor WhatsApp - Eduardo',
    timestamp: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Rotas
app.use('/instance', instanceRoutes)
app.use('/message', messageRoutes)

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`Motor WhatsApp rodando na porta ${PORT}`)
  console.log(`Supabase: ${process.env.SUPABASE_URL}`)

  // Reconectar instâncias salvas automaticamente
  try {
    await manager.iniciarTodasInstancias()
  } catch (err) {
    console.error('Erro ao iniciar instâncias:', err.message)
  }
})
