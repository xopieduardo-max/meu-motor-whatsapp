const { createClient } = require('@supabase/supabase-js')

let _client = null

function getClient() {
  if (_client) return _client
  const url = process.env.APP_SUPABASE_URL
  const key = process.env.APP_SUPABASE_ANON_KEY
  if (!url || !key) {
    console.error('[app-supabase] APP_SUPABASE_URL ou APP_SUPABASE_ANON_KEY não configurados')
    return null
  }
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

module.exports = { getClient }
