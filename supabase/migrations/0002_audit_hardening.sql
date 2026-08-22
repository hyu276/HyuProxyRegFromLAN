-- Audit hardening: least-privilege grants, faster RLS, command leases, and device removal.

alter table public.lan_agent_commands
  add column if not exists attempt_count smallint not null default 0;

do $$
begin
  alter table public.lan_agent_commands
    add constraint lan_agent_commands_attempt_count_check
    check (attempt_count between 0 and 20);
exception when duplicate_object then
  null;
end $$;

create index if not exists lan_pairing_requests_agent_id_idx
  on public.lan_pairing_requests(agent_id);
create index if not exists lan_proxies_health_idx
  on public.lan_proxies(agent_id, healthy, enabled);
create index if not exists lan_agent_commands_user_idx
  on public.lan_agent_commands(user_id, created_at desc);
create index if not exists lan_agent_events_agent_idx
  on public.lan_agent_events(agent_id, created_at desc);

-- Supabase projects created with older defaults can auto-grant broad Data API
-- privileges to anon/authenticated. Remove those defaults from this app's tables
-- and grant back only what the browser genuinely needs.
revoke all privileges on table public.lan_agents from anon, authenticated;
revoke all privileges on table public.lan_agent_credentials from anon, authenticated;
revoke all privileges on table public.lan_pairing_requests from anon, authenticated;
revoke all privileges on table public.lan_proxies from anon, authenticated;
revoke all privileges on table public.lan_agent_commands from anon, authenticated;
revoke all privileges on table public.lan_agent_events from anon, authenticated;

grant select, delete on table public.lan_agents to authenticated;
grant select, delete on table public.lan_pairing_requests to authenticated;
grant select on table public.lan_proxies to authenticated;
grant select, insert on table public.lan_agent_commands to authenticated;
grant select on table public.lan_agent_events to authenticated;

-- Rebuild policies with initPlan-friendly auth.uid() calls.
drop policy if exists "lan_agents_select_own" on public.lan_agents;
drop policy if exists "lan_agents_delete_own" on public.lan_agents;
drop policy if exists "lan_pairing_select_own" on public.lan_pairing_requests;
drop policy if exists "lan_pairing_delete_own" on public.lan_pairing_requests;
drop policy if exists "lan_proxies_select_own" on public.lan_proxies;
drop policy if exists "lan_commands_select_own" on public.lan_agent_commands;
drop policy if exists "lan_commands_insert_own" on public.lan_agent_commands;
drop policy if exists "lan_events_select_own" on public.lan_agent_events;

create policy "lan_agents_select_own"
on public.lan_agents
for select to authenticated
using (user_id = (select auth.uid()));

create policy "lan_agents_delete_own"
on public.lan_agents
for delete to authenticated
using (user_id = (select auth.uid()));

create policy "lan_pairing_select_own"
on public.lan_pairing_requests
for select to authenticated
using (user_id = (select auth.uid()));

create policy "lan_pairing_delete_own"
on public.lan_pairing_requests
for delete to authenticated
using (
  user_id = (select auth.uid())
  and claimed_at is null
);

create policy "lan_proxies_select_own"
on public.lan_proxies
for select to authenticated
using (
  exists (
    select 1
    from public.lan_agents a
    where a.id = lan_proxies.agent_id
      and a.user_id = (select auth.uid())
  )
);

create policy "lan_commands_select_own"
on public.lan_agent_commands
for select to authenticated
using (user_id = (select auth.uid()));

create policy "lan_commands_insert_own"
on public.lan_agent_commands
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.lan_agents a
    where a.id = lan_agent_commands.agent_id
      and a.user_id = (select auth.uid())
  )
);

create policy "lan_events_select_own"
on public.lan_agent_events
for select to authenticated
using (
  exists (
    select 1
    from public.lan_agents a
    where a.id = lan_agent_events.agent_id
      and a.user_id = (select auth.uid())
  )
);

-- Keep at most one currently-valid unclaimed pairing key per user.
create or replace function public.lan_create_pairing_key()
returns table(pairing_key text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_exp timestamptz := now() + interval '10 minutes';
begin
  if v_user is null then
    raise exception 'authentication required';
  end if;

  delete from public.lan_pairing_requests
  where user_id = v_user
    and claimed_at is null;

  v_code := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12));

  insert into public.lan_pairing_requests(user_id, code_hash, expires_at)
  values (
    v_user,
    encode(extensions.digest(v_code, 'sha256'), 'hex'),
    v_exp
  );

  return query select v_code, v_exp;
end;
$$;

-- Functions in public can inherit default EXECUTE grants on older Supabase
-- projects. Explicitly remove anon/PUBLIC and keep only the intended callers.
revoke execute on function public.lan_create_pairing_key() from public, anon;
grant execute on function public.lan_create_pairing_key() to authenticated;

revoke execute on function public.lan_claim_pairing(text,text,text,text,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.lan_claim_pairing(text,text,text,text,jsonb,text)
  to service_role;
