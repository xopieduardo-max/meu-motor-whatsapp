const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')
const supabase = require('../lib/supabase')

async function useSupabaseAuthState(instanceId) {
  const write = async (data, key) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer))
    await supabase.from('auth_state').upsert({ instance_id: instanceId, key, value })
  }

  const read = async (key) => {
    const { data } = await supabase
      .from('auth_state').select('value')
      .eq('instance_id', instanceId).eq('key', key).single()
    if (!data?.value) return null
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver)
  }

  const del = async (key) => {
    await supabase.from('auth_state').delete()
      .eq('instance_id', instanceId).eq('key', key)
  }

  const rawCreds = await read('creds')
  const creds = rawCreds || initAuthCreds()

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
