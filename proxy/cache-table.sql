-- Caché del proxy de Meteocat.
-- No guarda nada personal: solo la ruta pedida a la API pública y su respuesta.
create table if not exists public.meteocat_cache (
  url        text primary key,
  body       text        not null,
  fetched_at timestamptz not null default now()
);

create index if not exists meteocat_cache_fetched_at_idx
  on public.meteocat_cache (fetched_at);

-- RLS activada y sin políticas: nadie llega a esta tabla con la clave anónima; solo la Edge
-- Function, que usa el service role y se salta RLS. Es intencionado.
alter table public.meteocat_cache enable row level security;

-- Para ver cuántas llamadas reales estás haciendo a Meteocat (la cuota es mensual):
--   select count(*), date_trunc('day', fetched_at) as dia
--   from public.meteocat_cache group by dia order by dia desc;
