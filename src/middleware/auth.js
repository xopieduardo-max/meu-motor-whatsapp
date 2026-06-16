function requireApiKey(req, res, next) {
  const apiKey = process.env.API_SECRET_KEY
  if (!apiKey) return next() // se não configurado, permite (compatibilidade)

  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : header

  if (!token || token !== apiKey) {
    return res.status(401).json({ error: 'Não autorizado. Informe o header: Authorization: Bearer <API_SECRET_KEY>' })
  }
  next()
}

module.exports = { requireApiKey }
