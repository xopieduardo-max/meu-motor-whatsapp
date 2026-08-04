-- Tabela de sequências de follow-up agendadas por contato
-- Rode no Supabase SQL Editor: supabase.com → seu projeto → SQL Editor → New Query

CREATE TABLE IF NOT EXISTS followup_enrollments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_remote_id TEXT        NOT NULL,       -- remote_id da instância WhatsApp
  contact_phone      TEXT        NOT NULL,
  user_id            UUID,
  steps              JSONB       NOT NULL DEFAULT '[]', -- [{delay_hours, message}]
  current_step       INTEGER     NOT NULL DEFAULT 0,
  next_step_at       TIMESTAMPTZ,                -- quando enviar o próximo passo
  variables          JSONB       NOT NULL DEFAULT '{}', -- {{nome}}, {{primeiro_nome}}, etc.
  status             TEXT        NOT NULL DEFAULT 'active', -- active | completed | cancelled
  cancel_on_reply    BOOLEAN     NOT NULL DEFAULT true,
  send_window_start  INTEGER     NOT NULL DEFAULT 8,   -- hora BRT (0-23)
  send_window_end    INTEGER     NOT NULL DEFAULT 20,  -- hora BRT (0-23)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para o job rodar rápido
CREATE INDEX IF NOT EXISTS idx_followup_active_next
  ON followup_enrollments (status, next_step_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_followup_phone
  ON followup_enrollments (instance_remote_id, contact_phone, status);

-- RLS (service key acessa tudo)
ALTER TABLE followup_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service key acessa tudo em followup_enrollments"
  ON followup_enrollments FOR ALL USING (true);
