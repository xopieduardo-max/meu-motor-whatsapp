const { getClient } = require('../lib/app-supabase')

// ── Helpers ───────────────────────────────────────────────────────────────────

function interpolate(text, vars) {
  return String(text ?? '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''))
    .replace(/\[(\w+)\]/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : `[${k}]`)
}

// Verifica se o horário atual (BRT = UTC-3) está dentro da janela de envio
function isInSendWindow(windowStart, windowEnd) {
  const nowUtc = new Date()
  const brtHour = (nowUtc.getUTCHours() + 21) % 24 // UTC-3
  return brtHour >= windowStart && brtHour < windowEnd
}

// Retorna o próximo momento válido para envio (início da próxima janela)
function nextWindowOpen(windowStart) {
  const nowUtc = new Date()
  const brtHour = (nowUtc.getUTCHours() + 21) % 24
  let hoursUntil = windowStart - brtHour
  if (hoursUntil <= 0) hoursUntil += 24
  return new Date(nowUtc.getTime() + hoursUntil * 3_600_000)
}

// Adiciona jitter de ±30min para distribuir envios em massa
function withJitter(date) {
  const jitterMs = (Math.random() - 0.5) * 3_600_000 // ±30min
  return new Date(date.getTime() + jitterMs)
}

// ── Job principal ─────────────────────────────────────────────────────────────

async function processFollowups() {
  const db = getClient()
  if (!db) return

  try {
    const { data: enrollments } = await db
      .from('followup_enrollments')
      .select('*')
      .eq('status', 'active')
      .not('next_step_at', 'is', null)
      .lt('next_step_at', new Date().toISOString())
      .limit(50)

    if (!enrollments?.length) return
    console.log(`[followup] ${enrollments.length} envio(s) pendente(s)`)

    const manager = require('../whatsapp/manager')

    for (const enrollment of enrollments) {
      try {
        const remoteId = enrollment.instance_remote_id
        const conn = manager.obterConexao(remoteId)

        if (!conn || conn.status !== 'connected') {
          console.log(`[followup] Instância ${remoteId} offline — reagendando em 15min`)
          await db.from('followup_enrollments').update({
            next_step_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', enrollment.id)
          continue
        }

        const windowStart = enrollment.send_window_start ?? 8
        const windowEnd   = enrollment.send_window_end   ?? 20

        // Fora da janela → reagenda para a abertura da próxima janela
        if (!isInSendWindow(windowStart, windowEnd)) {
          const openAt = nextWindowOpen(windowStart)
          await db.from('followup_enrollments').update({
            next_step_at: openAt.toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', enrollment.id)
          console.log(`[followup] Fora da janela (${windowStart}h-${windowEnd}h BRT) → reabre às ${openAt.toISOString()}`)
          continue
        }

        const steps       = Array.isArray(enrollment.steps) ? enrollment.steps : []
        const currentStep = enrollment.current_step ?? 0

        if (currentStep >= steps.length) {
          await db.from('followup_enrollments').update({
            status: 'completed', next_step_at: null, updated_at: new Date().toISOString(),
          }).eq('id', enrollment.id)
          continue
        }

        // Busca variáveis atuais do contato (pode ter atualizado desde a matrícula)
        // Precisa do UUID de instances.id, não do remote_id, para filtrar flow_sessions
        const { data: instRow } = await db
          .from('instances')
          .select('id')
          .eq('remote_id', enrollment.instance_remote_id)
          .maybeSingle()
          .catch(() => ({ data: null }))

        const { data: latestSession } = instRow?.id ? await db
          .from('flow_sessions')
          .select('variables')
          .eq('instance_id', instRow.id)
          .eq('contact_phone', enrollment.contact_phone)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
          .catch(() => ({ data: null })) : { data: null }

        const vars = { ...(enrollment.variables ?? {}), ...(latestSession?.variables ?? {}) }

        const step = steps[currentStep]

        // Verifica condição de cancelamento no passo (ex.: lead pagou)
        if (step.cancelIfVariable && step.cancelIfValue !== undefined) {
          const current = String(vars[step.cancelIfVariable] ?? '').toLowerCase().trim()
          const expected = String(step.cancelIfValue).toLowerCase().trim()
          if (current === expected) {
            await db.from('followup_enrollments').update({
              status: 'cancelled', next_step_at: null, updated_at: new Date().toISOString(),
            }).eq('id', enrollment.id)
            console.log(`[followup] Cancelado por condição ${step.cancelIfVariable}=${step.cancelIfValue} → ${enrollment.contact_phone}`)
            continue
          }
        }

        const message = interpolate(step.message ?? '', vars)

        // Envia com uma tentativa de retry
        let sendOk = false
        for (let attempt = 0; attempt < 2 && !sendOk; attempt++) {
          try {
            await conn.enviarTexto(enrollment.contact_phone, message)
            sendOk = true
          } catch (e) {
            console.error(`[followup] Erro ao enviar (tentativa ${attempt + 1}):`, e.message)
            if (attempt === 0) await new Promise(r => setTimeout(r, 4_000))
          }
        }

        console.log(`[followup] Passo ${currentStep + 1}/${steps.length} → ${enrollment.contact_phone} [${sendOk ? 'ok' : 'falhou'}]: "${message.slice(0, 50)}"`)

        const nextStep   = sendOk ? currentStep + 1 : currentStep
        const isLastStep = nextStep >= steps.length

        let nextStepAt  = null
        let nextStatus  = 'active'

        if (sendOk && !isLastStep) {
          const delayMs  = Math.max(1, Number(steps[nextStep]?.delay_hours) || 24) * 3_600_000
          nextStepAt = withJitter(new Date(Date.now() + delayMs)).toISOString()
        } else if (sendOk && isLastStep) {
          nextStatus = 'completed'
        } else {
          // Falhou: tenta de novo em 5 minutos
          nextStepAt = new Date(Date.now() + 5 * 60_000).toISOString()
        }

        await db.from('followup_enrollments').update({
          current_step: nextStep,
          status: nextStatus,
          next_step_at: nextStepAt,
          updated_at: new Date().toISOString(),
        }).eq('id', enrollment.id)

      } catch (e) {
        console.error(`[followup] Erro no enrollment ${enrollment.id}:`, e.message)
      }
    }
  } catch (e) {
    console.error('[followup] Erro geral:', e.message)
  }
}

function iniciarJobFollowup() {
  console.log('[followup] Job de sequências de follow-up iniciado (intervalo: 60s)')
  setInterval(processFollowups, 60_000)
}

module.exports = { iniciarJobFollowup }
