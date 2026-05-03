const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const pino = require('pino')
const supabase = require('../lib/supabase')
const { useSupabaseAuthState } = require('./authState')

class WAConnection {
  constructor(instanceId, instanceName) {
    this.instanceId = instanceId
    this.instanceName = instanceName
    this.socket = null
    this.qrBase64 = null
    this.status = 'disconnected'
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
        browser: ['Motor Eduardo', 'Chrome', '120.0.0'],
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
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

    } catch (err) {
      console.error(`[${this.instanceName}] Erro ao conectar:`, err.message)
      this.status = 'error'
      await this._salvarStatus('error')
    }
  }

  async enviarTexto(numero, texto) {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
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
    await this.socket.sendMessage(jid, {
      audio: { url },
      mimetype: 'audio/mp4',
      ptt: true
    })
    await this._salvarMensagem(numero, 'audio', url)
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
    const limpo = numero.replace(/\D/g, '')
    return limpo.includes('@') ? limpo : `${limpo}@s.whatsapp.net`
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
