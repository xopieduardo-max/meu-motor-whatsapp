const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const pino = require('pino')
const supabase = require('../lib/supabase')
const { useSupabaseAuthState } = require('./authState')
const { processMessage } = require('../flows/executor')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const os = require('os')
const fs = require('fs')
const path = require('path')
ffmpeg.setFfmpegPath(ffmpegPath)

async function converterParaOgg(buffer) {
  const id = Date.now()
  const tmpIn  = path.join(os.tmpdir(), `wa_audio_${id}_in.mp3`)
  const tmpOut = path.join(os.tmpdir(), `wa_audio_${id}_out.ogg`)
  try {
    fs.writeFileSync(tmpIn, buffer)
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .audioCodec('libopus')
        .audioChannels(1)
        .audioFrequency(48000)
        .audioBitrate('64k')
        .format('ogg')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })
    return fs.readFileSync(tmpOut)
  } finally {
    try { fs.unlinkSync(tmpIn)  } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
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
    this._debounce = {} // anti-flooding: processa só última msg dentro de 600ms
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

      // Captura histórico de mensagens quando Baileys reconecta/sincroniza
      this.socket.ev.on('messaging-history.set', async ({ messages: histMsgs, chats }) => {
        if (!histMsgs?.length) return
        console.log(`[${this.instanceName}] Sincronizando ${histMsgs.length} mensagens históricas...`)
        const batch = []
        for (const msg of histMsgs.slice(0, 500)) { // limita a 500 msgs
          const jid = msg.key?.remoteJid || ''
          if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast') continue
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
          if (!text) continue
          const phone = jid.replace(/@.*$/, '')
          batch.push({
            phone,
            phoneName: msg.pushName || phone,
            direction: msg.key.fromMe ? 'out' : 'in',
            content: text,
            createdAt: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
          })
        }
        if (batch.length === 0) return
        // Salva em paralelo
        await Promise.all(batch.map(m => this._saveInboxMessage({
          phone: m.phone, phoneName: m.phoneName,
          direction: m.direction, type: 'text', content: m.content,
        }).catch(() => {})))
        console.log(`[${this.instanceName}] ${batch.length} msgs históricas salvas no inbox`)
      })

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

          // Marca mensagem como lida
          try { await this.socket.readMessages([msg.key]) } catch {}

          // Salva mensagem recebida no inbox da plataforma
          this._saveInboxMessage({
            phone: rawJid, phoneName: msg.pushName || from,
            direction: 'in', type: 'text', content: text,
          }).catch(() => {})

          // Anti-flooding: debounce de 600ms por contato
          const debounceKey = `${this.instanceId}:${from}`
          if (this._debounce[debounceKey]) clearTimeout(this._debounce[debounceKey])
          this._debounce[debounceKey] = setTimeout(() => {
            delete this._debounce[debounceKey]
            console.log(`[${this.instanceName}] Processando → from=${rawJid} text="${text}"`)
            if (typeof global.addDebugLog === 'function') {
              global.addDebugLog({ event: 'processing', instance: this.instanceName, fromJid: rawJid, text })
            }
            processMessage({
              instanceRemoteId: this.instanceId,
              fromJid: rawJid,
              userText: text,
              socket: this.socket,
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
          }, 600)
        }
      })

    } catch (err) {
      console.error(`[${this.instanceName}] Erro ao conectar:`, err.message)
      this.status = 'error'
      await this._salvarStatus('error')
    }
  }

  // Salva mensagem no inbox da plataforma (Supabase)
  async _saveInboxMessage({ phone, phoneName, direction, type = 'text', content, mediaUrl }) {
    try {
      const { getClient } = require('../lib/app-supabase')
      const db = getClient()
      if (!db) return
      const supabase = require('../lib/supabase')
      // Busca instance_id e user_id na plataforma
      const { data: inst } = await db.from('instances').select('id, user_id').eq('remote_id', this.instanceId).maybeSingle()
      if (!inst) return
      // Upsert contato
      await db.from('contacts').upsert({
        user_id: inst.user_id, phone, name: phoneName || phone,
        last_contact: new Date().toISOString(),
      }, { onConflict: 'user_id,phone' })
      // Insere mensagem
      await db.from('messages').insert({
        user_id: inst.user_id, instance_id: inst.id,
        contact_phone: phone, contact_name: phoneName || phone,
        direction, type, content: content || null, media_url: mediaUrl || null,
      })
    } catch (e) { /* ignora erros silenciosamente */ }
  }

  async _typing(jid, ms = 1200) {
    try {
      await this.socket.sendPresenceUpdate('composing', jid)
      await new Promise(r => setTimeout(r, ms))
      await this.socket.sendPresenceUpdate('paused', jid)
    } catch {}
  }

  async enviarTexto(numero, texto) {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    if (typeof global.addDebugLog === 'function') {
      global.addDebugLog({ event: 'send_text', instance: this.instanceName, to_jid: jid, text: texto.slice(0, 80) })
    }
    // Typing indicator proporcional ao tamanho da mensagem (máx 3s)
    const typingMs = Math.min(800 + texto.length * 20, 3000)
    await this._typing(jid, typingMs)
    await this.socket.sendMessage(jid, { text: texto })
    await this._salvarMensagem(numero, 'text', texto)
    this._saveInboxMessage({ phone: jid, direction: 'out', type: 'text', content: texto }).catch(() => {})
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

  async enviarPDF(numero, url, nomeArquivo = 'documento.pdf', caption = '') {
    this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this.socket.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: nomeArquivo,
      ...(caption ? { caption } : {}),
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
