(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const TYPE_LABELS = {
    RECEPCION_CAMION: "Recepción de camión exclusivo",
    INVERSA_CAMION: "Logística inversa de camión exclusivo",
    RECEPCION_ENCOMIENDA: "Recepción de encomiendas",
    INVERSA_ENCOMIENDA: "Logística inversa por encomienda",
  };
  const TYPE_PREFIX = {
    RECEPCION_CAMION: "RC",
    INVERSA_CAMION: "IC",
    RECEPCION_ENCOMIENDA: "RE",
    INVERSA_ENCOMIENDA: "IE",
  };
  const STATUS_LABELS = {
    PENDIENTE: "Pendiente",
    EN_PROCESO: "En proceso",
    COMPLETADO: "Completado",
    ANULADO: "Anulado",
    BORRADOR: "Pendiente",
    FINALIZADO: "Completado",
  };
  const RECEIPT_TYPES = new Set(["RECEPCION_CAMION", "RECEPCION_ENCOMIENDA"]);
  const INVERSE_TYPES = new Set(["INVERSA_CAMION", "INVERSA_ENCOMIENDA"]);
  const BULK_PDV_HEADERS = ["CODIGO_PDV", "NOMBRE_PDV", "REGION", "AREA", "USUARIO_ENCARGADO", "USUARIO_PDV", "CONTRASENA_TEMPORAL", "ESTADO"];
  const BULK_PDV_MAX_ROWS = 1000;
  const BULK_PDV_BATCH_SIZE = 25;
  const BULK_PDV_MAX_FILE_BYTES = 5 * 1024 * 1024;

  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_PUBLISHABLE_KEY || !window.supabase) {
    document.body.innerHTML = '<div class="empty-state" style="margin:30px">Falta configurar Supabase en config.js.</div>';
    return;
  }

  const db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const state = {
    session: null,
    profile: null,
    pdvs: [],
    users: [],
    bulkPdvRows: [],
    bulkPdvResults: [],
    selectedType: "",
    operation: null,
    items: [],
    sacks: [],
    packages: [],
    seals: [],
    evidences: [],
    transportGuide: null,
    receiptItemType: "SACO",
    activeSack: null,
    photoDrafts: new Map(),
    inversePhotos: [],
    parcelPhotos: [],
    gps: null,
    scanner: {
      reader: null,
      devices: [],
      deviceIndex: 0,
      mode: "",
      inputId: "",
      active: false,
      locked: false,
      lastCode: "",
      lastAt: 0,
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const normalizeCode = (value) => String(value ?? "").trim().toUpperCase();
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const isReceipt = () => RECEIPT_TYPES.has(state.operation?.tipo || state.selectedType);
  const isInverse = () => INVERSE_TYPES.has(state.operation?.tipo || state.selectedType);
  const isTruckReceipt = () => (state.operation?.tipo || state.selectedType) === "RECEPCION_CAMION";
  const statusLabel = (status) => STATUS_LABELS[status] || status || "Pendiente";
  const statusClass = (status) => status === "COMPLETADO" || status === "FINALIZADO" ? "done" : status === "EN_PROCESO" ? "process" : status === "ANULADO" ? "cancelled" : "draft";
  const todayInput = () => {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
  };
  const formatDate = (value) => value
    ? new Intl.DateTimeFormat("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: CFG.TIME_ZONE || "America/Lima" }).format(new Date(value))
    : "-";

  function showLoading(text = "Procesando…") {
    $("#loadingText").textContent = text;
    $("#loading").classList.remove("hidden");
  }

  function hideLoading() {
    $("#loading").classList.add("hidden");
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`.trim();
    node.textContent = message;
    $("#toastRegion").appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function showFormMessage(id, message, ok = false) {
    const node = $(id);
    node.textContent = message;
    node.className = `form-message ${ok ? "success" : "error"}`;
  }

  function errorMessage(error) {
    const raw = error?.message || error?.error_description || String(error || "Error inesperado.");
    if (/duplicate key|unique constraint/i.test(raw)) return "El código ya fue registrado.";
    if (/invalid login credentials/i.test(raw)) return "Usuario o contraseña incorrectos.";
    if (/failed to fetch|network/i.test(raw)) return "No se pudo conectar. Revise la señal de internet.";
    return raw;
  }

  function operationCode(type) {
    const d = new Date();
    const date = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const time = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
    const random = crypto.getRandomValues(new Uint16Array(1))[0].toString(36).toUpperCase().padStart(3, "0").slice(-3);
    return `${TYPE_PREFIX[type]}-${date}-${time}-${random}`;
  }

  function internalEmail(username) {
    return `${normalizeCode(username).toLowerCase()}@${CFG.INTERNAL_EMAIL_DOMAIN}`;
  }

  function showLogin() {
    $("#loginView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
  }

  function showApp() {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    const p = state.profile;
    $("#profileCaption").textContent = `${p.usuario} · ${p.rol}${p.pdv_nombre ? ` · ${p.pdv_nombre}` : ""}`;
    $("#accountInfo").innerHTML = `<strong>${escapeHtml(p.nombre)}</strong><small>${escapeHtml(p.usuario)} · ${escapeHtml(p.rol)}</small>${p.pdv_nombre ? `<small>${escapeHtml(p.pdv_nombre)}</small>` : ""}`;
    const canManage = ["ADMINISTRADOR", "ENCARGADO"].includes(p.rol);
    $("#usersNav").classList.toggle("hidden", !canManage);
    $("#managerPdvField").classList.toggle("hidden", p.rol !== "ADMINISTRADOR");
    $("#bulkPdvCard").classList.toggle("hidden", p.rol !== "ADMINISTRADOR");
    if (p.rol === "ENCARGADO") {
      $("#newRole").innerHTML = '<option value="PDV">PDV</option>';
      $("#newRole").disabled = true;
    }
  }

  async function loadProfile() {
    const { data, error } = await db
      .from("perfiles")
      .select("id,usuario,nombre,rol,pdv_id,estado,pdvs:pdv_id(nombre,codigo)")
      .eq("id", state.session.user.id)
      .single();
    if (error) throw error;
    if (data.estado !== "ACTIVO") throw new Error("La cuenta está inactiva.");
    state.profile = {
      ...data,
      pdv_nombre: data.pdvs?.nombre || "",
      pdv_codigo: data.pdvs?.codigo || "",
    };
  }

  async function loadPdvs() {
    const { data, error } = await db.from("pdvs").select("id,codigo,nombre,region,area,encargado_id,estado").eq("estado", "ACTIVO").order("nombre");
    if (error) throw error;
    state.pdvs = data || [];
    const options = state.pdvs.map((pdv) => `<option value="${pdv.id}">${escapeHtml(pdv.codigo)} · ${escapeHtml(pdv.nombre)}</option>`).join("");
    $("#operationPdv").innerHTML = `<option value="">Seleccione</option>${options}`;
    $("#newUserPdv").innerHTML = `<option value="">Seleccione</option>${options}`;
  }

  async function initializeSession(session) {
    state.session = session;
    await loadProfile();
    await loadPdvs();
    showApp();
    await Promise.all([loadHome(), loadRecent()]);
    await restoreDraft();
  }

  async function login(event) {
    event.preventDefault();
    $("#loginMessage").classList.add("hidden");
    const username = normalizeCode($("#loginUser").value);
    const password = $("#loginPassword").value;
    if (!username || !password) return showFormMessage("#loginMessage", "Ingrese usuario y contraseña.");

    showLoading("Iniciando sesión…");
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: internalEmail(username), password });
      if (error) throw error;
      await initializeSession(data.session);
      $("#loginForm").reset();
    } catch (error) {
      showFormMessage("#loginMessage", errorMessage(error));
    } finally {
      hideLoading();
    }
  }

  async function logout() {
    stopScanner();
    showLoading("Cerrando sesión…");
    try { await db.auth.signOut(); } finally {
      clearState();
      showLogin();
      closeAllDialogs();
      hideLoading();
    }
  }

  function clearState() {
    state.session = null;
    state.profile = null;
    state.pdvs = [];
    state.users = [];
    state.bulkPdvRows = [];
    state.bulkPdvResults = [];
    resetOperationState();
  }

  function switchView(name) {
    $$(".panel").forEach((panel) => panel.classList.remove("active"));
    $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    $(`#${name}Panel`)?.classList.add("active");
    if (name === "records") loadRecords();
    if (name === "users") loadUsersPanel();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function selectOperation(type) {
    if (!TYPE_LABELS[type]) return;
    switchView("new");
    state.selectedType = type;
    $("#operationPicker").classList.add("hidden");
    $("#operationSetup").classList.remove("hidden");
    $("#operationWorkspace").classList.add("hidden");
    $("#newPanelTitle").textContent = TYPE_LABELS[type];
    $("#setupTitle").textContent = TYPE_LABELS[type];
    $("#truckFields").classList.toggle("hidden", !type.includes("CAMION"));
    $("#parcelFields").classList.toggle("hidden", !type.includes("ENCOMIENDA"));
    $("#operationOt").value = "";
    $("#transportGuideNumber").value = "";
    const choosePdv = state.profile.rol !== "PDV";
    $("#pdvField").classList.toggle("hidden", !choosePdv);
    if (!choosePdv) $("#operationPdv").value = state.profile.pdv_id || "";
  }

  function cancelOperationSelection() {
    if (state.operation && !confirm("La operación permanecerá guardada como pendiente o en proceso. ¿Desea salir del registro?")) return;
    resetOperationState();
    $("#operationSetup").reset();
    $("#operationSetup").classList.add("hidden");
    $("#operationWorkspace").classList.add("hidden");
    $("#operationPicker").classList.remove("hidden");
    $("#newPanelTitle").textContent = "Selecciona una operación";
  }

  async function startOperation(event) {
    event.preventDefault();
    const type = state.selectedType;
    const pdvId = state.profile.rol === "PDV" ? state.profile.pdv_id : $("#operationPdv").value;
    if (!pdvId) return toast("Seleccione el PDV.", "error");

    const ot = normalizeCode($("#operationOt").value);
    const data = {
      codigo: ot,
      ot,
      estado: "PENDIENTE",
      tipo: type,
      pdv_id: pdvId,
      created_by: state.profile.id,
      id_ruta: normalizeCode($("#routeId").value) || null,
      placa: normalizeCode($("#vehiclePlate").value) || null,
      empresa_encomienda: $("#parcelCompany").value.trim() || null,
      numero_encomienda: normalizeCode($("#parcelNumber").value) || null,
      guia_remision_transporte: normalizeCode($("#transportGuideNumber").value) || null,
    };

    if (!data.ot) return toast("Ingrese o escanee la OT.", "error");
    if (type.includes("CAMION") && !data.placa) return toast("Ingrese la placa de la unidad.", "error");

    showLoading("Creando operación…");
    try {
      const { data: operation, error } = await db.from("operaciones").insert(data).select("*").single();
      if (error) throw error;
      state.operation = operation;
      localStorage.setItem("controlLogisticoDraft", operation.id);
      renderWorkspace();
      await getGps();
      toast("Operación iniciada.", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  function resetOperationState() {
    state.selectedType = "";
    state.operation = null;
    state.items = [];
    state.sacks = [];
    state.packages = [];
    state.seals = [];
    state.evidences = [];
    state.transportGuide = null;
    state.activeSack = null;
    state.photoDrafts = new Map();
    state.inversePhotos = [];
    state.parcelPhotos = [];
    state.gps = null;
    state.receiptItemType = "SACO";
    stopScanner();
    renderItems();
    renderSacks();
    renderGeneralPhotos("inverse");
    renderGeneralPhotos("parcel");
    $$(".photo-preview").forEach((node) => { node.textContent = "Sin fotografía"; });
    $$(".photo-slot input").forEach((input) => { input.value = ""; });
    $("#transportGuideInput").value = "";
    $("#transportGuideNumber").value = "";
    $("#operationOt").value = "";
    $("#gpsStatus").className = "gps-box";
    $("#gpsStatus").textContent = "Ubicación pendiente.";
    renderTransportGuide();
  }

  function markOperationInProcess() {
    if (!state.operation || state.operation.estado === "COMPLETADO" || state.operation.estado === "ANULADO") return;
    if (state.operation.estado !== "EN_PROCESO") {
      state.operation.estado = "EN_PROCESO";
      renderOperationStatus();
    }
  }

  function renderOperationStatus() {
    const status = state.operation?.estado || "PENDIENTE";
    const node = $("#activeOperationStatus");
    if (!node) return;
    node.className = `status-pill ${statusClass(status)}`;
    node.textContent = statusLabel(status);
    $("#finishOperationButton")?.classList.toggle("hidden", status === "COMPLETADO" || status === "ANULADO");
  }

  function renderWorkspace() {
    const type = state.operation.tipo;
    state.selectedType = type;
    $("#operationPicker").classList.add("hidden");
    $("#operationSetup").classList.add("hidden");
    $("#operationWorkspace").classList.remove("hidden");
    $("#newPanelTitle").textContent = TYPE_LABELS[type];
    $("#activeOperationCode").textContent = state.operation.codigo;
    $("#activeOperationLabel").textContent = TYPE_LABELS[type];
    $("#transportGuideNumber").value = state.operation.guia_remision_transporte || "";
    renderOperationStatus();

    $("#truckArrivalSection").classList.toggle("hidden", type !== "RECEPCION_CAMION");
    $("#receiptItemsSection").classList.toggle("hidden", !RECEIPT_TYPES.has(type));
    $("#inverseSection").classList.toggle("hidden", !INVERSE_TYPES.has(type));
    $("#truckDepartureSection").classList.toggle("hidden", type !== "RECEPCION_CAMION");
    $("#parcelPhotosSection").classList.toggle("hidden", type !== "RECEPCION_ENCOMIENDA");
    $("#loadPhotoSlot").classList.toggle("hidden", type !== "RECEPCION_CAMION");
    $("#itemTypeChooser").classList.toggle("hidden", type === "RECEPCION_ENCOMIENDA");
    $("#receiptItemsTitle").textContent = type === "RECEPCION_ENCOMIENDA" ? "Sacos recibidos por encomienda" : "Sacos y bultos recibidos";
    $("#receiptStepNumber").textContent = type === "RECEPCION_CAMION" ? "3" : "2";
    $("#parcelPhotosSection .step-title > span").textContent = "2";
    $("#truckDepartureSection .step-title > span").textContent = "4";
    if (type === "RECEPCION_ENCOMIENDA") state.receiptItemType = "SACO";

    createSealCards();
    renderItems();
    renderSacks();
    renderExistingEvidenceMarkers();
    renderTransportGuide();
    renderGps();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createSealCards() {
    const make = (stage, number) => {
      const key = `PRECINTO_${stage}:${number}`;
      const seal = state.seals.find((item) => item.etapa === stage && Number(item.numero) === number);
      const evidence = state.evidences.find((item) => item.categoria === `PRECINTO_${stage}` && item.referencia_codigo === String(number));
      return `<div class="seal-card" data-seal-stage="${stage}" data-seal-number="${number}">
        <h4>Precinto ${stage.toLowerCase()} ${number}${number === 1 ? " *" : ""}</h4>
        <div class="scan-input"><input class="seal-code" value="${escapeHtml(seal?.codigo || "")}" autocapitalize="characters" placeholder="Código"><button type="button" data-scan-seal="${stage}:${number}" data-scan-label="Precinto ${stage.toLowerCase()} ${number}">▣</button></div>
        <input class="seal-photo" type="file" accept="image/*" data-photo-key="${key}">
        <div class="photo-preview">${evidence ? "Fotografía guardada" : "Sin fotografía"}</div>
      </div>`;
    };
    $("#arrivalSeals").innerHTML = [1, 2, 3, 4].map((number) => make("LLEGADA", number)).join("");
    $("#departureSeals").innerHTML = [1, 2, 3, 4].map((number) => make("SALIDA", number)).join("");
  }

  async function restoreDraft() {
    const id = localStorage.getItem("controlLogisticoDraft");
    if (!id) return;
    try {
      const { data, error } = await db.from("operaciones").select("*").eq("id", id).in("estado", ["PENDIENTE", "EN_PROCESO"]).maybeSingle();
      if (error || !data) return localStorage.removeItem("controlLogisticoDraft");
      await resumeOperation(data.id, false);
      toast(`Borrador recuperado: ${data.codigo}`);
    } catch (error) {
      console.warn(error);
    }
  }

  async function resumeOperation(id, navigate = true) {
    showLoading("Recuperando borrador…");
    try {
      const [operationResult, itemsResult, sacksResult, packagesResult, sealsResult, evidencesResult] = await Promise.all([
        db.from("operaciones").select("*").eq("id", id).single(),
        db.from("items_recepcion").select("*").eq("operacion_id", id).order("orden"),
        db.from("costales").select("*").eq("operacion_id", id).order("orden"),
        db.from("paquetes").select("*").eq("operacion_id", id).order("orden"),
        db.from("precintos").select("*").eq("operacion_id", id).order("numero"),
        db.from("evidencias").select("*").eq("operacion_id", id).order("created_at"),
      ]);
      for (const result of [operationResult, itemsResult, sacksResult, packagesResult, sealsResult, evidencesResult]) if (result.error) throw result.error;
      if (!["PENDIENTE", "EN_PROCESO"].includes(operationResult.data.estado)) throw new Error("La operación ya no está disponible para edición.");
      resetOperationState();
      state.operation = operationResult.data;
      state.items = itemsResult.data || [];
      state.sacks = sacksResult.data || [];
      state.packages = packagesResult.data || [];
      state.seals = sealsResult.data || [];
      state.evidences = evidencesResult.data || [];
      state.transportGuide = null;
      state.activeSack = state.sacks.find((item) => item.estado === "ABIERTO") || null;
      localStorage.setItem("controlLogisticoDraft", id);
      if (navigate) switchView("new");
      renderWorkspace();
      closeAllDialogs();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  function setItemType(type) {
    state.receiptItemType = type;
    $$('[data-item-type]').forEach((button) => button.classList.toggle("active", button.dataset.itemType === type));
  }

  async function addReceiptCode(raw) {
    const code = normalizeCode(raw);
    if (!state.operation || !code) return false;
    if (state.items.some((item) => normalizeCode(item.codigo) === code)) {
      toast(`El código ${code} ya fue escaneado.`, "error");
      return false;
    }
    try {
      const order = state.items.reduce((max, item) => Math.max(max, Number(item.orden) || 0), 0) + 1;
      const { data, error } = await db.from("items_recepcion").insert({
        operacion_id: state.operation.id,
        tipo: state.operation.tipo === "RECEPCION_ENCOMIENDA" ? "SACO" : state.receiptItemType,
        codigo: code,
        orden: order,
        escaneado_por: state.profile.id,
      }).select("*").single();
      if (error) throw error;
      state.items.push(data);
      markOperationInProcess();
      renderItems();
      vibrate(90);
      return true;
    } catch (error) {
      toast(errorMessage(error), "error");
      return false;
    }
  }

  async function deleteReceiptItem(id) {
    if (!confirm("¿Eliminar este escaneo?")) return;
    const { error } = await db.from("items_recepcion").delete().eq("id", id);
    if (error) return toast(errorMessage(error), "error");
    state.items = state.items.filter((item) => item.id !== id);
    renderItems();
  }

  function renderItems() {
    const list = $("#receiptItemsList");
    if (!list) return;
    $("#receiptItemCount").textContent = String(state.items.length);
    list.innerHTML = state.items.length ? state.items.map((item) => `
      <div class="scan-item"><div class="scan-item-main"><small>${escapeHtml(item.tipo.replaceAll("_", " "))} · ${formatDate(item.escaneado_at)}</small><strong>${escapeHtml(item.codigo)}</strong></div><button class="delete-button" data-delete-item="${item.id}" aria-label="Eliminar">×</button></div>
    `).join("") : '<div class="empty-state">Aún no hay códigos escaneados.</div>';
  }

  async function openSack(raw) {
    const code = normalizeCode(raw);
    if (!state.operation || !code) return false;
    if (state.activeSack) {
      toast(`Primero cierre el costal ${state.activeSack.codigo}.`, "error");
      return false;
    }
    if (state.sacks.some((item) => normalizeCode(item.codigo) === code)) {
      toast(`El costal ${code} ya pertenece a esta operación.`, "error");
      return false;
    }
    try {
      const order = state.sacks.reduce((max, item) => Math.max(max, Number(item.orden) || 0), 0) + 1;
      const { data, error } = await db.from("costales").insert({
        operacion_id: state.operation.id,
        codigo: code,
        orden: order,
        creado_por: state.profile.id,
      }).select("*").single();
      if (error) throw error;
      state.sacks.push(data);
      markOperationInProcess();
      state.activeSack = data;
      renderSacks();
      vibrate([100, 60, 100]);
      return true;
    } catch (error) {
      toast(errorMessage(error), "error");
      return false;
    }
  }

  async function addPackage(raw) {
    const code = normalizeCode(raw);
    if (!state.activeSack) {
      toast("Primero abra un costal.", "error");
      return false;
    }
    if (!code) return false;
    if (state.packages.some((item) => normalizeCode(item.codigo) === code)) {
      toast(`El paquete ${code} ya fue escaneado.`, "error");
      return false;
    }
    try {
      const order = state.packages.filter((item) => item.costal_id === state.activeSack.id).length + 1;
      const { data, error } = await db.from("paquetes").insert({
        operacion_id: state.operation.id,
        costal_id: state.activeSack.id,
        codigo: code,
        orden: order,
        escaneado_por: state.profile.id,
      }).select("*").single();
      if (error) throw error;
      state.packages.push(data);
      markOperationInProcess();
      renderSacks();
      vibrate(80);
      return true;
    } catch (error) {
      toast(errorMessage(error), "error");
      return false;
    }
  }

  async function closeSack() {
    if (!state.activeSack) return;
    const count = state.packages.filter((item) => item.costal_id === state.activeSack.id).length;
    if (!count) return toast("El costal debe contener al menos un paquete.", "error");
    const { data, error } = await db.from("costales").update({ estado: "CERRADO", cerrado_at: new Date().toISOString() }).eq("id", state.activeSack.id).select("*").single();
    if (error) return toast(errorMessage(error), "error");
    state.sacks = state.sacks.map((item) => item.id === data.id ? data : item);
    markOperationInProcess();
    state.activeSack = null;
    renderSacks();
    toast("Costal cerrado.", "success");
  }

  async function deletePackage(id) {
    if (!confirm("¿Eliminar este paquete?")) return;
    const { error } = await db.from("paquetes").delete().eq("id", id);
    if (error) return toast(errorMessage(error), "error");
    state.packages = state.packages.filter((item) => item.id !== id);
    renderSacks();
  }

  async function deleteSack(id) {
    const count = state.packages.filter((item) => item.costal_id === id).length;
    if (!confirm(`¿Eliminar el costal y sus ${count} paquetes?`)) return;
    const { error } = await db.from("costales").delete().eq("id", id);
    if (error) return toast(errorMessage(error), "error");
    state.sacks = state.sacks.filter((item) => item.id !== id);
    state.packages = state.packages.filter((item) => item.costal_id !== id);
    if (state.activeSack?.id === id) state.activeSack = null;
    renderSacks();
  }

  function renderSacks() {
    const list = $("#sackList");
    if (!list) return;
    $("#sackCount").textContent = String(state.sacks.length);
    $("#packageCount").textContent = String(state.packages.length);
    const active = state.activeSack;
    $("#activeSackBox").classList.toggle("empty", !active);
    $("#activeSackCode").textContent = active?.codigo || "Ninguno";
    const activeCount = active ? state.packages.filter((item) => item.costal_id === active.id).length : 0;
    $("#activeSackCount").textContent = active ? `${activeCount} paquete(s) asignado(s)` : "Escanee un costal para comenzar";
    $("#closeSackButton").disabled = !active;
    $("#packageScannerButton").disabled = !active;
    list.innerHTML = state.sacks.length ? state.sacks.map((sack) => {
      const packages = state.packages.filter((item) => item.costal_id === sack.id);
      return `<div class="sack-card"><div class="sack-head"><div><small>Costal ${sack.orden} · ${sack.estado}</small><strong>${escapeHtml(sack.codigo)}</strong></div><button class="delete-button" data-delete-sack="${sack.id}">×</button></div><div class="sack-packages">${packages.length ? packages.map((item) => `<span>${escapeHtml(item.codigo)} <button class="link-button danger-text" data-delete-package="${item.id}">quitar</button></span>`).join(" · ") : "Sin paquetes"}</div></div>`;
    }).join("") : '<div class="empty-state">Aún no hay costales registrados.</div>';
  }

  async function getGps() {
    if (!navigator.geolocation) {
      state.gps = null;
      renderGps("El dispositivo no admite ubicación.", true);
      return;
    }
    renderGps("Obteniendo ubicación…");
    return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      (position) => {
        state.gps = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        renderGps();
        resolve(state.gps);
      },
      (error) => {
        state.gps = null;
        renderGps(`No se obtuvo la ubicación: ${error.message}`, true);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 18000, maximumAge: 30000 },
    ));
  }

  function renderGps(message = "", error = false) {
    const node = $("#gpsStatus");
    if (!node) return;
    if (state.gps) {
      node.className = "gps-box ok";
      node.textContent = `Ubicación lista · ${state.gps.latitude.toFixed(6)}, ${state.gps.longitude.toFixed(6)} · precisión ±${Math.round(state.gps.accuracy)} m`;
    } else {
      node.className = `gps-box${error ? " error" : ""}`;
      node.textContent = message || "Ubicación pendiente.";
    }
  }

  async function processImage(file) {
    if (!file || !file.type.startsWith("image/")) throw new Error("Seleccione una imagen válida.");
    const source = await fileToDataUrl(file);
    const image = await loadImage(source);
    const max = Number(CFG.PHOTO_MAX_SIDE || 1600);
    let { width, height } = image;
    if (Math.max(width, height) > max) {
      const scale = max / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", Number(CFG.PHOTO_QUALITY || .78));
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("No se pudo procesar la fotografía."));
      image.src = src;
    });
  }

  async function handlePhotoSlot(input) {
    const file = input.files?.[0];
    if (!file) return;
    showLoading("Procesando fotografía…");
    try {
      const slot = input.closest(".photo-slot");
      const sealCard = input.closest(".seal-card");
      const key = input.dataset.photoKey || slot?.dataset.photoSlot;
      const category = key?.includes(":") ? key.split(":")[0] : key;
      const reference = key?.includes(":") ? key.split(":")[1] : "";
      const label = slot?.dataset.photoLabel || sealCard?.querySelector("h4")?.textContent || category;
      const dataUrl = await processImage(file);
      state.photoDrafts.set(key, { key, category, reference, label, dataUrl, uploaded: false });
      const preview = (slot || sealCard).querySelector(".photo-preview");
      preview.innerHTML = `<img src="${dataUrl}" alt="${escapeHtml(label)}">`;
    } catch (error) {
      toast(errorMessage(error), "error");
      input.value = "";
    } finally {
      hideLoading();
    }
  }

  function currentTransportGuideEvidence() {
    return state.evidences.find((item) => item.categoria === "GUIA_REMISION_TRANSPORTE");
  }

  function renderTransportGuide() {
    const preview = $("#transportGuidePreview");
    const removeButton = $("#removeTransportGuideButton");
    if (!preview || !removeButton) return;
    const local = state.transportGuide;
    const existing = currentTransportGuideEvidence();
    if (local) {
      preview.innerHTML = local.mimeType === "application/pdf"
        ? `<strong>PDF listo:</strong> ${escapeHtml(local.fileName || "guia-remision.pdf")}`
        : `<img src="${local.dataUrl}" alt="Guía de remisión transporte">`;
      removeButton.classList.remove("hidden");
      return;
    }
    if (existing) {
      preview.innerHTML = `<strong>Archivo guardado:</strong> ${escapeHtml(existing.nombre_archivo || "Guía de remisión transporte")}`;
      removeButton.classList.remove("hidden");
      return;
    }
    preview.textContent = "Sin documento adjunto.";
    removeButton.classList.add("hidden");
  }

  async function deleteStoredEvidence(evidenceId, ask = true) {
    const evidence = state.evidences.find((item) => item.id === evidenceId);
    if (!evidence) return;
    if (ask && !confirm("¿Eliminar la guía de remisión adjunta?")) return;
    showLoading("Eliminando guía…");
    try {
      await callDrive("ELIMINAR_EVIDENCIA", { fileId: evidence.drive_file_id });
      const { error } = await db.from("evidencias").delete().eq("id", evidence.id);
      if (error) throw error;
      state.evidences = state.evidences.filter((item) => item.id !== evidence.id);
      if (state.transportGuide?.existingId === evidence.id || state.transportGuide?.category === evidence.categoria) state.transportGuide = null;
      renderTransportGuide();
      toast("Guía eliminada. Puede adjuntar otra antes de completar.", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
      throw error;
    } finally {
      hideLoading();
    }
  }

  async function handleTransportGuide(input) {
    const file = input.files?.[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf && !file.type.startsWith("image/")) {
      toast("Adjunte una imagen o un archivo PDF.", "error");
      input.value = "";
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      toast("La guía no puede superar 6 MB.", "error");
      input.value = "";
      return;
    }
    const existing = currentTransportGuideEvidence();
    if (existing) {
      try {
        await deleteStoredEvidence(existing.id, false);
      } catch (error) {
        input.value = "";
        return;
      }
    }
    showLoading("Procesando guía…");
    try {
      const dataUrl = isPdf
        ? (await fileToDataUrl(file)).replace(/^data:;base64,/, "data:application/pdf;base64,")
        : await processImage(file);
      state.transportGuide = {
        dataUrl,
        fileName: file.name,
        mimeType: isPdf ? "application/pdf" : "image/jpeg",
        category: "GUIA_REMISION_TRANSPORTE",
        reference: "GUIA-TRANSPORTE",
        label: "Guía de remisión transporte",
        uploaded: false,
      };
      markOperationInProcess();
      await uploadEvidence(state.transportGuide);
      renderTransportGuide();
    } catch (error) {
      toast(errorMessage(error), "error");
      input.value = "";
    } finally {
      hideLoading();
    }
  }

  async function removeTransportGuide() {
    if (state.transportGuide && !state.transportGuide.uploaded) {
      state.transportGuide = null;
      $("#transportGuideInput").value = "";
      renderTransportGuide();
      return;
    }
    const existing = currentTransportGuideEvidence();
    if (existing) {
      try {
        await deleteStoredEvidence(existing.id);
      } catch (error) {
        // El mensaje ya fue mostrado por deleteStoredEvidence.
      }
    }
  }

  async function handleGeneralPhotos(input, kind) {
    const max = Number(CFG.MAX_GENERAL_PHOTOS || 3);
    const files = Array.from(input.files || []).slice(0, max);
    if (!files.length) return;
    showLoading("Procesando fotografías…");
    try {
      const processed = [];
      for (const file of files) processed.push({ dataUrl: await processImage(file), uploaded: false });
      if (kind === "inverse") state.inversePhotos = processed;
      else state.parcelPhotos = processed;
      renderGeneralPhotos(kind);
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  function renderGeneralPhotos(kind) {
    const photos = kind === "inverse" ? state.inversePhotos : state.parcelPhotos;
    const target = kind === "inverse" ? $("#inversePhotoPreview") : $("#parcelPhotoPreview");
    if (!target) return;
    target.innerHTML = photos.map((photo, index) => `<div class="photo-slot"><div class="photo-preview"><img src="${photo.dataUrl}" alt="Evidencia ${index + 1}"></div><button type="button" class="link-button danger-text" data-remove-photo="${kind}:${index}">Quitar</button></div>`).join("");
  }

  function removeGeneralPhoto(kind, index) {
    if (kind === "inverse") state.inversePhotos.splice(index, 1);
    else state.parcelPhotos.splice(index, 1);
    renderGeneralPhotos(kind);
  }

  function renderExistingEvidenceMarkers() {
    $$(".photo-slot[data-photo-slot]").forEach((slot) => {
      const category = slot.dataset.photoSlot;
      if (state.evidences.some((item) => item.categoria === category)) slot.querySelector(".photo-preview").textContent = "Fotografía guardada";
    });
  }

  async function callDrive(action, payload) {
    if (!CFG.DRIVE_API_URL) throw new Error("Falta publicar el puente de Google Drive y colocar su URL en config.js.");
    const { data: sessionData } = await db.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("La sesión venció.");
    const response = await fetch(CFG.DRIVE_API_URL, {
      method: "POST",
      body: JSON.stringify({ accion: action, accessToken: token, ...payload }),
      cache: "no-store",
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "Google Drive rechazó la operación.");
    return result;
  }

  async function uploadEvidence(photo) {
    const existing = state.evidences.find((item) => item.categoria === photo.category && String(item.referencia_codigo || "") === String(photo.reference || ""));
    if (existing) return existing;
    const result = await callDrive("SUBIR_EVIDENCIA", {
      codigoOperacion: state.operation.codigo,
      categoria: photo.category,
      referenciaCodigo: photo.reference || "GENERAL",
      dataUrl: photo.dataUrl,
      nombreArchivo: photo.fileName || "",
    });
    const { data, error } = await db.from("evidencias").insert({
      operacion_id: state.operation.id,
      categoria: photo.category,
      etiqueta: photo.label,
      referencia_codigo: photo.reference || null,
      drive_file_id: result.fileId,
      nombre_archivo: result.nombre,
      mime_type: result.mimeType,
      registrado_por: state.profile.id,
    }).select("*").single();
    if (error) throw error;
    state.evidences.push(data);
    photo.uploaded = true;
    if (photo.category === "GUIA_REMISION_TRANSPORTE") photo.existingId = data.id;
    markOperationInProcess();
    return data;
  }

  function sealValues(stage) {
    return $$(`[data-seal-stage="${stage}"]`).map((card) => ({
      stage,
      number: Number(card.dataset.sealNumber),
      code: normalizeCode(card.querySelector(".seal-code").value),
      photo: state.photoDrafts.get(`PRECINTO_${stage}:${card.dataset.sealNumber}`),
      existingPhoto: state.evidences.find((item) => item.categoria === `PRECINTO_${stage}` && item.referencia_codigo === card.dataset.sealNumber),
    }));
  }

  async function syncTransportGuide() {
    const existing = currentTransportGuideEvidence();
    if (existing) return existing;
    if (!state.transportGuide) throw new Error("Debe adjuntar la guía de remisión transporte.");
    return uploadEvidence(state.transportGuide);
  }

  async function syncOperationMetadata() {
    const numeroGuia = normalizeCode($("#transportGuideNumber").value) || null;
    if (numeroGuia === (state.operation.guia_remision_transporte || null)) return;
    const payload = { guia_remision_transporte: numeroGuia };
    if (numeroGuia && state.operation.estado === "PENDIENTE") payload.estado = "EN_PROCESO";
    const { data, error } = await db.from("operaciones")
      .update(payload)
      .eq("id", state.operation.id)
      .select("*")
      .single();
    if (error) throw error;
    state.operation = data;
    renderOperationStatus();
  }

  async function syncTruckReceipt() {
    const arrivalPhoto = state.photoDrafts.get("LLEGADA_UNIDAD") || state.evidences.find((item) => item.categoria === "LLEGADA_UNIDAD");
    const loadPhoto = state.photoDrafts.get("CARGA_RECIBIDA") || state.evidences.find((item) => item.categoria === "CARGA_RECIBIDA");
    if (!arrivalPhoto) throw new Error("Debe adjuntar la foto de llegada de la unidad.");
    if (!loadPhoto) throw new Error("Debe adjuntar la foto de los sacos o bultos recibidos.");

    for (const photo of state.photoDrafts.values()) {
      if (!photo.category.startsWith("PRECINTO_")) await uploadEvidence(photo);
    }

    for (const stage of ["LLEGADA", "SALIDA"]) {
      const values = sealValues(stage);
      const first = values[0];
      if (!first.code) throw new Error(`Debe escanear el precinto de ${stage.toLowerCase()} 1.`);
      if (!first.photo && !first.existingPhoto) throw new Error(`Debe fotografiar el precinto de ${stage.toLowerCase()} 1.`);

      for (const seal of values) {
        if ((seal.code && !seal.photo && !seal.existingPhoto) || (!seal.code && (seal.photo || seal.existingPhoto))) {
          throw new Error(`Complete el código y la foto del precinto de ${stage.toLowerCase()} ${seal.number}.`);
        }
        if (!seal.code) continue;
        const { data, error } = await db.from("precintos").upsert({
          operacion_id: state.operation.id,
          etapa: stage,
          numero: seal.number,
          codigo: seal.code,
          registrado_por: state.profile.id,
        }, { onConflict: "operacion_id,etapa,numero" }).select("*").single();
        if (error) throw error;
        state.seals = state.seals.filter((item) => !(item.etapa === stage && Number(item.numero) === seal.number));
        state.seals.push(data);
        if (seal.photo) await uploadEvidence(seal.photo);
      }
    }
  }

  async function syncGeneralEvidence() {
    if (state.operation.tipo === "RECEPCION_ENCOMIENDA") {
      const existing = state.evidences.filter((item) => item.categoria === "EVIDENCIA_GENERAL");
      if (!state.parcelPhotos.length && !existing.length) throw new Error("Debe adjuntar al menos una fotografía de la recepción.");
      for (let index = 0; index < state.parcelPhotos.length; index += 1) {
        await uploadEvidence({ ...state.parcelPhotos[index], category: "EVIDENCIA_GENERAL", reference: `RECEPCION-${index + 1}`, label: `Evidencia de recepción ${index + 1}` });
      }
    }
    if (INVERSE_TYPES.has(state.operation.tipo)) {
      const existing = state.evidences.filter((item) => item.categoria === "LOGISTICA_INVERSA");
      if (!state.inversePhotos.length && !existing.length) throw new Error("Debe adjuntar al menos una fotografía de la logística inversa.");
      for (let index = 0; index < state.inversePhotos.length; index += 1) {
        await uploadEvidence({ ...state.inversePhotos[index], category: "LOGISTICA_INVERSA", reference: `INVERSA-${index + 1}`, label: `Evidencia de logística inversa ${index + 1}` });
      }
    }
  }

  async function finishOperation() {
    if (!state.operation) return;
    if (!state.gps) return toast("Obtenga la ubicación GPS antes de finalizar.", "error");
    if (isReceipt() && !state.items.length) return toast("Escanee al menos un saco o bulto.", "error");
    if (isInverse()) {
      if (!state.sacks.length || !state.packages.length) return toast("Registre costales y paquetes.", "error");
      if (state.sacks.some((item) => item.estado === "ABIERTO")) return toast("Cierre todos los costales.", "error");
    }
    if (!confirm("¿Confirmar la descarga y completar la operación? Después ya no podrá editar guías.")) return;

    showLoading("Subiendo evidencias…");
    try {
      await syncOperationMetadata();
      await syncTransportGuide();
      if (isTruckReceipt()) await syncTruckReceipt();
      else await syncGeneralEvidence();

      showLoading("Finalizando operación…");
      const { data, error } = await db.rpc("finalizar_operacion", {
        p_operacion_id: state.operation.id,
        p_latitud: state.gps.latitude,
        p_longitud: state.gps.longitude,
        p_precision: state.gps.accuracy,
        p_dni_ruc: $("#responsibleDocument").value.trim() || null,
        p_observaciones: $("#operationNotes").value.trim() || null,
        p_datos_extra: {},
      });
      if (error) throw error;
      const finishedCode = state.operation.codigo;
      localStorage.removeItem("controlLogisticoDraft");
      resetOperationState();
      $("#operationWorkspace").classList.add("hidden");
      $("#operationPicker").classList.remove("hidden");
      $("#newPanelTitle").textContent = "Selecciona una operación";
      toast(`OT ${finishedCode} completada.`, "success");
      await Promise.all([loadHome(), loadRecent(), loadRecords()]);
      switchView("records");
      return data;
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  async function startScanner(mode, inputId = "", label = "Código") {
    if (!window.ZXing) return toast("El lector no pudo cargarse. Use el ingreso manual.", "error");
    stopScanner(false);
    state.scanner.mode = mode;
    state.scanner.inputId = inputId;
    state.scanner.active = true;
    state.scanner.locked = false;
    $("#scannerTitle").textContent = `Escanear ${label}`;
    $("#scannerStatus").className = "scanner-status";
    $("#scannerStatus").textContent = "Solicitando acceso a la cámara…";
    $("#scannerModal").classList.remove("hidden");

    try {
      const reader = new ZXing.BrowserMultiFormatReader();
      state.scanner.reader = reader;
      state.scanner.devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
      if (!state.scanner.devices.length) throw new Error("No se detectó una cámara.");
      const preferred = state.scanner.devices.findIndex((device) => /back|rear|environment|trasera/i.test(device.label));
      state.scanner.deviceIndex = preferred >= 0 ? preferred : state.scanner.devices.length - 1;
      await decodeWithCurrentCamera();
    } catch (error) {
      $("#scannerStatus").className = "scanner-status error";
      $("#scannerStatus").textContent = `${errorMessage(error)} Puede usar el ingreso manual.`;
    }
  }

  async function decodeWithCurrentCamera() {
    const { reader, devices, deviceIndex } = state.scanner;
    if (!reader || !devices.length) return;
    const deviceId = devices[deviceIndex]?.deviceId;
    $("#scannerStatus").textContent = "Apunte al código de barras o QR.";
    await reader.decodeFromVideoDevice(deviceId, "scannerVideo", async (result) => {
      if (!state.scanner.active || !result) return;
      await processScannedCode(result.getText ? result.getText() : result.text);
    });
  }

  async function processScannedCode(raw) {
    const code = normalizeCode(raw);
    const now = Date.now();
    if (!code || state.scanner.locked) return;
    if (state.scanner.lastCode === code && now - state.scanner.lastAt < 2200) return;
    state.scanner.lastCode = code;
    state.scanner.lastAt = now;
    state.scanner.locked = true;

    let ok = false;
    if (state.scanner.mode === "INPUT") {
      const input = document.getElementById(state.scanner.inputId);
      if (input) { input.value = code; ok = true; }
    } else if (state.scanner.mode === "RECEIPT_ITEM") ok = await addReceiptCode(code);
    else if (state.scanner.mode === "SACK") ok = await openSack(code);
    else if (state.scanner.mode === "PACKAGE") ok = await addPackage(code);

    const status = $("#scannerStatus");
    status.className = `scanner-status ${ok ? "ok" : "error"}`;
    status.textContent = ok ? `Leído: ${code}` : `No se registró: ${code}`;
    if (ok) vibrate(90);

    if (state.scanner.mode === "INPUT" || state.scanner.mode === "SACK") {
      setTimeout(() => stopScanner(), 450);
    } else {
      setTimeout(() => {
        state.scanner.locked = false;
        if (state.scanner.active) {
          status.className = "scanner-status";
          status.textContent = "Apunte al siguiente código.";
        }
      }, 650);
    }
  }

  function stopScanner(hide = true) {
    state.scanner.active = false;
    state.scanner.locked = false;
    try { state.scanner.reader?.reset(); } catch (error) { console.debug(error); }
    const video = $("#scannerVideo");
    if (video?.srcObject) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    state.scanner.reader = null;
    if (hide) $("#scannerModal").classList.add("hidden");
  }

  async function changeCamera() {
    if (state.scanner.devices.length < 2) return toast("No se detectó otra cámara.");
    try {
      state.scanner.reader?.reset();
      state.scanner.deviceIndex = (state.scanner.deviceIndex + 1) % state.scanner.devices.length;
      state.scanner.reader = new ZXing.BrowserMultiFormatReader();
      await decodeWithCurrentCamera();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  async function loadHome() {
    if (!state.profile) return;
    const start = `${todayInput()}T00:00:00`;
    const end = `${todayInput()}T23:59:59`;
    const { data, error } = await db.from("v_resumen_operaciones").select("*").gte("created_at", start).lte("created_at", end);
    if (error) return console.error(error);
    const rows = data || [];
    $("#sumToday").textContent = rows.length;
    $("#sumPending").textContent = rows.filter((row) => row.estado === "PENDIENTE" || row.estado === "BORRADOR").length;
    $("#sumProcess").textContent = rows.filter((row) => row.estado === "EN_PROCESO").length;
    $("#sumDone").textContent = rows.filter((row) => row.estado === "COMPLETADO" || row.estado === "FINALIZADO").length;
  }

  async function loadRecent() {
    if (!state.profile) return;
    const { data, error } = await db.from("v_resumen_operaciones").select("*").order("created_at", { ascending: false }).limit(5);
    if (error) return console.error(error);
    renderRecordList(data || [], $("#recentList"));
  }

  async function loadRecords() {
    if (!state.profile) return;
    const type = $("#filterType").value;
    const status = $("#filterStatus").value;
    const from = $("#filterFrom").value;
    const to = $("#filterTo").value;
    let query = db.from("v_resumen_operaciones").select("*").order("created_at", { ascending: false }).limit(300);
    if (type) query = query.eq("tipo", type);
    if (status) query = query.eq("estado", status);
    if (from) query = query.gte("created_at", `${from}T00:00:00`);
    if (to) query = query.lte("created_at", `${to}T23:59:59`);
    showLoading("Consultando registros…");
    try {
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      renderRecordList(rows, $("#recordsList"));
      $("#recordsSummary").innerHTML = `
        <article class="summary-card warning"><span>Pendientes</span><strong>${rows.filter((row) => row.estado === "PENDIENTE").length}</strong></article>
        <article class="summary-card process"><span>En proceso</span><strong>${rows.filter((row) => row.estado === "EN_PROCESO").length}</strong></article>
        <article class="summary-card success"><span>Completados</span><strong>${rows.filter((row) => row.estado === "COMPLETADO").length}</strong></article>`;
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  function renderRecordList(rows, target) {
    target.innerHTML = rows.length ? rows.map((row) => `
      <article class="record-card" data-record-id="${row.id}">
        <div class="record-main"><small>${formatDate(row.created_at)} · ${escapeHtml(row.pdv_codigo || "")}</small><strong>${escapeHtml(row.ot || row.codigo)}</strong><small class="record-document">${escapeHtml(row.guia_remision_nombre || row.guia_remision_transporte || "Guía de remisión pendiente")}</small><div class="record-meta"><span class="record-tag">${escapeHtml(TYPE_LABELS[row.tipo] || row.tipo)}</span></div></div>
        <div class="record-side"><span class="status-pill ${statusClass(row.estado)}">${escapeHtml(statusLabel(row.estado))}</span><small>${row.total_costales ? "Paquetes" : "Recibidos"}</small><strong>${row.total_costales ? Number(row.total_paquetes || 0) : Number(row.total_recibidos || 0)}</strong></div>
      </article>`).join("") : '<div class="empty-state">No se encontraron registros.</div>';
  }

  async function openRecord(id) {
    showLoading("Cargando detalle…");
    try {
      const [operationResult, itemsResult, sacksResult, packagesResult, sealsResult, evidencesResult] = await Promise.all([
        db.from("operaciones").select("*,pdvs:pdv_id(codigo,nombre)").eq("id", id).single(),
        db.from("items_recepcion").select("*").eq("operacion_id", id).order("orden"),
        db.from("costales").select("*").eq("operacion_id", id).order("orden"),
        db.from("paquetes").select("*").eq("operacion_id", id).order("orden"),
        db.from("precintos").select("*").eq("operacion_id", id).order("etapa").order("numero"),
        db.from("evidencias").select("*").eq("operacion_id", id).order("created_at"),
      ]);
      for (const result of [operationResult, itemsResult, sacksResult, packagesResult, sealsResult, evidencesResult]) if (result.error) throw result.error;
      const o = operationResult.data;
      $("#recordDialogTitle").textContent = o.codigo;
      const details = [
        ["Operación", TYPE_LABELS[o.tipo] || o.tipo], ["Estado", statusLabel(o.estado)], ["PDV", `${o.pdvs?.codigo || ""} ${o.pdvs?.nombre || ""}`], ["Inicio", formatDate(o.iniciada_at)],
        ["OT / ID", o.ot || o.codigo], ["Guía de remisión", o.guia_remision_transporte || "-"], ["Finalización", formatDate(o.finalizada_at)], ["Ruta", o.id_ruta || "-"], ["Placa", o.placa || "-"], ["Encomienda", o.numero_encomienda || "-"],
        ["Responsable", o.dni_ruc_responsable || "-"], ["GPS", o.latitud ? `${o.latitud}, ${o.longitud}` : "-"],
      ];
      let html = `<div class="detail-grid">${details.map(([label, value]) => `<div class="detail-cell"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
      if (itemsResult.data.length) html += `<section class="detail-section"><h3>Sacos y bultos (${itemsResult.data.length})</h3><div class="sack-packages">${itemsResult.data.map((item) => escapeHtml(item.codigo)).join(" · ")}</div></section>`;
      if (sacksResult.data.length) html += `<section class="detail-section"><h3>Costales y paquetes</h3>${sacksResult.data.map((sack) => { const packages = packagesResult.data.filter((item) => item.costal_id === sack.id); return `<div class="sack-card"><div class="sack-head"><strong>${escapeHtml(sack.codigo)}</strong><span class="record-tag">${packages.length} paquetes</span></div><div class="sack-packages">${packages.map((item) => escapeHtml(item.codigo)).join(" · ")}</div></div>`; }).join("")}</section>`;
      if (sealsResult.data.length) html += `<section class="detail-section"><h3>Precintos</h3><div class="sack-packages">${sealsResult.data.map((seal) => `${escapeHtml(seal.etapa)} ${seal.numero}: ${escapeHtml(seal.codigo)}`).join(" · ")}</div></section>`;
      if (evidencesResult.data.length) html += `<section class="detail-section"><h3>Evidencias (${evidencesResult.data.length})</h3><div class="evidence-buttons">${evidencesResult.data.map((evidence) => `<button class="evidence-button" data-evidence-file="${escapeHtml(evidence.drive_file_id)}">${escapeHtml(evidence.etiqueta)}</button>`).join("")}</div><div id="evidenceViewer" class="photo-preview hidden" style="margin-top:10px"></div></section>`;
      if (o.observaciones) html += `<section class="detail-section"><h3>Observaciones</h3><p>${escapeHtml(o.observaciones)}</p></section>`;
      if (["PENDIENTE", "EN_PROCESO", "BORRADOR"].includes(o.estado)) html += `<button class="button primary full" data-resume-id="${o.id}">Continuar operación</button>`;
      $("#recordDetail").innerHTML = html;
      $("#recordDialog").showModal();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  async function viewEvidence(fileId) {
    showLoading("Cargando evidencia…");
    try {
      const result = await callDrive("OBTENER_EVIDENCIA", { fileId });
      const viewer = $("#evidenceViewer");
      viewer.innerHTML = result.mimeType === "application/pdf"
        ? `<iframe src="${result.dataUrl}" title="Documento" style="width:100%;height:520px;border:0"></iframe>`
        : `<img src="${result.dataUrl}" alt="Evidencia" style="width:100%;max-height:520px;object-fit:contain">`;
      viewer.classList.remove("hidden");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  async function loadUsersPanel() {
    if (!["ADMINISTRADOR", "ENCARGADO"].includes(state.profile.rol)) return;
    showLoading("Cargando cuentas…");
    try {
      const { data, error } = await db.from("perfiles").select("id,usuario,nombre,rol,pdv_id,estado,pdvs:pdv_id(codigo,nombre)").order("nombre");
      if (error) throw error;
      state.users = data || [];
      $("#usersList").innerHTML = state.users.length ? state.users.map((user) => `<div class="user-card"><div class="user-data"><strong>${escapeHtml(user.nombre)}</strong><small>${escapeHtml(user.usuario)} · ${escapeHtml(user.rol)}${user.pdvs ? ` · ${escapeHtml(user.pdvs.codigo)}` : ""}</small></div><span class="status-pill ${user.estado === "ACTIVO" ? "done" : "cancelled"}">${escapeHtml(user.estado)}</span></div>`).join("") : '<div class="empty-state">No hay cuentas visibles.</div>';

      if (state.profile.rol === "ADMINISTRADOR") {
        const managers = state.users.filter((user) => user.rol === "ENCARGADO" && user.estado === "ACTIVO");
        $("#pdvManager").innerHTML = `<option value="">Sin encargado</option>${managers.map((user) => `<option value="${user.id}">${escapeHtml(user.nombre)}</option>`).join("")}`;
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  async function invokeUserAdmin(body) {
    const { data, error } = await db.functions.invoke("crear-usuario", { body });
    if (error) throw new Error(data?.error || error.message);
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function createPdv(event) {
    event.preventDefault();
    showLoading("Creando PDV…");
    try {
      await invokeUserAdmin({ accion: "CREAR_PDV", codigo: normalizeCode($("#pdvCode").value), nombre: $("#pdvName").value.trim(), region: $("#pdvRegion").value.trim(), area: $("#pdvArea").value.trim(), encargado_id: $("#pdvManager").value || null });
      $("#pdvForm").reset();
      await loadPdvs();
      toast("PDV creado correctamente.", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally { hideLoading(); }
  }

  function normalizeHeader(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function requireSpreadsheetLibrary() {
    if (!window.XLSX) throw new Error("No se pudo cargar el lector de Excel. Actualice la página y vuelva a intentarlo.");
    return window.XLSX;
  }

  function downloadPdvTemplate() {
    try {
      const XLSX = requireSpreadsheetLibrary();
      const workbook = XLSX.utils.book_new();
      const pdvSheet = XLSX.utils.json_to_sheet([], { header: BULK_PDV_HEADERS });
      pdvSheet["!cols"] = [
        { wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 22 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 14 },
      ];
      const instructions = [
        ["CARGA MASIVA DE PDV"],
        ["Complete la hoja PDV sin cambiar los encabezados."],
        ["Los encargados deben existir previamente, estar activos y tener rol ENCARGADO."],
        ["CODIGO_PDV debe ser único. Si ya existe, sus datos serán actualizados."],
        ["USUARIO_PDV debe ser único y tener entre 3 y 30 caracteres."],
        ["CONTRASENA_TEMPORAL debe tener entre 8 y 72 caracteres y será definida por el Administrador."],
        ["Si la cuenta ya existe y corresponde al mismo PDV, su contraseña será actualizada."],
        ["ESTADO solo admite ACTIVO o INACTIVO."],
        [],
        ["EJEMPLO"],
        BULK_PDV_HEADERS,
        ["PE07008", "CAL-08.pdv", "LIMA", "LIMA NORTE", "JESUS", "CAL08PDV", "Cambiar#2026", "ACTIVO"],
      ];
      const instructionSheet = XLSX.utils.aoa_to_sheet(instructions);
      instructionSheet["!cols"] = [{ wch: 90 }, { wch: 30 }, { wch: 20 }, { wch: 22 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(workbook, pdvSheet, "PDV");
      XLSX.utils.book_append_sheet(workbook, instructionSheet, "INSTRUCCIONES");
      XLSX.writeFile(workbook, "PLANTILLA_CARGA_MASIVA_PDV.xlsx");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  function validateBulkPdvRows(rawRows) {
    const managers = new Map(
      state.users
        .filter((user) => user.rol === "ENCARGADO" && user.estado === "ACTIVO")
        .map((user) => [normalizeCode(user.usuario), user]),
    );

    const rows = rawRows.map((raw, index) => {
      const keyed = {};
      Object.entries(raw).forEach(([key, value]) => { keyed[normalizeHeader(key)] = value; });
      return {
        fila: index + 2,
        codigo: normalizeCode(keyed.CODIGO_PDV),
        nombre: String(keyed.NOMBRE_PDV ?? "").trim(),
        region: String(keyed.REGION ?? "").trim(),
        area: String(keyed.AREA ?? "").trim(),
        encargado_usuario: normalizeCode(keyed.USUARIO_ENCARGADO),
        usuario_pdv: normalizeCode(keyed.USUARIO_PDV),
        password: String(keyed.CONTRASENA_TEMPORAL ?? ""),
        estado: normalizeCode(keyed.ESTADO || "ACTIVO"),
        errors: [],
      };
    });

    const codeCounts = rows.reduce((counts, row) => {
      if (row.codigo) counts.set(row.codigo, (counts.get(row.codigo) || 0) + 1);
      return counts;
    }, new Map());
    const userCounts = rows.reduce((counts, row) => {
      if (row.usuario_pdv) counts.set(row.usuario_pdv, (counts.get(row.usuario_pdv) || 0) + 1);
      return counts;
    }, new Map());

    rows.forEach((row) => {
      if (!row.codigo) row.errors.push("Falta CODIGO_PDV.");
      else if (!/^[A-Z0-9._-]{1,50}$/.test(row.codigo)) row.errors.push("Código inválido.");
      else if (codeCounts.get(row.codigo) > 1) row.errors.push("Código duplicado en el archivo.");
      if (!row.nombre) row.errors.push("Falta NOMBRE_PDV.");
      if (!row.encargado_usuario) row.errors.push("Falta USUARIO_ENCARGADO.");
      else if (!managers.has(row.encargado_usuario)) row.errors.push("Encargado inexistente o inactivo.");
      if (!row.usuario_pdv) row.errors.push("Falta USUARIO_PDV.");
      else if (!/^[A-Z0-9._-]{3,30}$/.test(row.usuario_pdv)) row.errors.push("USUARIO_PDV inválido.");
      else if (userCounts.get(row.usuario_pdv) > 1) row.errors.push("USUARIO_PDV duplicado en el archivo.");
      if (row.password.length < 8 || row.password.length > 72) row.errors.push("La contraseña debe tener entre 8 y 72 caracteres.");
      if (!["ACTIVO", "INACTIVO"].includes(row.estado)) row.errors.push("ESTADO debe ser ACTIVO o INACTIVO.");
    });

    return rows;
  }

  function renderBulkPdvPreview() {
    const rows = state.bulkPdvRows;
    const valid = rows.filter((row) => row.errors.length === 0).length;
    const invalid = rows.length - valid;
    $("#bulkPdvSummary").classList.remove("hidden");
    $("#bulkPdvSummary").innerHTML = `
      <div><span>Total</span><strong>${rows.length}</strong></div>
      <div class="ok"><span>Válidos</span><strong>${valid}</strong></div>
      <div class="bad"><span>Observados</span><strong>${invalid}</strong></div>`;
    $("#bulkPdvPreview").classList.remove("hidden");
    $("#bulkPdvPreview").innerHTML = `
      <table class="data-table">
        <thead><tr><th>Fila</th><th>Código</th><th>PDV</th><th>Encargado</th><th>Usuario PDV</th><th>Contraseña</th><th>Estado</th><th>Validación</th></tr></thead>
        <tbody>${rows.slice(0, 100).map((row) => `
          <tr class="${row.errors.length ? "row-error" : ""}">
            <td>${row.fila}</td>
            <td>${escapeHtml(row.codigo || "-")}</td>
            <td>${escapeHtml(row.nombre || "-")}</td>
            <td>${escapeHtml(row.encargado_usuario || "-")}</td>
            <td>${escapeHtml(row.usuario_pdv || "-")}</td>
            <td>${row.password ? "••••••••" : "-"}</td>
            <td>${escapeHtml(row.estado || "-")}</td>
            <td><span class="validation-pill ${row.errors.length ? "bad" : "ok"}">${escapeHtml(row.errors.length ? row.errors.join(" ") : "Válido")}</span></td>
          </tr>`).join("")}</tbody>
      </table>
      ${rows.length > 100 ? `<div class="table-note">Vista previa de las primeras 100 filas de ${rows.length}.</div>` : ""}`;
    $("#bulkPdvImportButton").disabled = valid === 0;
  }

  async function readBulkPdvFile(event) {
    state.bulkPdvRows = [];
    state.bulkPdvResults = [];
    $("#bulkPdvResultButton").classList.add("hidden");
    $("#bulkPdvMessage").className = "form-message hidden";
    $("#bulkPdvSummary").classList.add("hidden");
    $("#bulkPdvPreview").classList.add("hidden");
    $("#bulkPdvImportButton").disabled = true;

    const file = event.target.files?.[0];
    if (!file) {
      $("#bulkPdvFileInfo").textContent = "Seleccione la plantilla completada para validar los registros.";
      return;
    }

    $("#bulkPdvFileInfo").textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
    showLoading("Leyendo y validando archivo…");
    try {
      if (file.size > BULK_PDV_MAX_FILE_BYTES) throw new Error("El archivo supera el máximo permitido de 5 MB.");
      const XLSX = requireSpreadsheetLibrary();
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === "PDV") || workbook.SheetNames[0];
      if (!sheetName) throw new Error("El archivo no contiene hojas para importar.");
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, blankrows: false });
      const detectedHeaders = new Set(Object.keys(rawRows[0] || {}).map(normalizeHeader));
      const missing = BULK_PDV_HEADERS.filter((header) => !detectedHeaders.has(header));
      if (missing.length) throw new Error(`Faltan columnas: ${missing.join(", ")}.`);
      if (!rawRows.length) throw new Error("El archivo no contiene registros de PDV.");
      if (rawRows.length > BULK_PDV_MAX_ROWS) throw new Error(`El archivo supera el máximo de ${BULK_PDV_MAX_ROWS} registros.`);
      state.bulkPdvRows = validateBulkPdvRows(rawRows);
      renderBulkPdvPreview();
    } catch (error) {
      showFormMessage("#bulkPdvMessage", errorMessage(error));
    } finally {
      hideLoading();
    }
  }

  function renderBulkPdvResults(results) {
    const created = results.filter((row) => row.resultado === "CREADO").length;
    const updated = results.filter((row) => row.resultado === "ACTUALIZADO").length;
    const partial = results.filter((row) => row.resultado === "PARCIAL").length;
    const rejected = results.filter((row) => row.resultado === "RECHAZADO").length;
    $("#bulkPdvSummary").innerHTML = `
      <div><span>Procesados</span><strong>${results.length}</strong></div>
      <div class="ok"><span>Creados</span><strong>${created}</strong></div>
      <div class="updated"><span>Actualizados</span><strong>${updated}</strong></div>
      <div class="warning"><span>Parciales</span><strong>${partial}</strong></div>
      <div class="bad"><span>Rechazados</span><strong>${rejected}</strong></div>`;
    $("#bulkPdvPreview").innerHTML = `
      <table class="data-table">
        <thead><tr><th>Fila</th><th>Código</th><th>Resultado</th><th>Detalle</th></tr></thead>
        <tbody>${results.map((row) => `
          <tr class="${["RECHAZADO", "PARCIAL"].includes(row.resultado) ? "row-error" : ""}">
            <td>${row.fila}</td>
            <td>${escapeHtml(row.codigo || "-")}</td>
            <td><span class="validation-pill ${["RECHAZADO", "PARCIAL"].includes(row.resultado) ? "bad" : "ok"}">${escapeHtml(row.resultado)}</span></td>
            <td>${escapeHtml(row.mensaje || "Procesado correctamente.")}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  }

  async function importBulkPdvs() {
    if (state.profile?.rol !== "ADMINISTRADOR") return toast("Solo el Administrador puede importar PDV.", "error");
    const validRows = state.bulkPdvRows.filter((row) => row.errors.length === 0);
    if (!validRows.length) return toast("No existen registros válidos para importar.", "error");
    if (!confirm(`Se crearán o actualizarán ${validRows.length} PDV. ¿Desea continuar?`)) return;

    showLoading("Importando PDV…");
    try {
      const results = state.bulkPdvRows
        .filter((row) => row.errors.length)
        .map((row) => ({ fila: row.fila, codigo: row.codigo, resultado: "RECHAZADO", mensaje: row.errors.join(" ") }));

      for (let index = 0; index < validRows.length; index += BULK_PDV_BATCH_SIZE) {
        const batch = validRows.slice(index, index + BULK_PDV_BATCH_SIZE).map((row) => ({
          fila: row.fila,
          codigo: row.codigo,
          nombre: row.nombre,
          region: row.region,
          area: row.area,
          encargado_usuario: row.encargado_usuario,
          usuario_pdv: row.usuario_pdv,
          password: row.password,
          estado: row.estado,
        }));
        $("#loadingText").textContent = `Importando ${Math.min(index + batch.length, validRows.length)} de ${validRows.length}…`;
        const response = await invokeUserAdmin({ accion: "IMPORTAR_PDVS", registros: batch });
        results.push(...(response.resultados || []));
      }

      state.bulkPdvResults = results.sort((a, b) => a.fila - b.fila);
      renderBulkPdvResults(state.bulkPdvResults);
      $("#bulkPdvImportButton").disabled = true;
      $("#bulkPdvResultButton").classList.remove("hidden");
      const rejected = state.bulkPdvResults.filter((row) => row.resultado === "RECHAZADO").length;
      const partial = state.bulkPdvResults.filter((row) => row.resultado === "PARCIAL").length;
      showFormMessage("#bulkPdvMessage", rejected || partial ? `Importación terminada: ${rejected} rechazado(s) y ${partial} parcial(es). Descargue el resultado para revisar.` : "Importación completada correctamente.", rejected === 0 && partial === 0);
      await loadPdvs();
    } catch (error) {
      showFormMessage("#bulkPdvMessage", errorMessage(error));
    } finally {
      hideLoading();
    }
  }

  function downloadBulkPdvResult() {
    try {
      if (!state.bulkPdvResults.length) throw new Error("No hay resultados para descargar.");
      const XLSX = requireSpreadsheetLibrary();
      const sourceByRow = new Map(state.bulkPdvRows.map((row) => [row.fila, row]));
      const rows = state.bulkPdvResults.map((row) => {
        const source = sourceByRow.get(row.fila) || {};
        return {
          FILA: row.fila,
          CODIGO_PDV: row.codigo,
          USUARIO_PDV: source.usuario_pdv || "",
          CONTRASENA_TEMPORAL: source.password || "",
          RESULTADO: row.resultado,
          DETALLE: row.mensaje || "Procesado correctamente.",
        };
      });
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.json_to_sheet(rows);
      sheet["!cols"] = [{ wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 24 }, { wch: 18 }, { wch: 55 }];
      XLSX.utils.book_append_sheet(workbook, sheet, "RESULTADO");
      XLSX.writeFile(workbook, `RESULTADO_CARGA_PDV_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function createUser(event) {
    event.preventDefault();
    const role = $("#newRole").value;
    showLoading("Creando cuenta…");
    try {
      await invokeUserAdmin({ accion: "CREAR_USUARIO", usuario: normalizeCode($("#newUsername").value), nombre: $("#newFullName").value.trim(), rol: role, pdv_id: role === "PDV" ? $("#newUserPdv").value : null, password: $("#newPassword").value });
      $("#userForm").reset();
      updateRoleFields();
      await loadUsersPanel();
      toast("Cuenta creada correctamente.", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally { hideLoading(); }
  }

  function updateRoleFields() {
    $("#newUserPdvField").classList.toggle("hidden", $("#newRole").value !== "PDV");
  }

  async function changePassword(event) {
    event.preventDefault();
    const password = $("#passwordNew").value;
    const confirmPassword = $("#passwordConfirm").value;
    if (password.length < 8) return toast("La contraseña debe tener al menos 8 caracteres.", "error");
    if (password !== confirmPassword) return toast("Las contraseñas no coinciden.", "error");
    showLoading("Actualizando contraseña…");
    try {
      const { error } = await db.auth.updateUser({ password });
      if (error) throw error;
      $("#passwordForm").reset();
      $("#passwordDialog").close();
      toast("Contraseña actualizada.", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally { hideLoading(); }
  }

  function closeAllDialogs() {
    $$("dialog[open]").forEach((dialog) => dialog.close());
  }

  function registerEvents() {
    $("#loginForm").addEventListener("submit", login);
    $("#operationSetup").addEventListener("submit", startOperation);
    $("#pdvForm").addEventListener("submit", createPdv);
    $("#userForm").addEventListener("submit", createUser);
    $("#passwordForm").addEventListener("submit", changePassword);
    $("#newRole").addEventListener("change", updateRoleFields);
    $("#bulkPdvFile").addEventListener("change", readBulkPdvFile);
    $("#transportGuideInput").addEventListener("change", (event) => handleTransportGuide(event.target));
    $("#transportGuideNumber").addEventListener("change", async () => {
      if (!state.operation) return;
      showLoading("Guardando guía…");
      try {
        await syncOperationMetadata();
        markOperationInProcess();
      } catch (error) {
        toast(errorMessage(error), "error");
      } finally {
        hideLoading();
      }
    });
    $("#inversePhotoInput").addEventListener("change", (event) => handleGeneralPhotos(event.target, "inverse"));
    $("#parcelPhotoInput").addEventListener("change", (event) => handleGeneralPhotos(event.target, "parcel"));

    document.addEventListener("change", (event) => {
      if (event.target.matches(".photo-slot input[type=file], .seal-photo")) handlePhotoSlot(event.target);
    });

    document.addEventListener("click", async (event) => {
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) { switchView(viewButton.dataset.view); return; }
      const operationButton = event.target.closest("[data-operation]");
      if (operationButton) { selectOperation(operationButton.dataset.operation); return; }
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const action = actionButton.dataset.action;
        if (action === "toggle-password") {
          const input = document.getElementById(actionButton.dataset.target);
          input.type = input.type === "password" ? "text" : "password";
          actionButton.textContent = input.type === "password" ? "Ver" : "Ocultar";
        } else if (action === "open-account-menu") $("#accountDialog").showModal();
        else if (action === "open-password-dialog") { $("#accountDialog").close(); $("#passwordDialog").showModal(); }
        else if (action === "close-dialog") document.getElementById(actionButton.dataset.dialog)?.close();
        else if (action === "logout") await logout();
        else if (action === "cancel-operation") cancelOperationSelection();
        else if (action === "add-receipt-manual") { if (await addReceiptCode($("#manualReceiptCode").value)) $("#manualReceiptCode").value = ""; }
        else if (action === "add-sack-manual") { if (await openSack($("#manualSackCode").value)) $("#manualSackCode").value = ""; }
        else if (action === "add-package-manual") { if (await addPackage($("#manualPackageCode").value)) $("#manualPackageCode").value = ""; }
        else if (action === "close-sack") await closeSack();
        else if (action === "get-gps") await getGps();
        else if (action === "finish-operation") await finishOperation();
        else if (action === "remove-transport-guide") await removeTransportGuide();
        else if (["refresh-records", "search-records"].includes(action)) await loadRecords();
        else if (action === "refresh-users") await loadUsersPanel();
        else if (action === "download-pdv-template") downloadPdvTemplate();
        else if (action === "import-pdvs") await importBulkPdvs();
        else if (action === "download-pdv-result") downloadBulkPdvResult();
        else if (action === "scanner-close") stopScanner();
        else if (action === "scanner-camera") await changeCamera();
        return;
      }

      const itemTypeButton = event.target.closest("[data-item-type]");
      if (itemTypeButton) { setItemType(itemTypeButton.dataset.itemType); return; }
      const scanModeButton = event.target.closest("[data-scan-mode]");
      if (scanModeButton) { await startScanner(scanModeButton.dataset.scanMode, "", scanModeButton.dataset.scanMode === "SACK" ? "costal" : scanModeButton.dataset.scanMode === "PACKAGE" ? "paquete" : "saco o bulto"); return; }
      const scanTargetButton = event.target.closest("[data-scan-target]");
      if (scanTargetButton) { await startScanner("INPUT", scanTargetButton.dataset.scanTarget, scanTargetButton.dataset.scanLabel); return; }
      const scanSealButton = event.target.closest("[data-scan-seal]");
      if (scanSealButton) {
        const card = scanSealButton.closest(".seal-card");
        const id = `seal-${scanSealButton.dataset.scanSeal.replace(":", "-")}`;
        card.querySelector(".seal-code").id = id;
        await startScanner("INPUT", id, scanSealButton.dataset.scanLabel);
        return;
      }
      const deleteItemButton = event.target.closest("[data-delete-item]");
      if (deleteItemButton) { await deleteReceiptItem(deleteItemButton.dataset.deleteItem); return; }
      const deleteSackButton = event.target.closest("[data-delete-sack]");
      if (deleteSackButton) { await deleteSack(deleteSackButton.dataset.deleteSack); return; }
      const deletePackageButton = event.target.closest("[data-delete-package]");
      if (deletePackageButton) { await deletePackage(deletePackageButton.dataset.deletePackage); return; }
      const removePhotoButton = event.target.closest("[data-remove-photo]");
      if (removePhotoButton) { const [kind, index] = removePhotoButton.dataset.removePhoto.split(":"); removeGeneralPhoto(kind, Number(index)); return; }
      const record = event.target.closest("[data-record-id]");
      if (record) { await openRecord(record.dataset.recordId); return; }
      const resume = event.target.closest("[data-resume-id]");
      if (resume) { await resumeOperation(resume.dataset.resumeId); return; }
      const evidence = event.target.closest("[data-evidence-file]");
      if (evidence) await viewEvidence(evidence.dataset.evidenceFile);
    });

    for (const id of ["manualReceiptCode", "manualSackCode", "manualPackageCode"]) {
      document.getElementById(id).addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const action = id === "manualReceiptCode" ? "add-receipt-manual" : id === "manualSackCode" ? "add-sack-manual" : "add-package-manual";
        document.querySelector(`[data-action="${action}"]`).click();
      });
    }
    window.addEventListener("beforeunload", () => stopScanner(false));
  }

  async function boot() {
    registerEvents();
    updateRoleFields();
    $("#filterFrom").value = todayInput();
    $("#filterTo").value = todayInput();
    showLoading("Inicializando…");
    try {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (data.session) await initializeSession(data.session);
      else showLogin();
    } catch (error) {
      console.error(error);
      showLogin();
      toast(errorMessage(error), "error");
    } finally {
      hideLoading();
    }
  }

  boot();
})();
