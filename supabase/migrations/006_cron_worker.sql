-- 006 — Programación del worker inbound vía pg_cron + pg_net (Decisión 4)
--
-- El job NO se agenda dentro de la migración: la URL de la función es por
-- entorno. Se expone una función de ops (service_role only) que agenda o
-- reagenda de forma idempotente (cron.schedule con el mismo jobname reemplaza).
--
-- El service key JAMÁS queda en texto plano en el comando agendado: el
-- comando lee el secreto del Vault EN CADA ejecución.
--
-- Uso por entorno (una vez, desde SQL editor con service_role):
--   select vault.create_secret('<service_role_key>', 'service_role_key',
--                              'Para que pg_cron invoque las Edge Functions');
--   select schedule_worker_cron('https://<proyecto>.supabase.co/functions/v1/worker-sync');
-- Para detener: select cron.unschedule('drain-sync-jobs');

create or replace function schedule_worker_cron(
  p_function_url text,
  p_secret_name  text default 'service_role_key',
  p_schedule     text default '* * * * *'
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmd text;
begin
  if not exists (select 1 from vault.secrets where name = p_secret_name) then
    raise exception 'No existe el secreto "%" en Vault: crearlo antes con vault.create_secret', p_secret_name;
  end if;

  v_cmd := format(
    $cmd$select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = %L)),
      body := '{}'::jsonb);$cmd$,
    p_function_url, p_secret_name);

  return cron.schedule('drain-sync-jobs', p_schedule, v_cmd);
end;
$$;

revoke all on function schedule_worker_cron(text, text, text) from public, anon, authenticated;
grant execute on function schedule_worker_cron(text, text, text) to service_role;
