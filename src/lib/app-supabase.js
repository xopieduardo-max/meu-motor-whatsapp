const { createClient } = require('@supabase/supabase-js')

let _client = null

function getClient() {
  if (_client) return _client
  const url = process.env.APP_SUPABASE_URL
  const key = process.env.APP_SUPABASE_ANON_KEY
  if (!url || !key) {
    console.warn('[app-supabase] APP_SUPABASE_URL ou APP_SUPABASE_ANON_KEY não configuradas — client desativado')
    return null
  }
  console.log('[app-supabase] conectando a:', url.slice(0, 40))
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

module.exports = { getClient }
