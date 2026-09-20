import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Perfil = {
  id: string;
  usuario: string;
  nombre: string;
  rol: "ADMINISTRADOR" | "ENCARGADO" | "PDV";
  pdv_id: string | null;
  estado: "ACTIVO" | "INACTIVO";
};

type RegistroPdv = {
  fila?: number;
  codigo?: string;
  nombre?: string;
  region?: string;
  area?: string;
  encargado_usuario?: string;
  estado?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizarUsuario(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function correoInterno(usuario: string) {
  return `${usuario.toLowerCase()}@control-logistico.local`;
}

function obtenerClaveSecreta() {
  const nuevas = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (nuevas) {
    const parsed = JSON.parse(nuevas);
    if (parsed.default) return parsed.default as string;
    const primera = Object.values(parsed)[0];
    if (typeof primera === "string") return primera;
  }

  // Compatibilidad mientras Supabase completa la migración de claves antiguas.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("La función no dispone de una clave de servidor.");
}

async function verificarPdvAsignable(
  admin: ReturnType<typeof createClient>,
  solicitante: Perfil,
  pdvId: string,
) {
  const { data: pdv, error } = await admin
    .from("pdvs")
    .select("id, encargado_id, estado")
    .eq("id", pdvId)
    .single();

  if (error || !pdv || pdv.estado !== "ACTIVO") {
    throw new Error("El PDV seleccionado no existe o está inactivo.");
  }

  if (solicitante.rol === "ENCARGADO" && pdv.encargado_id !== solicitante.id) {
    throw new Error("El PDV no pertenece al encargado autenticado.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = req.headers.get("apikey");
    const authorization = req.headers.get("Authorization");

    if (!supabaseUrl || !publishableKey || !authorization) {
      return json({ error: "Solicitud sin autenticación." }, 401);
    }

    const usuarioClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });

    const { data: authData, error: authError } = await usuarioClient.auth.getUser();
    if (authError || !authData.user) return json({ error: "Sesión inválida." }, 401);

    const { data: solicitante, error: perfilError } = await usuarioClient
      .from("perfiles")
      .select("id, usuario, nombre, rol, pdv_id, estado")
      .eq("id", authData.user.id)
      .single<Perfil>();

    if (perfilError || !solicitante || solicitante.estado !== "ACTIVO") {
      return json({ error: "El perfil no está habilitado." }, 403);
    }

    if (!['ADMINISTRADOR', 'ENCARGADO'].includes(solicitante.rol)) {
      return json({ error: "No tiene permiso para administrar cuentas." }, 403);
    }

    const admin = createClient(supabaseUrl, obtenerClaveSecreta(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json();
    const accion = String(body.accion ?? "CREAR_USUARIO").toUpperCase();

    if (accion === "IMPORTAR_PDVS") {
      if (solicitante.rol !== "ADMINISTRADOR") {
        return json({ error: "Solo el Administrador puede realizar cargas masivas de PDV." }, 403);
      }

      const registros = Array.isArray(body.registros) ? body.registros as RegistroPdv[] : [];
      if (!registros.length) return json({ error: "No se recibieron registros para importar." }, 400);
      if (registros.length > 200) return json({ error: "Cada lote admite como máximo 200 registros." }, 400);

      const { data: encargados, error: encargadosError } = await admin
        .from("perfiles")
        .select("id, usuario, rol, estado")
        .eq("rol", "ENCARGADO")
        .eq("estado", "ACTIVO");
      if (encargadosError) throw encargadosError;

      const encargadoPorUsuario = new Map(
        (encargados || []).map((perfil) => [normalizarUsuario(perfil.usuario), perfil.id as string]),
      );
      const codigosVistos = new Set<string>();
      const resultados: Array<{ fila: number; codigo: string; resultado: string; mensaje: string }> = [];
      const validos: Array<{
        fila: number;
        codigo: string;
        nombre: string;
        region: string | null;
        area: string | null;
        encargado_id: string;
        estado: string;
      }> = [];

      registros.forEach((registro, index) => {
        const filaRecibida = Number(registro?.fila);
        const fila = Number.isInteger(filaRecibida) && filaRecibida > 0 ? filaRecibida : index + 2;
        const codigo = String(registro?.codigo ?? "").trim().toUpperCase();
        const nombre = String(registro?.nombre ?? "").trim();
        const region = String(registro?.region ?? "").trim() || null;
        const area = String(registro?.area ?? "").trim() || null;
        const encargadoUsuario = normalizarUsuario(registro?.encargado_usuario);
        const estado = String(registro?.estado ?? "ACTIVO").trim().toUpperCase();
        const errores: string[] = [];

        if (!codigo) errores.push("Falta el código.");
        else if (!/^[A-Z0-9._-]{1,50}$/.test(codigo)) errores.push("Código inválido.");
        else if (codigosVistos.has(codigo)) errores.push("Código duplicado en el lote.");
        if (!nombre) errores.push("Falta el nombre.");
        if (!encargadoUsuario) errores.push("Falta el encargado.");
        const encargadoId = encargadoPorUsuario.get(encargadoUsuario);
        if (encargadoUsuario && !encargadoId) errores.push("El encargado no existe, no está activo o no tiene el rol ENCARGADO.");
        if (!["ACTIVO", "INACTIVO"].includes(estado)) errores.push("Estado inválido.");
        if (codigo) codigosVistos.add(codigo);

        if (errores.length || !encargadoId) {
          resultados.push({ fila, codigo, resultado: "RECHAZADO", mensaje: errores.join(" ") });
          return;
        }

        validos.push({ fila, codigo, nombre, region, area, encargado_id: encargadoId, estado });
      });

      if (validos.length) {
        const codigos = validos.map((registro) => registro.codigo);
        const { data: existentes, error: existentesError } = await admin
          .from("pdvs")
          .select("codigo")
          .in("codigo", codigos);
        if (existentesError) throw existentesError;
        const codigosExistentes = new Set((existentes || []).map((pdv) => String(pdv.codigo).toUpperCase()));

        const { error: upsertError } = await admin.from("pdvs").upsert(
          validos.map(({ fila: _fila, ...registro }) => registro),
          { onConflict: "codigo" },
        );
        if (upsertError) throw upsertError;

        validos.forEach((registro) => {
          const actualizado = codigosExistentes.has(registro.codigo);
          resultados.push({
            fila: registro.fila,
            codigo: registro.codigo,
            resultado: actualizado ? "ACTUALIZADO" : "CREADO",
            mensaje: actualizado ? "PDV actualizado correctamente." : "PDV creado correctamente.",
          });
        });
      }

      resultados.sort((a, b) => a.fila - b.fila);
      return json({
        ok: true,
        resumen: {
          recibidos: registros.length,
          creados: resultados.filter((row) => row.resultado === "CREADO").length,
          actualizados: resultados.filter((row) => row.resultado === "ACTUALIZADO").length,
          rechazados: resultados.filter((row) => row.resultado === "RECHAZADO").length,
        },
        resultados,
      });
    }

    if (accion === "CREAR_PDV") {
      const codigo = String(body.codigo ?? "").trim().toUpperCase();
      const nombre = String(body.nombre ?? "").trim();
      const region = String(body.region ?? "").trim() || null;
      const area = String(body.area ?? "").trim() || null;
      const encargadoId = solicitante.rol === "ENCARGADO"
        ? solicitante.id
        : String(body.encargado_id ?? "").trim() || null;

      if (!codigo || !nombre) return json({ error: "Código y nombre del PDV son obligatorios." }, 400);

      const { data, error } = await admin
        .from("pdvs")
        .insert({ codigo, nombre, region, area, encargado_id: encargadoId })
        .select("id, codigo, nombre, region, area, encargado_id, estado")
        .single();

      if (error) throw error;
      return json({ ok: true, pdv: data });
    }

    if (accion === "CREAR_USUARIO") {
      const usuario = normalizarUsuario(body.usuario);
      const nombre = String(body.nombre ?? "").trim();
      const password = String(body.password ?? "");
      const rol = String(body.rol ?? "PDV").trim().toUpperCase();
      const pdvId = String(body.pdv_id ?? "").trim() || null;

      if (!/^[A-Z0-9._-]{3,30}$/.test(usuario)) {
        return json({ error: "El usuario debe tener entre 3 y 30 caracteres válidos." }, 400);
      }
      if (!nombre) return json({ error: "El nombre es obligatorio." }, 400);
      if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres." }, 400);
      if (!['ADMINISTRADOR', 'ENCARGADO', 'PDV'].includes(rol)) {
        return json({ error: "Rol inválido." }, 400);
      }
      if (solicitante.rol === "ENCARGADO" && rol !== "PDV") {
        return json({ error: "El encargado solo puede crear cuentas PDV." }, 403);
      }
      if (rol === "PDV" && !pdvId) return json({ error: "Seleccione el PDV de la cuenta." }, 400);
      if (rol === "PDV" && pdvId) await verificarPdvAsignable(admin, solicitante, pdvId);

      const { data, error } = await admin.auth.admin.createUser({
        email: correoInterno(usuario),
        password,
        email_confirm: true,
        user_metadata: {
          usuario,
          nombre,
          rol,
          pdv_id: rol === "PDV" ? pdvId : null,
        },
      });

      if (error) throw error;
      return json({
        ok: true,
        usuario: { id: data.user.id, usuario, nombre, rol, pdv_id: rol === "PDV" ? pdvId : null },
      });
    }

    if (accion === "RESTABLECER_CLAVE") {
      const usuarioId = String(body.usuario_id ?? "").trim();
      const password = String(body.password ?? "");
      if (!usuarioId || password.length < 8) {
        return json({ error: "Usuario y contraseña de al menos 8 caracteres son obligatorios." }, 400);
      }

      const { data: objetivo, error: objetivoError } = await admin
        .from("perfiles")
        .select("id, rol, pdv_id")
        .eq("id", usuarioId)
        .single();
      if (objetivoError || !objetivo) return json({ error: "Cuenta no encontrada." }, 404);

      if (solicitante.rol === "ENCARGADO") {
        if (objetivo.rol !== "PDV" || !objetivo.pdv_id) {
          return json({ error: "No puede modificar esa cuenta." }, 403);
        }
        await verificarPdvAsignable(admin, solicitante, objetivo.pdv_id);
      }

      const { error } = await admin.auth.admin.updateUserById(usuarioId, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Error inesperado.";
    return json({ error: message }, 400);
  }
});
