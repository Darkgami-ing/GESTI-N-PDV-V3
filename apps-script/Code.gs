/**
 * Puente seguro entre GitHub Pages/Supabase y Google Drive.
 *
 * 1. Reemplazar CARPETA_EVIDENCIAS_ID.
 * 2. Implementar como Aplicación web, ejecutar como propietario.
 * 3. Acceso: cualquier usuario con el enlace.
 * 4. Copiar la URL /exec en config.js como DRIVE_API_URL.
 *
 * No colocar una Secret key ni service_role en este archivo.
 */

const CARPETA_EVIDENCIAS_ID = 'REEMPLAZAR_CON_ID_DE_CARPETA';
const SUPABASE_URL = 'https://qtgcpmpbtfhvoasncmkg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_tj-kyp78upcwyrLbhMTqaA_l3lfRpt8';
const MAX_BYTES_SUBIDA = 6 * 1024 * 1024;
const MAX_BYTES_LECTURA = 8 * 1024 * 1024;

function doGet() {
  return responder_({ ok: true, servicio: 'CONTROL_LOGISTICO_EVIDENCIAS', version: '1.0.0' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const accion = String(body.accion || '').trim().toUpperCase();
    const usuario = validarSesion_(body.accessToken);

    if (accion === 'SUBIR_EVIDENCIA') return subirEvidencia_(body, usuario);
    if (accion === 'OBTENER_EVIDENCIA') return obtenerEvidencia_(body, usuario);
    if (accion === 'ELIMINAR_EVIDENCIA') return eliminarEvidencia_(body, usuario);

    throw new Error('Acción no reconocida.');
  } catch (error) {
    return responder_({ ok: false, error: obtenerMensaje_(error) });
  }
}

function validarSesion_(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('Sesión no enviada.');

  const hash = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)
  ).slice(0, 40);
  const cache = CacheService.getScriptCache();
  const cacheado = cache.get('auth:' + hash);
  if (cacheado) return JSON.parse(cacheado);

  const respuesta = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/user', {
    method: 'get',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: 'Bearer ' + token
    },
    muteHttpExceptions: true
  });

  if (respuesta.getResponseCode() !== 200) throw new Error('La sesión venció o no es válida.');
  const usuario = JSON.parse(respuesta.getContentText());
  if (!usuario || !usuario.id) throw new Error('No se pudo identificar al usuario.');

  const seguro = { id: usuario.id, email: usuario.email || '' };
  cache.put('auth:' + hash, JSON.stringify(seguro), 300);
  return seguro;
}

function subirEvidencia_(body, usuario) {
  if (CARPETA_EVIDENCIAS_ID === 'REEMPLAZAR_CON_ID_DE_CARPETA') {
    throw new Error('Falta configurar CARPETA_EVIDENCIAS_ID.');
  }

  const dataUrl = String(body.dataUrl || '');
  const match = dataUrl.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/);
  if (!match) throw new Error('El archivo no tiene un formato válido.');

  const mimeType = match[1];
  if (!/^image\/(jpeg|png|webp)$/i.test(mimeType) && mimeType !== 'application/pdf') {
    throw new Error('Solo se permiten imágenes JPG, PNG, WEBP o PDF.');
  }

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_BYTES_SUBIDA) throw new Error('El archivo supera 6 MB.');

  const extension = mimeType === 'application/pdf'
    ? 'pdf'
    : mimeType.toLowerCase().includes('png')
      ? 'png'
      : mimeType.toLowerCase().includes('webp') ? 'webp' : 'jpg';
  const operacion = limpiarNombre_(body.codigoOperacion || 'OPERACION');
  const categoria = limpiarNombre_(body.categoria || 'EVIDENCIA');
  const referencia = limpiarNombre_(body.referenciaCodigo || 'GENERAL');
  const marca = Utilities.formatDate(new Date(), 'America/Lima', 'yyyyMMdd_HHmmss_SSS');
  const nombre = [operacion, categoria, referencia, marca].join('_') + '.' + extension;

  const blob = Utilities.newBlob(bytes, mimeType, nombre);
  const archivo = DriveApp.getFolderById(CARPETA_EVIDENCIAS_ID).createFile(blob);
  archivo.setDescription(JSON.stringify({
    usuarioId: usuario.id,
    codigoOperacion: String(body.codigoOperacion || ''),
    categoria: String(body.categoria || ''),
    referenciaCodigo: String(body.referenciaCodigo || ''),
    creado: new Date().toISOString()
  }));

  return responder_({
    ok: true,
    fileId: archivo.getId(),
    nombre: archivo.getName(),
    mimeType: archivo.getMimeType()
  });
}

function obtenerEvidencia_(body, usuario) {
  const fileId = String(body.fileId || '').trim();
  if (!fileId) throw new Error('Falta el identificador de la evidencia.');
  verificarAccesoEvidencia_(fileId, String(body.accessToken || ''));

  const archivo = DriveApp.getFileById(fileId);
  const blob = archivo.getBlob();
  if (blob.getBytes().length > MAX_BYTES_LECTURA) {
    throw new Error('La evidencia es demasiado grande para previsualizarse.');
  }

  return responder_({
    ok: true,
    fileId: fileId,
    nombre: archivo.getName(),
    mimeType: blob.getContentType(),
    dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes())
  });
}

function eliminarEvidencia_(body, usuario) {
  const fileId = String(body.fileId || '').trim();
  if (!fileId) throw new Error('Falta el identificador de la evidencia.');
  const registro = obtenerRegistroEvidencia_(fileId, String(body.accessToken || ''));
  const archivo = DriveApp.getFileById(fileId);
  archivo.setTrashed(true);
  return responder_({ ok: true, fileId: fileId, categoria: registro.categoria });
}

function verificarAccesoEvidencia_(fileId, accessToken) {
  obtenerRegistroEvidencia_(fileId, accessToken);
}

function obtenerRegistroEvidencia_(fileId, accessToken) {
  const filtro = encodeURIComponent(fileId);
  const url = SUPABASE_URL + '/rest/v1/evidencias?drive_file_id=eq.' + filtro + '&select=id,categoria,operacion_id&limit=1';
  const respuesta = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  if (respuesta.getResponseCode() !== 200) throw new Error('No se pudo validar la evidencia.');
  const filas = JSON.parse(respuesta.getContentText() || '[]');
  if (!filas.length) throw new Error('No tiene permiso para ver esta evidencia.');
  return filas[0];
}

function limpiarNombre_(valor) {
  const limpio = String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return limpio || 'SIN-CODIGO';
}

function responder_(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

function obtenerMensaje_(error) {
  return error && error.message ? error.message : String(error || 'Error inesperado.');
}
