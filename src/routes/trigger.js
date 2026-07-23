const router = require('express').Router()
const { getClient } = require('../lib/app-supabase')

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null
  let phone = String(raw).replace(/\D/g, '')
  // Adiciona DDI 55 (Brasil) se número local
  if (phone.length <= 11 && !phone.startsWith('55')) phone = '55' + phone
  if (!phone) return null
  return `${phone}@s.whatsapp.net`
}

async function upsertContact(db, instanceId, phone, name, extra = {}) {
  const { data: inst } = await db.from('instances').select('user_id').eq('remote_id', instanceId).maybeSingle()
  if (!inst) return
  await db.from('contacts').upsert({
    user_id: inst.user_id, phone,
    name: name || phone.replace(/@.*$/, ''),
    last_contact: new Date().toISOString(),
    ...extra,
  }, { onConflict: 'user_id,phone' })
}

async function dispararFluxo({ db, instanceId, phone, flowId, event, variables = {} }) {
  const { processMessage, runFlow, updateSession } = require('../flows/executor')

  const { data: inst } = await db.from('instances').select('*').eq('remote_id', instanceId).maybeSingle()
  if (!inst) { console.error(`[webhook] Instância "${instanceId}" não encontrada`); return }

  if (flowId) {
    const { data: flow } = await db.from('flows').select('*').eq('id', flowId).maybeSingle()
    if (!flow) { console.error(`[webhook] Fluxo ${flowId} não encontrado`); return }

    const startNode = (flow.nodes || []).find(n => n.type === 'start')
    if (!startNode) { console.error(`[webhook] Fluxo "${flow.name}" sem node start`); return }

    const result = await runFlow({
      nodes: flow.nodes,
      edges: flow.edges || [],
      startId: startNode.id,
      instanceId, phone,
      variables: { ...variables, evento: event },
      userId: inst.user_id,
      assistantId: inst.assistant_id ?? null,
    })
    const instLike = { id: inst.id, user_id: inst.user_id, remote_id: instanceId }
    await updateSession(db, null, flowId, result, instLike, phone)
    console.log(`[webhook] Fluxo "${flow.name}" executado para ${phone}`)
  } else {
    // Sem flowId: usa keyword matching — trata event como mensagem recebida
    await processMessage({ instanceRemoteId: instanceId, fromJid: phone, userText: event })
    console.log(`[webhook] Evento "${event}" processado via keyword matching para ${phone}`)
  }
}

// ── POST /trigger — Genérico ───────────────────────────────────────────────
// Uso direto ou via integração própria.
// Body: { instanceId, phone, event?, flowId?, name?, variables? }
// Mantém compatibilidade com formato legado (instanceRemoteId, fromJid, text)

