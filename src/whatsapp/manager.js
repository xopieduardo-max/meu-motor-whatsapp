const WAConnection = require('./connection')
const supabase = require('../lib/supabase')

// Guarda as conexões ativas em memória
const conexoes = {}

async function iniciarTodasInstancias() {
  const { data: instancias } = await supabase
    .from('instances').select('*')

  if (!instancias?.length) return

  console.log(`Iniciando ${instancias.length} instância(s) salvas...`)
  for (const inst of instancias) {
    await conectarInstancia(inst.id, inst.name)
  }
}

async function conectarInstancia(id, nome) {
  if (conexoes[id]) {
    conexoes[id].desconectar()
  }
  const conn = new WAConnection(id, nome)
  conexoes[id] = conn
  await conn.connect()
  return conn
}

function obterConexao(id) {
  return conexoes[id] || null
}

function listarConexoes() {
  return Object.entries(conexoes).map(([id, conn]) => ({
    id,
    name: conn.instanceName,
    status: conn.status,
    qr: conn.qrBase64
  }))
}

function removerConexao(id) {
  if (conexoes[id]) {
    conexoes[id].desconectar()
    delete conexoes[id]
  }
}

module.exports = {
  iniciarTodasInstancias,
  conectarInstancia,
  obterConexao,
  listarConexoes,
  removerConexao
}
