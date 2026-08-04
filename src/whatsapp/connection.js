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
    this._jidCache = {}
    this._lidToPhone = {}
    this._debounce = {}
    this._failCount405 = 0
  }

  async connect() {
    try {
      const { state, saveCreds } = await useSupabaseAuthState(this.instanceId)
      const { version } = await fetchLatestBaileysVersion()

      console.log(`[${this.instanceName}] Iniciando makeWASocket version=${version?.join?.('.')}`)
      this.socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }), // 'warn' expõe erros internos do Baileys nos logs
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        // Força USync fresh a cada envio — necessário para descobrir dispositivos LID
        // (cache desatualizado omite o @lid device do destinatário → criptografia errada → 463)
        useUserDevicesCache: false,
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
          const boomErr = new Boom(lastDisconnect?.error)
          const codigo = boomErr?.output?.statusCode
          const errMsg = lastDisconnect?.error?.message || boomErr?.message || ''
          const deslogado = codigo === DisconnectReason.loggedOut
          const qrExpirou = codigo === 408 || (errMsg && errMsg.toLowerCase().includes('qr'))

          this.status = 'disconnected'
          this.qrBase64 = null
          await this._salvarStatus('disconnected')
          console.log(`[${this.instanceName}] Desconectado. Código: ${codigo} | Msg: ${errMsg}`)

          if (deslogado) {
            console.log(`[${this.instanceName}] Deslogado permanentemente.`)
            await this._limparCredenciais()
          } else if (qrExpirou) {
            const delay = 15000
            console.log(`[${this.instanceName}] QR expirou/rejeitado. Aguardando ${delay/1000}s para novo QR...`)
            setTimeout(() => this.connect(), delay)
          } else if (codigo === 405 || errMsg.toLowerCase().includes('connection failure')) {
            // 405 = WhatsApp rejeitou a conexão (sessão inválida OU IP bloqueado)
            this._failCount405++
            if (this._failCount405 >= 5) {
              // Após 5 falhas: IP provavelmente bloqueado. Limpa credenciais e aguarda 30 min.
              console.log(`[${this.instanceName}] 5 falhas 405 — IP possivelmente bloqueado pelo WhatsApp. Pausando por 30 min...`)
              await this._limparCredenciais()
              this._failCount405 = 0
              // Aguarda 30 minutos para o bloqueio temporário do WhatsApp expirar
              setTimeout(() => this.connect(), 30 * 60 * 1000)
            } else {
              // Backoff exponencial: 30s, 60s, 120s, 240s
              const delay = Math.min(30000 * Math.pow(2, this._failCount405 - 1), 300000)
              console.log(`[${this.instanceName}] Falha 405 (${this._failCount405}/5). Aguardando ${Math.round(delay/1000)}s...`)
              setTimeout(() => this.connect(), delay)
            }
          } else {
            this._failCount405 = 0
            console.log(`[${this.instanceName}] Reconectando em 5s...`)
            setTimeout(() => this.connect(), 5000)
          }
        }

        if (connection === 'open') {
          this.qrBase64 = null
          this.status = 'connected'
          this._failCount405 = 0 // sessão ok — reseta contador
          const phone = this.socket.user?.id?.split(':')[0] || null
          await this._salvarStatus('connected', phone)
          console.log(`[${this.instanceName}] Conectado! Número: ${phone}`)
        }
      })

      this.socket.ev.on('creds.update', saveCreds)

      // Mapeia @lid → @s.whatsapp.net via contacts.upsert, contacts.update e messaging-history.set
      const _processContacts = (contacts, source) => {
        let mapped = 0
        for (const c of (contacts || [])) {
          // Log TODOS os contatos @lid para entender o formato real do Baileys
          if (c.lid || (c.id && c.id.includes('@lid'))) {
            console.log(`[${this.instanceName}] ${source} lid-contact: ${JSON.stringify({ id: c.id, lid: c.lid, notify: c.notify, name: c.name })}`)
          }
          // Caso 1: c.id é @s.whatsapp.net, c.lid é o @lid
          if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
            const lidNum = String(c.lid).replace(/@.*$/, '')
            if (!this._lidToPhone[lidNum]) { this._lidToPhone[lidNum] = c.id; mapped++ }
          }
          // Caso 2: c.id é @lid, c.lid é @s.whatsapp.net (campos invertidos)
          if (c.id && c.id.endsWith('@lid') && c.lid && c.lid.endsWith('@s.whatsapp.net')) {
            const lidNum = c.id.replace(/@lid$/, '')
            if (!this._lidToPhone[lidNum]) { this._lidToPhone[lidNum] = c.lid; mapped++ }
          }
          // Caso 3: c.id é @lid e c.lid não existe — tenta deduzir pelo notify (se for número)
          if (c.id && c.id.endsWith('@lid') && !c.lid && c.notify) {
            const digitsOnly = String(c.notify).replace(/\D/g, '')
            if (digitsOnly.length >= 10) {
              const lidNum = c.id.replace(/@lid$/, '')
              if (!this._lidToPhone[lidNum]) {
                this._lidToPhone[lidNum] = `${digitsOnly}@s.whatsapp.net`
                mapped++
              }
            }
          }
        }
        if (mapped > 0) console.log(`[${this.instanceName}] ${source}: ${mapped} novos mapeamentos @lid→phone (total=${Object.keys(this._lidToPhone).length})`)
      }

      this.socket.ev.on('contacts.upsert', (contacts) => _processContacts(contacts, 'contacts.upsert'))
      this.socket.ev.on('contacts.update', (contacts) => _processContacts(contacts, 'contacts.update'))

      // Captura histórico de mensagens quando Baileys reconecta/sincroniza
      this.socket.ev.on('messaging-history.set', async ({ messages: histMsgs, contacts: histContacts, chats }) => {
        // Processa contatos do sync inicial — provavelmente têm mapeamento @lid → phone
        if (histContacts?.length) {
          _processContacts(histContacts, 'messaging-history.set')
        }
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

        if (typeof global.addDebugLog === 'function') {
          global.addDebugLog({ event: 'messages.upsert', instance: this.instanceName, type, count: messages.length })
        }

        // notify = mensagem em tempo real; append = mensagens que chegaram durante reconexão
        // Processa ambos, mas para 'append' só aceita mensagens recentes (< 3 min)
        if (type !== 'notify' && type !== 'append') return
        const isAppend = type === 'append'
        const now = Date.now()

        for (const msg of messages) {
          // Loga o remoteJid bruto para diagnóstico
          const rawJid = msg.key.remoteJid || ''
          console.log(`[${this.instanceName}] rawJid=${rawJid} fromMe=${msg.key.fromMe} participant=${msg.key.participant} type=${type}`)
          if (typeof global.addDebugLog === 'function') {
            global.addDebugLog({ event: 'raw_message', instance: this.instanceName, rawJid, fromMe: msg.key.fromMe, msgType: Object.keys(msg.message || {}).join(','), type })
          }

          // Ignora grupos, broadcasts e status
          if (rawJid.endsWith('@g.us') || rawJid.endsWith('@broadcast') || rawJid === 'status@broadcast') continue
          if (msg.key.fromMe) continue // ignora mensagens enviadas pelo bot

          // Extrai mapeamento @lid → phone e limpa sessão Signal obsoleta
          if (rawJid.endsWith('@lid')) {
            const senderPn    = msg.key?.senderPn
            const participant = msg.key?.participant
            const lidNum = rawJid.replace(/@lid$/, '')

            console.log(`[${this.instanceName}] @lid msg: senderPn=${senderPn} participant=${participant} senderLid=${msg.key?.senderLid}`)

            // Constrói mapeamento — senderPn vem direto do protocolo WA, é o mais confiável
            if (senderPn && !this._lidToPhone[lidNum]) {
              const phone = String(senderPn).replace(/\D/g, '')
              if (phone.length >= 10) {
                this._lidToPhone[lidNum] = `${phone}@s.whatsapp.net`
                console.log(`[${this.instanceName}] @lid mapeado: ${rawJid} → ${this._lidToPhone[lidNum]}`)
              }
            } else if (participant && participant.endsWith('@s.whatsapp.net') && !this._lidToPhone[lidNum]) {
              this._lidToPhone[lidNum] = participant
              console.log(`[${this.instanceName}] @lid mapeado via participant: ${rawJid} → ${participant}`)
            } else if (!senderPn && !participant && !this._lidToPhone[lidNum]) {
              console.log(`[${this.instanceName}] @lid sem senderPn nem participant — key=${JSON.stringify(msg.key)}`)
            }

          }

          // Para append, só processa mensagens dos últimos 3 minutos (evita reprocessar histórico antigo)
          if (isAppend) {
            const msgTs = Number(msg.messageTimestamp) * 1000
            if (!msgTs || now - msgTs > 3 * 60 * 1000) continue
          }

          const from = rawJid.replace(/@.*$/, '').replace(/:\d+$/, '') // remove sufixo de dispositivo
          if (!from) continue

          // Guarda mapeamento número → JID completo para uso no envio
          this._jidCache[from] = rawJid

          // Detecta tipo de mídia antes de extrair texto
          const msgKeys = Object.keys(msg.message || {})
          const isAudio = msgKeys.some(k => k === 'audioMessage' || k === 'pttMessage')
          const isImage = msgKeys.includes('imageMessage')
          const isDoc   = msgKeys.some(k => k === 'documentMessage' || k === 'documentWithCaptionMessage')
          const isVideo = msgKeys.includes('videoMessage')
          const isSticker = msgKeys.includes('stickerMessage')

          const messageType = isAudio ? 'audio'
            : isImage ? 'image'
            : isDoc   ? 'document'
            : isVideo ? 'video'
            : isSticker ? 'sticker'
            : 'text'

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            ''

          // Marca mensagem como lida
          try { await this.socket.readMessages([msg.key]) } catch {}

          // Salva mensagem recebida no inbox da plataforma
          const inboxContent = text || (isAudio ? '[Áudio]' : isImage ? '[Imagem]' : isDoc ? '[Documento]' : isVideo ? '[Vídeo]' : isSticker ? '[Figurinha]' : '')
          this._saveInboxMessage({
            phone: rawJid, phoneName: msg.pushName || from,
            direction: 'in', type: messageType, content: inboxContent,
          }).catch(() => {})

          // Cancela sequências de follow-up ativas (cancel_on_reply=true) — fire-and-forget
          supabase.from('followup_enrollments')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('instance_remote_id', this.instanceId)
            .eq('contact_phone', rawJid)
            .eq('status', 'active')
            .eq('cancel_on_reply', true)
            .then(() => {}).catch(() => {})

          // Anti-flooding: debounce de 600ms por contato
          const debounceKey = `${this.instanceId}:${from}`
          if (this._debounce[debounceKey]) clearTimeout(this._debounce[debounceKey])
          this._debounce[debounceKey] = setTimeout(() => {
            delete this._debounce[debounceKey]
            console.log(`[${this.instanceName}] Processando → from=${rawJid} type=${messageType} text="${text}"`)
            if (typeof global.addDebugLog === 'function') {
              global.addDebugLog({ event: 'processing', instance: this.instanceName, fromJid: rawJid, messageType, text })
            }
            processMessage({
              instanceRemoteId: this.instanceId,
              fromJid: rawJid,
              userText: text,
              messageType,
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
      // Presence update precisa de @s.whatsapp.net — resolve @lid para phone se disponível
      const presenceJid = jid.endsWith('@lid')
        ? (this._lidToPhone[jid.replace(/@lid$/, '')] || jid)
        : jid
      await this.socket.sendPresenceUpdate('composing', presenceJid)
      await new Promise(r => setTimeout(r, ms))
      await this.socket.sendPresenceUpdate('paused', presenceJid)
    } catch {}
  }

  // Wrapper com timeout de 20s para socket.sendMessage (evita hanging indefinido)
  async _sendWithTimeout(jid, content, timeoutMs = 20000) {
    const type = Object.keys(content)[0]
    // Para JIDs @lid: SEMPRE limpa sessão Signal antes de enviar.
    // Garante pkmsg fresh a cada envio — evita ratchet dessincronizado acumulado de envios anteriores.
    // Cada pkmsg carrega material criptográfico completo; o destinatário processa cada um de forma independente.
    if (jid.endsWith('@lid')) {
      const lidNum = jid.replace(/@lid$/, '')
      const sessionKeys = {}
      for (let d = 0; d <= 5; d++) sessionKeys[`${lidNum}.${d}`] = null
      await this.socket.authState.keys.set({ session: sessionKeys })
      console.log(`[${this.instanceName}] pré-envio: sessão LID ${lidNum} limpa → pkmsg fresh`)
    }
    console.log(`[${this.instanceName}] sendMessage → jid=${jid} type=${type}`)
    const opts = jid.endsWith('@lid') ? { additionalAttributes: { addressing_mode: 'lid' } } : {}
    const result = await Promise.race([
      this.socket.sendMessage(jid, content, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`sendMessage timeout após ${timeoutMs}ms`)), timeoutMs))
    ])
    console.log(`[${this.instanceName}] sendMessage OK → id=${result?.key?.id || 'sem-id'}`)
    return result
  }

  async enviarTexto(numero, texto) {
    await this._verificarConexao()
    const jid = this._formatarJID(numero)
    if (typeof global.addDebugLog === 'function') {
      global.addDebugLog({ event: 'send_text', instance: this.instanceName, to_jid: jid, text: texto.slice(0, 80) })
    }
    // Typing indicator proporcional ao tamanho da mensagem (máx 3s)
    const typingMs = Math.min(800 + texto.length * 20, 3000)
    await this._typing(jid, typingMs)
    await this._sendWithTimeout(jid, { text: texto })
    await this._salvarMensagem(numero, 'text', texto)
    this._saveInboxMessage({ phone: jid, direction: 'out', type: 'text', content: texto }).catch(() => {})
  }

  async enviarAudio(numero, url) {
    await this._verificarConexao()
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
    await this._sendWithTimeout(jid, { audio: buffer, mimetype, ptt: true }, 30000)
    await this._salvarMensagem(numero, 'audio', url)
  }

  async enviarImagem(numero, url, legenda = '') {
    await this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this._sendWithTimeout(jid, { image: buffer, caption: legenda }, 30000)
    await this._salvarMensagem(numero, 'image', url)
  }

  async enviarPDF(numero, url, nomeArquivo = 'documento.pdf', caption = '') {
    await this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this._sendWithTimeout(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: nomeArquivo,
      ...(caption ? { caption } : {}),
    }, 30000)
    await this._salvarMensagem(numero, 'document', url)
  }

  async enviarVideo(numero, url, caption = '') {
    await this._verificarConexao()
    const jid = this._formatarJID(numero)
    const res = await fetch(url)
    const buffer = Buffer.from(await res.arrayBuffer())
    await this._sendWithTimeout(jid, { video: buffer, ...(caption ? { caption } : {}) }, 30000)
    await this._salvarMensagem(numero, 'video', url)
  }

  desconectar() {
    // Cancela todos os debounces pendentes antes de fechar o socket
    Object.values(this._debounce).forEach(clearTimeout)
    this._debounce = {}
    if (this.socket) {
      this.socket.end()
      this.socket = null
    }
    this.status = 'disconnected'
  }

  async _verificarConexao() {
    if (this.status === 'connected' && this.socket) return
    // Aguarda até 8s para conexão ficar pronta (cobre reconexões automáticas)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400))
      if (this.status === 'connected' && this.socket) return
    }
    throw new Error(`WhatsApp não conectado (status=${this.status}) após 8s`)
  }

  _formatarJID(numero) {
    const s = String(numero)
    if (s.includes('@')) {
      // Mantém @lid — não resolve para phone. O envio usa addressing_mode='lid' + sessão LID existente.
      return s
    }
    const limpo = s.replace(/\D/g, '')
    const cached = this._jidCache[limpo]
    if (cached) return cached  // pode ser @lid ou @s.whatsapp.net
    return `${limpo}@s.whatsapp.net`
  }

  async _salvarStatus(status, phone = null) {
    try {
      const update = { status, updated_at: new Date().toISOString() }
      if (phone) update.phone = phone
      await supabase.from('instances').update(update).eq('remote_id', this.instanceId)
    } catch {}
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
