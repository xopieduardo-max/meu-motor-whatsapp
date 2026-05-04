const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const pino = require('pino')
const supabase = require('../lib/supabase')
const { useSupabaseAuthState } = require('./authState')
const { processMessage } = require('../flows/executor')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const { Readable, PassThrough } = require('stream')
ffmpeg.setFfmpegPath(ffmpegPath)

async function converterParaOgg(buffer) {
  return new Promise((resolve, reject) => {
    const input = new Readable()
    input.push(buffer)
    input.push(null)
    const output = new PassThrough()
    const chunks = []
    output.on('data', d => chunks.push(d))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    ffmpeg(input)
      .inputFormat('mp3')
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(48000)
      .format('ogg')
      .on('error', reject)
      .pipe(output, { end: true })
  })
}

class WAConnection {
  constructor(instanceId, instanceName) {
    this.instanceId = instanceId
    this.instanceName = instanceName
    this.socket = null
    this.qrBase64 = null
    this.status = 'disconnected'
    // Mapeamento de número limpo → JID completo (ex: "112352116666619" → "112352116666619@lid")
    this._jidCache = {}
  }

  async connect() {
    try {
      const { state, saveCreds } = await useSupabaseAuthState(this.instanceId)
      const { version } = await fetchLatestBaileysVersion()

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
      })

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          this.qrBase64 = await QRCode.toDataURL(qr)
          this.status = 'qr'
          await this._salvarStatus('qr')
          console.log(`[${this.instanceName}] QR Code gerado`)
        }

        if (connection === 'close') {
          const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode
          const deslogado = codigo === DisconnectReason.loggedOut

          this.status = 'disconnected'
          this.qrBase64 = null
          await this._salvarStatus('disconnected')
          console.log(`[${this.instanceName}] Desconectado. Código: ${codigo}`)

          if (!deslogado) {
            console.log(`[${this.instanceName}] Reconectando em 3s...`)
            setTimeout(() => this.connect(), 3000)
          } else {
            console.log(`[${this.instanceName}] Deslogado permanentemente.`)
            await this._limparCredenciais()
          }
        }

        if (connection === 'open') {
          this.qrBase64 = null
          this.status = 'connected'
          const phone = this.socket.user?.id?.split(':')[0] || null
          await this._salvarStatus('connected', phone)
          console.log(`[${this.instanceName}] Conectado! Número: ${phone}`)
        }
      })

      this.socket.ev.on('creds.update', saveCreds)

      // Encaminha mensagens recebidas para o webhook configurado
      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`[${this.instanceName}] messages.upsert tipo=${type} qtd=${messages.length}`)

        const webhookUrl = process.env.WEBHOOK_URL
        if (typeof global.addDebugLog === 'function') {
          global.addDebugLog({ event: 'messages.upsert', instance: this.instanceName, type, count: messages.length, webhookUrl: webhookUrl || null })
        }

        if (type !== 'notify') return
        if (!webhookUrl) {
          console.warn(`[${this.instanceName}] WEBHOOK_URL não configurado — mensagem ignorada`)
          return
        }

        for (const msg of messages) {
          // Loga o remoteJid bruto para diagnóstico
          const rawJid = msg.key.remoteJid || ''
          console.log(`[${this.instanceName}] rawJid=${rawJid} fromMe=${msg.key.fromMe}`)
          if (typeof global.addDebugLog === 'function') {
            global.addDebugLog({ event: 'raw_message', instance: this.instanceName, rawJid, fromMe: msg.key.fromMe, msgType: Object.keys(msg.message || {}).join(',') })
          }

          // Ignora grupos, broadcasts e status
          if (rawJid.endsWith('@g.us') || rawJid.endsWith('@broadcast') || rawJid === 'status@broadcast') continue
          if (msg.key.fromMe) continue // ignora mensagens enviadas pelo bot

          const from = rawJid.replace(/@.*$/, '').replace(/:\d+$/, '') // remove sufixo de dispositivo
          if (!from) continue

          // Guarda mapeamento número → JID completo para uso no envio
          this._jidCache[from] = rawJid

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            ''

          const payload = {
            instanceId: this.instanceId,
            from: rawJid,   // JID completo: "5543xxx@s.whatsapp.net" ou "xxx@lid"
            fromPhone: from, // número limpo (sem sufixo)
            message: { text },
            fromMe: false,
            pushName: msg.pushName || '',
            timestamp: msg.messageTimestamp,
          }

          console.log(`[${this.instanceName}] Processando mensagem → from=${rawJid} text="${text}"`)
          if (typeof global.addDebugLog === 'function') {
            global.addDebugLog({ event: 'processing', instance: this.instanceName, fromJid: rawJid, text })
          }

          // Executa o fluxo diretamente (sem depender do Lovable)
          processMessage({
            instanceRemoteId: this.instanceId,
            fromJid: rawJid,
            userText: text,
          }).then(() => {
            if (typeof global.addDebugLog === 'function') {
              global.addDebugLog({ event: 'flow_done', instance: this.instanceName, fromJid: rawJid })
            }
          }).catch(err => {
            console.error(`[${this.instanceName}] Erro no executor:`, err.message)
            if (typeof global.addDebugLog === 'function') {
              global.addDebugLog({ event: 'flow_error', instance: this.instanceName, error: err.message })
            }
          })
        }
      })

    } catch (err) {
      console.error(`[${this.instanceName}] Erro ao conectar:`, err.message)
      this.status = 'error'
      await this._salvarStatus('error')
    }
  }

  async enviarTexto(numero, texto) {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    console.log(`[${this.instanceName}] ENVIAR → jid=${jid} texto="${texto.slice(0,50)}"`)
    if (typeof global.addDebugLog === 'function') {
      global.addDebugLog({ event: 'send_text', instance: this.instanceName, to_jid: jid, text: texto.slice(0, 80) })
    }
    await this.socket.sendMessage(jid, { text: texto })
    await this._salvarMensagem(numero, 'text', texto)
  }

  async enviarImagem(numero, url, legenda = '') {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    await this.socket.sendMessage(jid, { image: { url }, caption: legenda })
    await this._salvarMensagem(numero, 'image', url)
  }

  async enviarAudio(numero, url) {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    const u = (url || '').toLowerCase()
    const isOgg = u.includes('.ogg') || u.includes('.opus') || u.includes('.oga')
    // Baixa o arquivo
    const res = await fetch(url)
    let buffer = Buffer.from(await res.arrayBuffer())
    let mimetype = 'audio/ogg; codecs=opus'
    // Converte MP3/outros para OGG Opus (único formato que toca no WhatsApp)
    if (!isOgg) {
      try {
        buffer = await converterParaOgg(buffer)
        console.log(`[${this.instanceName}] Áudio convertido para OGG Opus`)
      } catch (e) {
        console.error(`[${this.instanceName}] Falha na conversão de áudio:`, e.message)
        mimetype = 'audio/mpeg' // fallback
      }
    }
    await this.socket.sendMessage(jid, { audio: buffer, mimetype, ptt: true })
    await this._salvarMensagem(numero, 'audio', url)
  }

  async enviarImagem(numero, url, legenda = '') {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this.socket.sendMessage(jid, { image: buffer, caption: legenda })
    await this._salvarMensagem(numero, 'image', url)
  }

  async enviarPDF(numero, url, nomeArquivo = 'documento.pdf') {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this.socket.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: nomeArquivo
    })
    await this._salvarMensagem(numero, 'document', url)
  }

  async enviarPDF(numero, url, nomeArquivo = 'documento.pdf') {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    await this.socket.sendMessage(jid, {
      document: { url },
      mimetype: 'application/pdf',
      fileName: nomeArquivo
    })
    await this._salvarMensagem(numero, 'document', url)
  }

  desconectar() {
    if (this.socket) {
      this.socket.end()
      this.socket = null
    }
    this.status = 'disconnected'
  }

  _verificarConexao() {
    if (!this.socket || this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado')
    }
  }

  _formatarJID(numero) {
    const s = String(numero)
    // Se já é um JID completo (tem @), usa direto
    if (s.includes('@')) return s
    const limpo = s.replace(/\D/g, '')
    // Se temos o JID completo mapeado (ex: @lid), usa ele
    if (this._jidCache[limpo]) return this._jidCache[limpo]
    return `${limpo}@s.whatsapp.net`
  }

  async _salvarStatus(status, phone = null) {
    const update = { status, updated_at: new Date().toISOString() }
    if (phone) update.phone = phone
    await supabase.from('instances').update(update).eq('id', this.instanceId)
  }

  async _salvarMensagem(numero, tipo, conteudo) {
    await supabase.from('messages').insert({
      instance_id: this.instanceId,
      to_number: numero,
      type: tipo,
      content: conteudo,
      status: 'sent'
    })
  }

  async _limparCredenciais() {
    await supabase.from('auth_state').delete().eq('instance_id', this.instanceId)
  }
}

module.exports = WAConnection
