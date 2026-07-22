const { createClient } = require('@supabase/supabase-js')

let _client = null

function getClient() {
  if (_client) return _client
  const url = process.env.SUPABASE_URL || process.env.APP_SUPABASE_URL
  // MUST use service role key — flow_sessions has RLS; anon key blocks reads/writes
  const key = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.APP_SUPABASE_SERVICE_KEY
    || process.env.APP_SUPABASE_ANON_KEY   // last resort (RLS will block session queries)
    || process.env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    console.warn('[app-supabase] Supabase não configurado — client desativado')
    return null
  }
  const usingServiceKey = !!(
    process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.APP_SUPABASE_SERVICE_KEY
  )
  if (!usingServiceKey) {
    console.warn('[app-supabase] ATENÇÃO: usando anon key — RLS bloqueará flow_sessions (sessions não serão salvas, fluxo repetirá para o mesmo contato). Configure SUPABASE_SERVICE_KEY no Railway.')
  } else {
    console.log('[app-supabase] service role key carregada — RLS bypass ativo')
  }
  console.log('[app-supabase] conectando a:', url.slice(0, 40))
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

module.exports = { getClient }