router.post('/', async (req, res) => {
  try {
    const {
      // formato novo
      instanceId, phone, event, flowId, variables = {}, name,
      // formato legado
      instanceRemoteId, fromJid, text,
    } = req.body

    const finalInstanceId = instanceId || instanceRemoteId
    const rawPhone        = phone || fromJid
    const finalEvent      = event || text || 'trigger'

    if (!finalInstanceId || !rawPhone) {
      return res.status(400).json({ error: 'instanceId e phone são obrigatórios' })
    }

    const normalizedPhone = normalizePhone(rawPhone)
    if (!normalizedPhone) return res.status(400).json({ error: 'Telefone inválido' })

    res.json({ ok: true, message: `Evento "${finalEvent}" enfileirado para ${normalizedPhone}` })

    const db = getClient()
    if (!db) return

    const contactName = name || variables.nome || variables.name
    if (contactName) await upsertContact(db, finalInstanceId, normalizedPhone, contactName)

    dispararFluxo({ db, instanceId: finalInstanceId, phone: normalizedPhone, flowId, event: finalEvent, variables })
      .catch(e => console.error('[webhook/trigger] Erro:', e.message))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /trigger/hotmart — Webhook da Hotmart ─────────────────────────────
// Configure no painel da Hotmart:
//   URL: https://SEU_RAILWAY.up.railway.app/trigger/hotmart?instanceId=xxx&flowId=yyy
//   Eventos: PURCHASE_APPROVED, PURCHASE_COMPLETE, PURCHASE_REFUNDED, etc.

router.post('/hotmart', async (req, res) => {
  try {
    const { instanceId, flowId } = req.query
    if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório na URL (?instanceId=xxx)' })

    const payload = req.body
    const event   = payload.event || 'HOTMART_EVENT'
    const buyer   = payload.data?.buyer || {}
    const product = payload.data?.product || {}
    const purchase = payload.data?.purchase || {}

    const rawPhone = buyer.checkout_phone || buyer.phone || ''
    if (!rawPhone) {
      console.warn('[webhook/hotmart] Sem telefone no payload:', JSON.stringify(buyer))
      return res.json({ ok: false, reason: 'Sem telefone no payload' })
    }

    const normalizedPhone = normalizePhone(rawPhone)
    if (!normalizedPhone) return res.json({ ok: false, reason: 'Telefone inválido' })

    console.log(`[webhook/hotmart] ${event} → ${normalizedPhone} (${buyer.name})`)
    res.json({ ok: true, event, phone: normalizedPhone })

    const db = getClient()
    if (!db) return

    await upsertContact(db, instanceId, normalizedPhone, buyer.name)

    const variables = {
      nome:    buyer.name || '',
      email:   buyer.email || '',
      produto: product.name || '',
      valor:   String(purchase.price?.value || ''),
      evento:  event,
    }
    dispararFluxo({ db, instanceId, phone: normalizedPhone, flowId, event, variables })
      .catch(e => console.error('[webhook/hotmart] Erro:', e.message))
  } catch (e) {
    console.error('[webhook/hotmart] Erro:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── POST /trigger/kiwify — Webhook da Kiwify ──────────────────────────────
// Configure no painel da Kiwify:
//   URL: https://SEU_RAILWAY.up.railway.app/trigger/kiwify?instanceId=xxx&flowId=yyy
//   Eventos: paid, refused, refunded, chargeback

router.post('/kiwify', async (req, res) => {
  try {
    const { instanceId, flowId } = req.query
    if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório na URL (?instanceId=xxx)' })

    const payload  = req.body
    const event    = payload.order_status || 'kiwify_event'
    const customer = payload.Customer || payload.customer || {}
    const product  = payload.Product  || payload.product  || {}

    const rawPhone = customer.mobile || customer.phone || customer.cellphone || ''
    if (!rawPhone) {
      console.warn('[webhook/kiwify] Sem telefone no payload:', JSON.stringify(customer))
      return res.json({ ok: false, reason: 'Sem telefone no payload' })
    }

    const normalizedPhone = normalizePhone(rawPhone)
    if (!normalizedPhone) return res.json({ ok: false, reason: 'Telefone inválido' })

    const contactName = customer.full_name || customer.name || ''
    console.log(`[webhook/kiwify] ${event} → ${normalizedPhone} (${contactName})`)
    res.json({ ok: true, event, phone: normalizedPhone })

    const db = getClient()
    if (!db) return

    await upsertContact(db, instanceId, normalizedPhone, contactName)

    const variables = {
      nome:    contactName,
      email:   customer.email || '',
      produto: product.name || '',
      pedido:  payload.order_ref || '',
      evento:  event,
    }
    dispararFluxo({ db, instanceId, phone: normalizedPhone, flowId, event, variables })
      .catch(e => console.error('[webhook/kiwify] Erro:', e.message))
  } catch (e) {
    console.error('[webhook/kiwify] Erro:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── POST /trigger/eduzz — Webhook da Eduzz ────────────────────────────────
// URL: https://SEU_RAILWAY.up.railway.app/trigger/eduzz?instanceId=xxx&flowId=yyy

router.post('/eduzz', async (req, res) => {
  try {
    const { instanceId, flowId } = req.query
    if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório na URL' })

    const payload = req.body
    const event   = payload.key || payload.status || 'eduzz_event'
    const client  = payload.client_cell_phone || payload.cel || ''
    const name    = payload.client_name || ''

    if (!client) {
      console.warn('[webhook/eduzz] Sem telefone no payload')
      return res.json({ ok: false, reason: 'Sem telefone no payload' })
    }

    const normalizedPhone = normalizePhone(client)
    if (!normalizedPhone) return res.json({ ok: false, reason: 'Telefone inválido' })

    console.log(`[webhook/eduzz] ${event} → ${normalizedPhone} (${name})`)
    res.json({ ok: true, event, phone: normalizedPhone })

    const db = getClient()
    if (!db) return

    await upsertContact(db, instanceId, normalizedPhone, name)

    const variables = {
      nome:    name,
      email:   payload.client_email || '',
      produto: payload.product_title || '',
      evento:  event,
    }
    dispararFluxo({ db, instanceId, phone: normalizedPhone, flowId, event, variables })
      .catch(e => console.error('[webhook/eduzz] Erro:', e.message))
  } catch (e) {
    console.error('[webhook/eduzz] Erro:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── GET /trigger/info — Mostra as URLs de webhook disponíveis ─────────────

router.get('/info', (req, res) => {
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://SEU-DOMINIO.up.railway.app'

  res.json({
    endpoints: {
      generic: `POST ${base}/trigger`,
      hotmart: `POST ${base}/trigger/hotmart?instanceId=ID_DA_INSTANCIA&flowId=ID_DO_FLUXO`,
      kiwify:  `POST ${base}/trigger/kiwify?instanceId=ID_DA_INSTANCIA&flowId=ID_DO_FLUXO`,
      eduzz:   `POST ${base}/trigger/eduzz?instanceId=ID_DA_INSTANCIA&flowId=ID_DO_FLUXO`,
    },
    notes: [
      'O instanceId é o remote_id da sua instância (ex: 5511999999999)',
      'O flowId é opcional — sem ele, usa keyword matching com o nome do evento',
      'Todas as rotas exigem o header: Authorization: Bearer fluxia2026seguro',
    ]
  })
})

module.exports = router
