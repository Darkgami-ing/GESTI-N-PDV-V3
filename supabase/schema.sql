-- Control Logistico - esquema inicial para Supabase/PostgreSQL
-- Ejecutar una sola vez en Supabase > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.pdvs (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  nombre text not null,
  region text,
  area text,
  encargado_id uuid references auth.users(id) on delete set null,
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'INACTIVO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  usuario text not null,
  nombre text not null,
  rol text not null check (rol in ('ADMINISTRADOR', 'ENCARGADO', 'PDV')),
  pdv_id uuid references public.pdvs(id) on delete restrict,
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'INACTIVO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint perfil_pdv_requerido check (
    (rol = 'PDV' and pdv_id is not null) or
    (rol in ('ADMINISTRADOR', 'ENCARGADO'))
  )
);

create unique index if not exists perfiles_usuario_lower_uidx
  on public.perfiles (lower(usuario));

create table if not exists public.operaciones (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  tipo text not null check (tipo in (
    'RECEPCION_CAMION',
    'INVERSA_CAMION',
    'RECEPCION_ENCOMIENDA',
    'INVERSA_ENCOMIENDA'
  )),
  estado text not null default 'BORRADOR' check (estado in ('BORRADOR', 'FINALIZADO', 'ANULADO')),
  pdv_id uuid not null references public.pdvs(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  id_ruta text,
  placa text,
  empresa_encomienda text,
  numero_encomienda text,
  dni_ruc_responsable text,
  latitud numeric(10,7),
  longitud numeric(10,7),
  precision_gps numeric(10,2),
  observaciones text,
  datos_extra jsonb not null default '{}'::jsonb,
  iniciada_at timestamptz not null default now(),
  finalizada_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.items_recepcion (
  id uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references public.operaciones(id) on delete cascade,
  tipo text not null check (tipo in ('SACO', 'BULTO_SUELTO')),
  codigo text not null,
  orden integer not null,
  escaneado_por uuid not null references auth.users(id) on delete restrict,
  escaneado_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (operacion_id, codigo)
);

create table if not exists public.costales (
  id uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references public.operaciones(id) on delete cascade,
  codigo text not null,
  orden integer not null,
  estado text not null default 'ABIERTO' check (estado in ('ABIERTO', 'CERRADO')),
  creado_por uuid not null references auth.users(id) on delete restrict,
  abierto_at timestamptz not null default now(),
  cerrado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operacion_id, codigo)
);

create table if not exists public.paquetes (
  id uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references public.operaciones(id) on delete cascade,
  costal_id uuid not null references public.costales(id) on delete cascade,
  codigo text not null,
  orden integer not null,
  escaneado_por uuid not null references auth.users(id) on delete restrict,
  escaneado_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (operacion_id, codigo)
);

create table if not exists public.precintos (
  id uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references public.operaciones(id) on delete cascade,
  etapa text not null check (etapa in ('LLEGADA', 'SALIDA')),
  numero smallint not null check (numero between 1 and 4),
  codigo text not null,
  registrado_por uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (operacion_id, etapa, numero),
  unique (operacion_id, codigo)
);

create table if not exists public.evidencias (
  id uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references public.operaciones(id) on delete cascade,
  categoria text not null check (categoria in (
    'LLEGADA_UNIDAD',
    'INTERIOR_UNIDAD',
    'PRECINTO_LLEGADA',
    'CARGA_RECIBIDA',
    'LOGISTICA_INVERSA',
    'PRECINTO_SALIDA',
    'EVIDENCIA_GENERAL'
  )),
  etiqueta text not null,
  referencia_codigo text,
  drive_file_id text not null,
  nombre_archivo text,
  mime_type text,
  registrado_por uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (drive_file_id)
);

create index if not exists operaciones_pdv_fecha_idx
  on public.operaciones (pdv_id, created_at desc);
create index if not exists operaciones_tipo_estado_idx
  on public.operaciones (tipo, estado, created_at desc);
create index if not exists items_recepcion_operacion_idx
  on public.items_recepcion (operacion_id, orden);
create index if not exists costales_operacion_idx
  on public.costales (operacion_id, orden);
create index if not exists paquetes_costal_idx
  on public.paquetes (costal_id, orden);
create index if not exists paquetes_operacion_idx
  on public.paquetes (operacion_id, escaneado_at);
create index if not exists evidencias_operacion_idx
  on public.evidencias (operacion_id, created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pdvs_set_updated_at on public.pdvs;
create trigger pdvs_set_updated_at
before update on public.pdvs
for each row execute function public.set_updated_at();

drop trigger if exists perfiles_set_updated_at on public.perfiles;
create trigger perfiles_set_updated_at
before update on public.perfiles
for each row execute function public.set_updated_at();

drop trigger if exists operaciones_set_updated_at on public.operaciones;
create trigger operaciones_set_updated_at
before update on public.operaciones
for each row execute function public.set_updated_at();

drop trigger if exists costales_set_updated_at on public.costales;
create trigger costales_set_updated_at
before update on public.costales
for each row execute function public.set_updated_at();

create or replace function public.crear_perfil_desde_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rol text;
  v_pdv_id uuid;
begin
  -- Las cuentas creadas desde la función administrativa sí incluyen el rol.
  -- Si una cuenta se crea manualmente en el panel (primer administrador),
  -- el perfil se inserta de forma explícita siguiendo el README.
  if nullif(new.raw_user_meta_data ->> 'rol', '') is null then
    return new;
  end if;

  v_rol := upper(new.raw_user_meta_data ->> 'rol');

  if new.raw_user_meta_data ? 'pdv_id'
     and nullif(new.raw_user_meta_data ->> 'pdv_id', '') is not null then
    v_pdv_id := (new.raw_user_meta_data ->> 'pdv_id')::uuid;
  end if;

  insert into public.perfiles (id, usuario, nombre, rol, pdv_id, estado)
  values (
    new.id,
    upper(coalesce(new.raw_user_meta_data ->> 'usuario', split_part(new.email, '@', 1))),
    coalesce(new.raw_user_meta_data ->> 'nombre', upper(split_part(new.email, '@', 1))),
    v_rol,
    v_pdv_id,
    'ACTIVO'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_control_logistico on auth.users;
create trigger on_auth_user_created_control_logistico
after insert on auth.users
for each row execute function public.crear_perfil_desde_auth();

create or replace function public.rol_actual()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.rol
  from public.perfiles p
  where p.id = auth.uid() and p.estado = 'ACTIVO'
  limit 1;
$$;

create or replace function public.pdv_actual()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.pdv_id
  from public.perfiles p
  where p.id = auth.uid() and p.estado = 'ACTIVO'
  limit 1;
$$;

create or replace function public.puede_ver_pdv(p_pdv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.perfiles p
    where p.id = auth.uid()
      and p.estado = 'ACTIVO'
      and (
        p.rol = 'ADMINISTRADOR'
        or (p.rol = 'ENCARGADO' and exists (
          select 1 from public.pdvs d
          where d.id = p_pdv_id
            and d.encargado_id = auth.uid()
            and d.estado = 'ACTIVO'
        ))
        or (p.rol = 'PDV' and p.pdv_id = p_pdv_id)
      )
  );
$$;

create or replace function public.puede_editar_operacion(p_operacion_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.operaciones o
    where o.id = p_operacion_id
      and public.puede_ver_pdv(o.pdv_id)
      and (o.estado = 'BORRADOR' or public.rol_actual() = 'ADMINISTRADOR')
  );
$$;

create or replace function public.validar_costal_paquete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operacion uuid;
  v_estado text;
begin
  select c.operacion_id, c.estado
    into v_operacion, v_estado
  from public.costales c
  where c.id = new.costal_id;

  if v_operacion is null or v_operacion <> new.operacion_id then
    raise exception 'El costal no pertenece a la operación.';
  end if;

  if v_estado <> 'ABIERTO' then
    raise exception 'El costal está cerrado.';
  end if;

  return new;
end;
$$;

drop trigger if exists paquetes_validar_costal on public.paquetes;
create trigger paquetes_validar_costal
before insert or update on public.paquetes
for each row execute function public.validar_costal_paquete();

create or replace function public.finalizar_operacion(
  p_operacion_id uuid,
  p_latitud numeric,
  p_longitud numeric,
  p_precision numeric,
  p_dni_ruc text default null,
  p_observaciones text default null,
  p_datos_extra jsonb default '{}'::jsonb
)
returns public.operaciones
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operacion public.operaciones;
  v_items integer;
  v_costales integer;
  v_paquetes integer;
  v_costales_abiertos integer;
  v_evidencias integer;
begin
  select * into v_operacion
  from public.operaciones
  where id = p_operacion_id
  for update;

  if v_operacion.id is null or not public.puede_editar_operacion(p_operacion_id) then
    raise exception 'No tiene permiso para finalizar esta operación.';
  end if;

  select count(*) into v_evidencias
  from public.evidencias where operacion_id = p_operacion_id;

  if v_evidencias = 0 then
    raise exception 'Debe registrar al menos una evidencia fotográfica.';
  end if;

  if v_operacion.tipo in ('RECEPCION_CAMION', 'RECEPCION_ENCOMIENDA') then
    select count(*) into v_items
    from public.items_recepcion where operacion_id = p_operacion_id;
    if v_items = 0 then
      raise exception 'Debe escanear al menos un saco o bulto.';
    end if;
  else
    select count(*) into v_costales
    from public.costales where operacion_id = p_operacion_id;
    select count(*) into v_paquetes
    from public.paquetes where operacion_id = p_operacion_id;
    select count(*) into v_costales_abiertos
    from public.costales where operacion_id = p_operacion_id and estado = 'ABIERTO';

    if v_costales = 0 or v_paquetes = 0 then
      raise exception 'Debe registrar costales y paquetes.';
    end if;
    if v_costales_abiertos > 0 then
      raise exception 'Cierre todos los costales antes de finalizar.';
    end if;
  end if;

  update public.operaciones
  set estado = 'FINALIZADO',
      finalizada_at = now(),
      latitud = p_latitud,
      longitud = p_longitud,
      precision_gps = p_precision,
      dni_ruc_responsable = nullif(trim(p_dni_ruc), ''),
      observaciones = nullif(trim(p_observaciones), ''),
      datos_extra = coalesce(p_datos_extra, '{}'::jsonb)
  where id = p_operacion_id
  returning * into v_operacion;

  return v_operacion;
end;
$$;

alter table public.pdvs enable row level security;
alter table public.perfiles enable row level security;
alter table public.operaciones enable row level security;
alter table public.items_recepcion enable row level security;
alter table public.costales enable row level security;
alter table public.paquetes enable row level security;
alter table public.precintos enable row level security;
alter table public.evidencias enable row level security;

drop policy if exists pdvs_select on public.pdvs;
create policy pdvs_select on public.pdvs
for select to authenticated
using (public.puede_ver_pdv(id));

drop policy if exists perfiles_select on public.perfiles;
create policy perfiles_select on public.perfiles
for select to authenticated
using (
  id = auth.uid()
  or public.rol_actual() = 'ADMINISTRADOR'
  or (
    public.rol_actual() = 'ENCARGADO'
    and rol = 'PDV'
    and exists (
      select 1 from public.pdvs d
      where d.id = perfiles.pdv_id and d.encargado_id = auth.uid()
    )
  )
);

drop policy if exists perfiles_update_nombre on public.perfiles;
create policy perfiles_update_nombre on public.perfiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists operaciones_select on public.operaciones;
create policy operaciones_select on public.operaciones
for select to authenticated
using (public.puede_ver_pdv(pdv_id));

drop policy if exists operaciones_insert on public.operaciones;
create policy operaciones_insert on public.operaciones
for insert to authenticated
with check (created_by = auth.uid() and public.puede_ver_pdv(pdv_id));

drop policy if exists operaciones_update on public.operaciones;
create policy operaciones_update on public.operaciones
for update to authenticated
using (public.puede_editar_operacion(id))
with check (public.puede_ver_pdv(pdv_id));

drop policy if exists operaciones_delete_admin on public.operaciones;
create policy operaciones_delete_admin on public.operaciones
for delete to authenticated
using (public.rol_actual() = 'ADMINISTRADOR');

drop policy if exists items_select on public.items_recepcion;
create policy items_select on public.items_recepcion
for select to authenticated
using (exists (
  select 1 from public.operaciones o
  where o.id = operacion_id and public.puede_ver_pdv(o.pdv_id)
));

drop policy if exists items_insert on public.items_recepcion;
create policy items_insert on public.items_recepcion
for insert to authenticated
with check (
  escaneado_por = auth.uid()
  and public.puede_editar_operacion(operacion_id)
);

drop policy if exists items_update on public.items_recepcion;
create policy items_update on public.items_recepcion
for update to authenticated
using (public.puede_editar_operacion(operacion_id))
with check (public.puede_editar_operacion(operacion_id));

drop policy if exists items_delete on public.items_recepcion;
create policy items_delete on public.items_recepcion
for delete to authenticated
using (public.puede_editar_operacion(operacion_id));

drop policy if exists costales_select on public.costales;
create policy costales_select on public.costales
for select to authenticated
using (exists (
  select 1 from public.operaciones o
  where o.id = operacion_id and public.puede_ver_pdv(o.pdv_id)
));

drop policy if exists costales_insert on public.costales;
create policy costales_insert on public.costales
for insert to authenticated
with check (creado_por = auth.uid() and public.puede_editar_operacion(operacion_id));

drop policy if exists costales_update on public.costales;
create policy costales_update on public.costales
for update to authenticated
using (public.puede_editar_operacion(operacion_id))
with check (public.puede_editar_operacion(operacion_id));

drop policy if exists costales_delete on public.costales;
create policy costales_delete on public.costales
for delete to authenticated
using (public.puede_editar_operacion(operacion_id));

drop policy if exists paquetes_select on public.paquetes;
create policy paquetes_select on public.paquetes
for select to authenticated
using (exists (
  select 1 from public.operaciones o
  where o.id = operacion_id and public.puede_ver_pdv(o.pdv_id)
));

drop policy if exists paquetes_insert on public.paquetes;
create policy paquetes_insert on public.paquetes
for insert to authenticated
with check (escaneado_por = auth.uid() and public.puede_editar_operacion(operacion_id));

drop policy if exists paquetes_update on public.paquetes;
create policy paquetes_update on public.paquetes
for update to authenticated
using (public.puede_editar_operacion(operacion_id))
with check (public.puede_editar_operacion(operacion_id));

drop policy if exists paquetes_delete on public.paquetes;
create policy paquetes_delete on public.paquetes
for delete to authenticated
using (public.puede_editar_operacion(operacion_id));

drop policy if exists precintos_select on public.precintos;
create policy precintos_select on public.precintos
for select to authenticated
using (exists (
  select 1 from public.operaciones o
  where o.id = operacion_id and public.puede_ver_pdv(o.pdv_id)
));

drop policy if exists precintos_write on public.precintos;
create policy precintos_write on public.precintos
for all to authenticated
using (public.puede_editar_operacion(operacion_id))
with check (registrado_por = auth.uid() and public.puede_editar_operacion(operacion_id));

drop policy if exists evidencias_select on public.evidencias;
create policy evidencias_select on public.evidencias
for select to authenticated
using (exists (
  select 1 from public.operaciones o
  where o.id = operacion_id and public.puede_ver_pdv(o.pdv_id)
));

drop policy if exists evidencias_insert on public.evidencias;
create policy evidencias_insert on public.evidencias
for insert to authenticated
with check (registrado_por = auth.uid() and public.puede_editar_operacion(operacion_id));

drop policy if exists evidencias_delete on public.evidencias;
create policy evidencias_delete on public.evidencias
for delete to authenticated
using (public.puede_editar_operacion(operacion_id));

revoke all on public.pdvs, public.perfiles, public.operaciones,
  public.items_recepcion, public.costales, public.paquetes,
  public.precintos, public.evidencias from anon;

grant select on public.pdvs, public.perfiles to authenticated;
grant update (nombre) on public.perfiles to authenticated;
grant select, insert, delete on public.operaciones to authenticated;
grant select, insert, update, delete on public.items_recepcion to authenticated;
grant select, insert, update, delete on public.costales to authenticated;
grant select, insert, update, delete on public.paquetes to authenticated;
grant select, insert, update, delete on public.precintos to authenticated;
grant select, insert, delete on public.evidencias to authenticated;
revoke execute on function public.rol_actual() from public, anon;
revoke execute on function public.pdv_actual() from public, anon;
revoke execute on function public.puede_ver_pdv(uuid) from public, anon;
revoke execute on function public.puede_editar_operacion(uuid) from public, anon;
revoke execute on function public.finalizar_operacion(uuid, numeric, numeric, numeric, text, text, jsonb) from public, anon;

grant execute on function public.rol_actual() to authenticated;
grant execute on function public.pdv_actual() to authenticated;
grant execute on function public.puede_ver_pdv(uuid) to authenticated;
grant execute on function public.puede_editar_operacion(uuid) to authenticated;
grant execute on function public.finalizar_operacion(uuid, numeric, numeric, numeric, text, text, jsonb) to authenticated;

create or replace view public.v_resumen_operaciones
with (security_invoker = true)
as
select
  o.id,
  o.codigo,
  o.tipo,
  o.estado,
  o.pdv_id,
  d.codigo as pdv_codigo,
  d.nombre as pdv_nombre,
  o.id_ruta,
  o.placa,
  o.empresa_encomienda,
  o.numero_encomienda,
  o.created_at,
  o.finalizada_at,
  (select count(*) from public.items_recepcion i where i.operacion_id = o.id) as total_recibidos,
  (select count(*) from public.costales c where c.operacion_id = o.id) as total_costales,
  (select count(*) from public.paquetes p where p.operacion_id = o.id) as total_paquetes,
  (select count(*) from public.evidencias e where e.operacion_id = o.id) as total_evidencias
from public.operaciones o
join public.pdvs d on d.id = o.pdv_id;

grant select on public.v_resumen_operaciones to authenticated;
