const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')
const supabase = require('../lib/supabase')

async function useSupabaseAuthState(instanceId) {
  const write = async (data, key) => {
    try {
      const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer))
      const { error } = await supabase.from('auth_state').upsert({ instance_id: instanceId, key, value })
      if (error) console.error(`[authState] Erro ao salvar key=${key} instance=${instanceId}:`, error.message)
    } catch (err) {
      console.error(`[authState] Exceção ao salvar key=${key}:`, err.message)
    }
  }

  const read = async (key) => {
    try {
      const { data } = await supabase
        .from('auth_state').select('value')
        .eq('instance_id', instanceId).eq('key', key).single()
      if (!data?.value) return null
      return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver)
    } catch {
      return null
    }
  }

  const del = async (key) => {
    try {
      await supabase.from('auth_state').delete()
        .eq('instance_id', instanceId).eq('key', key)
    } catch {}
  }

  const rawCreds = await read('creds')
  const creds = rawCreds || initAuthCreds()

  console.log(`[authState] instance=${instanceId} credenciais=${rawCreds ? 'encontradas' : 'novas (QR necessário)'}`)

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {}
          await Promise.all(ids.map(async (id) => {
            let val = await read(`${type}-${id}`)
            if (type === 'app-state-sync-key' && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(val)
            }
            result[id] = val
          }))
          return result
        },
        set: async (data) => {
          const tasks = []
          for (const type in data) {
            for (const id in data[type]) {
              const val = data[type][id]
              tasks.push(val ? write(val, `${type}-${id}`) : del(`${type}-${id}`))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => write(creds, 'creds')
  }
}

module.exports = { useSupabaseAuthState }
