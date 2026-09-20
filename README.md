# Control Logístico PDV

Aplicación móvil para GitHub Pages con Supabase como base de datos y autenticación, y Google Drive como repositorio privado de evidencias.

## Operaciones incluidas

1. Recepción de camión exclusivo: llegada, precintos, sacos/bultos, fotografías, GPS y precintos de salida.
2. Logística inversa de camión exclusivo: costales identificados por código de barras y paquetes asociados a cada costal.
3. Recepción de encomiendas: escaneo de sacos, fotografías y GPS.
4. Logística inversa por encomienda: costales identificados por código de barras y paquetes asociados a cada costal.

Los paquetes no se guardan como texto dentro del costal. Cada uno mantiene una relación individual `operación → costal → paquete`, lo que permite buscarlo y auditarlo.

## Archivos

- `index.html`, `styles.css`, `app.js`: interfaz GitHub Pages.
- `config.js`: URL y clave publicable de Supabase y endpoint de Apps Script.
- `supabase/schema.sql`: tablas, índices, validaciones y políticas RLS.
- `supabase/functions/crear-usuario/index.ts`: creación segura de PDV y cuentas.
- `apps-script/Code.gs`: subida y lectura autorizada de fotografías privadas en Drive.

## 1. Configurar Supabase

1. Abrir el proyecto de Supabase.
2. Ir a **SQL Editor**.
3. Crear una consulta nueva, pegar todo `supabase/schema.sql` y ejecutarla.
4. Ir a **Authentication → Providers → Email** y desactivar el registro público de usuarios. Las cuentas se crearán desde el panel administrativo de la aplicación.

### Crear el primer administrador

1. Ir a **Authentication → Users → Add user**.
2. Crear el usuario con el correo interno `admin@control-logistico.local`, una contraseña segura y la opción de confirmar automáticamente el correo.
3. Copiar el UUID del usuario recién creado.
4. Ejecutar en SQL Editor, reemplazando `UUID_DEL_USUARIO`:

```sql
insert into public.perfiles (id, usuario, nombre, rol, estado)
values (
  'UUID_DEL_USUARIO',
  'ADMIN',
  'ADMINISTRADOR PRINCIPAL',
  'ADMINISTRADOR',
  'ACTIVO'
);
```

Después podrá ingresar en la web con usuario `ADMIN` y la contraseña elegida.

### Publicar la función de administración

La función `crear-usuario` mantiene las claves de servidor dentro de Supabase; ninguna clave secreta llega a GitHub o al navegador.

Con Supabase CLI:

```bash
supabase login
supabase link --project-ref qtgcpmpbtfhvoasncmkg
supabase functions deploy crear-usuario
```

También se puede crear la función desde el panel de Supabase copiando `supabase/functions/crear-usuario/index.ts`.

### Carga masiva de PDV

El Administrador puede descargar una plantilla Excel desde **Usuarios → Carga masiva de PDV**. La hoja admite hasta 1,000 registros y utiliza las columnas:

- `CODIGO_PDV`
- `NOMBRE_PDV`
- `REGION`
- `AREA`
- `USUARIO_ENCARGADO`
- `USUARIO_PDV`
- `CONTRASENA_TEMPORAL`
- `ESTADO`

Los encargados deben existir previamente y estar activos. El Administrador define en el archivo el usuario y la contraseña de cada PDV; la contraseña debe tener entre 8 y 72 caracteres. Antes de importar se muestra una vista previa que oculta las contraseñas. Los códigos nuevos se crean y los códigos existentes se actualizan. Si ya existe una cuenta PDV asociada al mismo PDV y con el mismo usuario, se actualiza su contraseña; si el PDV ya tiene otro usuario, o la cuenta está relacionada con otro PDV u otro rol, la fila se rechaza. El procesamiento se realiza en lotes de 25 registros mediante la función Edge `crear-usuario`.

La descarga del resultado incluye la contraseña indicada para facilitar la entrega de credenciales. Proteja ese archivo y elimínelo cuando ya no sea necesario; no use la contraseña del ejemplo de la plantilla en producción. Si el PDV se guarda pero falla la cuenta, el resultado queda marcado como `PARCIAL` para corregirlo sin perder el registro del PDV.

## 2. Configurar Google Drive

1. Crear una carpeta exclusiva para evidencias.
2. Copiar el identificador de la carpeta desde su URL.
3. Crear un proyecto nuevo de Google Apps Script.
4. Reemplazar el contenido por `apps-script/Code.gs`.
5. Sustituir `REEMPLAZAR_CON_ID_DE_CARPETA` por el identificador real.
6. Implementar como **Aplicación web**:
   - Ejecutar como: propietario.
   - Quién tiene acceso: cualquier usuario con el enlace.
7. Copiar la URL terminada en `/exec` y colocarla en `config.js`:

```js
DRIVE_API_URL: "URL_DE_APPS_SCRIPT/exec",
```

Aunque la aplicación web de Apps Script acepte solicitudes, cada acción valida la sesión de Supabase. Los archivos de Drive no se comparten públicamente; las evidencias se cargan bajo demanda después de comprobar las políticas RLS.

## 3. Probar y publicar

1. Abrir la aplicación desde GitHub Pages usando HTTPS. La cámara y el GPS no funcionarán correctamente en HTTP.
2. Ingresar con el primer administrador.
3. Crear un Encargado.
4. Crear un PDV asignándolo al Encargado.
5. Crear la cuenta PDV.
6. Probar una operación de cada tipo desde un iPhone.
7. Confirmar que Administrador, Encargado y PDV solo consultan los registros permitidos.

## Seguridad

- Solo `SUPABASE_PUBLISHABLE_KEY` puede estar en el frontend.
- No guardar nunca `sb_secret_...` ni `service_role` en GitHub, Apps Script, HTML o mensajes.
- Las políticas RLS determinan el acceso real; ocultar botones no se considera una medida de seguridad.
- Las evidencias permanecen privadas en Drive y se solicitan con una sesión válida.
