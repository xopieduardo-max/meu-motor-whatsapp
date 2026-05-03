# Como subir seu Motor WhatsApp no Railway

## PASSO 1 — Configurar o Supabase

1. Acesse supabase.com e abra seu projeto
2. Vá em SQL Editor → New Query
3. Copie e cole o conteúdo de supabase/schema.sql
4. Clique em Run (ou F5)
5. Confirme que as tabelas foram criadas em Table Editor

Pegue suas chaves em Settings → API:
- Project URL (SUPABASE_URL)
- service_role key (SUPABASE_SERVICE_KEY) — fica em "Service Role"

## PASSO 2 — Subir no GitHub

No terminal (dentro desta pasta):
```
git init
git add .
git commit -m "Motor WhatsApp inicial"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/meu-motor-whatsapp.git
git push -u origin main
```

## PASSO 3 — Deploy no Railway

1. Acesse railway.app → New Project
2. Clique em "Deploy from GitHub repo"
3. Selecione o repositório meu-motor-whatsapp
4. O Railway vai detectar o Node.js automaticamente

## PASSO 4 — Configurar variáveis de ambiente no Railway

No painel do Railway, vá em Variables e adicione:
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
JWT_SECRET=uma_senha_forte_qualquer
```

## PASSO 5 — Pegar a URL do seu motor

Após o deploy, o Railway gera uma URL tipo:
https://meu-motor-whatsapp-production.up.railway.app

Teste acessando essa URL no navegador — deve aparecer:
{"status":"online","name":"Motor WhatsApp - Eduardo"}

## PASSO 6 — Criar seu primeiro motor

Faça um POST para:
```
POST https://sua-url.railway.app/instance/create
Content-Type: application/json

{"name": "Meu WhatsApp Principal"}
```

Acesse GET /instance/{id}/qr para pegar o QR Code e escanear com o WhatsApp.

## Endpoints disponíveis

| Método | URL | O que faz |
|--------|-----|-----------|
| GET | /instance | Lista todas as instâncias |
| POST | /instance/create | Cria nova instância |
| GET | /instance/:id/qr | Pega QR Code |
| GET | /instance/:id/status | Status da conexão |
| POST | /instance/:id/reconnect | Reconecta |
| DELETE | /instance/:id | Remove instância |
| POST | /message/:id/text | Envia texto |
| POST | /message/:id/image | Envia imagem |
| POST | /message/:id/audio | Envia áudio |
| POST | /message/:id/pdf | Envia PDF |
| POST | /message/:id/flow | Envia sequência completa |
