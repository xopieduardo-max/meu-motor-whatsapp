-- RODE ESSE SQL NO SUPABASE SQL EDITOR
-- Acesse: supabase.com → seu projeto → SQL Editor → New Query → cole e execute

-- Tabela de instâncias (seus motores WhatsApp)
create table if not exists instances (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text default 'disconnected',
  phone text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Tabela para guardar as credenciais do WhatsApp (sessão Baileys)
create table if not exists auth_state (
  instance_id uuid not null references instances(id) on delete cascade,
  key text not null,
  value jsonb,
  primary key (instance_id, key)
);

-- Tabela de mensagens enviadas (histórico)
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid references instances(id) on delete cascade,
  to_number text not null,
  type text not null,
  content text,
  status text default 'sent',
  sent_at timestamptz default now()
);

-- Liberar acesso pela service key (necessário para o motor funcionar)
alter table instances enable row level security;
alter table auth_state enable row level security;
alter table messages enable row level security;

create policy "Service key acessa tudo em instances"
  on instances for all using (true);

create policy "Service key acessa tudo em auth_state"
  on auth_state for all using (true);

create policy "Service key acessa tudo em messages"
  on messages for all using (true);
