const { createClient } = require('@supabase/supabase-js')

let _client = null

const DEFAULT_URL = 'https://umssxlsdrecpdokvwpks.supabase.co'
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtc3N4bHNkcmVjcGRva3Z3cGtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3ODQwOTEsImV4cCI6MjA5MzM2MDA5MX0.nhFjjuPaSOEFLTvdJEgaGCDqk_cqiIvLAyDXpAvKrQw'

function getClient() {
  if (_client) return _client
  const url = process.env.APP_SUPABASE_URL || DEFAULT_URL
  const key = process.env.APP_SUPABASE_ANON_KEY || DEFAULT_KEY
  console.log('[app-supabase] conectando a:', url.slice(0, 40))
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

module.exports = { getClient }
