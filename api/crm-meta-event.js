function crmConfig() {
  const baseUrl = process.env.CRM_SUPABASE_URL;
  const secretKey = process.env.CRM_SUPABASE_SECRET_KEY;

  if (!baseUrl || !secretKey) {
    throw new Error("CRM_SUPABASE_URL ou CRM_SUPABASE_SECRET_KEY não configurada");
  }

  return { baseUrl, secretKey };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function validateCrmUser(accessToken) {
  const { baseUrl, secretKey } = crmConfig();

  const response = await fetch(`${baseUrl}/auth/v1/user`, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await parseResponse(response);

  if (!response.ok || !data?.id) {
    return null;
  }

  return data;
}

async function crmRequest(path, options = {}) {
  const { baseUrl, secretKey } = crmConfig();

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: secretKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new Error(`CRM Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function metaRequest(path, { method = "GET", body } = {}) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const graphVersion = process.env.META_GRAPH_VERSION || "v26.0";

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN não configurado");
  }

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await parseResponse(response);

  if (!response.ok) {
    const error = new Error(`Meta ${response.status}`);
    error.meta = data;
    throw error;
  }

  return data;
}

function extractDatasetId(data) {
  if (!data) return null;
  if (typeof data.id === "string" || typeof data.id === "number") return String(data.id);
  if (Array.isArray(data.data) && data.data[0]?.id) return String(data.data[0].id);
  return null;
}

async function getDatasetId(wabaId) {
  if (process.env.META_DATASET_ID) return process.env.META_DATASET_ID;

  const current = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`);
  const datasetId = extractDatasetId(current);

  if (!datasetId) {
    throw new Error("Dataset da WABA não encontrado");
  }

  return datasetId;
}

function getWebDatasetId() {
  return process.env.META_WEB_DATASET_ID || "1126162470085705";
}

function parseLandingAttribution(sourceUrl) {
  if (!sourceUrl) return null;

  try {
    const url = new URL(sourceUrl);
    const value = (name) => url.searchParams.get(name) || null;

    const attribution = {
      ref: value("_auron_ref"),
      fbc: value("_auron_fbc"),
      fbp: value("_auron_fbp"),
      client_ip_address: value("_auron_ip"),
      client_user_agent: value("_auron_ua"),
      utm_source: value("_auron_utm_source") || value("utm_source"),
      utm_medium: value("_auron_utm_medium") || value("utm_medium"),
      utm_campaign: value("_auron_utm_campaign") || value("utm_campaign"),
      utm_content: value("_auron_utm_content") || value("utm_content"),
      utm_term: value("_auron_utm_term") || value("utm_term"),
    };

    [
      "_auron_ref",
      "_auron_fbc",
      "_auron_fbp",
      "_auron_ip",
      "_auron_ua",
      "_auron_utm_source",
      "_auron_utm_medium",
      "_auron_utm_campaign",
      "_auron_utm_content",
      "_auron_utm_term",
    ].forEach((key) => url.searchParams.delete(key));

    attribution.event_source_url = url.toString();
    return attribution;
  } catch {
    return null;
  }
}

async function sha256(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (!normalizedValue) return null;

  const bytes = new TextEncoder().encode(normalizedValue);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function errorText(error) {
  const raw = error?.meta || error?.message || error || "Erro desconhecido";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return text.slice(0, 1500);
}

async function markMetaError(leadId, message) {
  try {
    await crmRequest(`leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        meta_last_error: message,
        meta_last_error_at: new Date().toISOString(),
      }),
    });
  } catch (patchError) {
    console.error("CRM_META_ERRO_AO_SALVAR_FALHA", patchError?.message || patchError);
  }
}

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!accessToken) {
    return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
  }

  const user = await validateCrmUser(accessToken);
  if (!user) {
    return Response.json({ ok: false, error: "Sessão do CRM inválida" }, { status: 401 });
  }

  let leadId = null;

  try {
    const body = await request.json();
    leadId = body?.lead_id || null;
    const eventName = body?.event_name;

    if (!leadId || !["QualifiedLead", "Purchase"].includes(eventName)) {
      return Response.json({ ok: false, error: "Evento inválido" }, { status: 400 });
    }

    const companySlug = process.env.CRM_COMPANY_SLUG || "auron-marketing";
    const companyQuery = new URLSearchParams({
      slug: `eq.${companySlug}`,
      select: "id,slug",
      limit: "1",
    });
    const companies = await crmRequest(`companies?${companyQuery.toString()}`);
    const company = companies?.[0];

    if (!company) {
      return Response.json({ ok: false, error: "Empresa do CRM não encontrada" }, { status: 404 });
    }

    const membershipQuery = new URLSearchParams({
      company_id: `eq.${company.id}`,
      user_id: `eq.${user.id}`,
      select: "company_id,role",
      limit: "1",
    });
    const memberships = await crmRequest(`company_members?${membershipQuery.toString()}`);

    if (!memberships?.length) {
      return Response.json({ ok: false, error: "Usuário sem acesso à empresa" }, { status: 403 });
    }

    const leadQuery = new URLSearchParams({
      id: `eq.${leadId}`,
      company_id: `eq.${company.id}`,
      select: "id,name,phone,wa_id,source,campaign,integration_source,waba_id,ctwa_clid,meta_source_id,meta_source_url,meta_headline,sale_value,stage_id,meta_qualified_sent_at,meta_qualified_event_id,meta_purchase_sent_at,meta_purchase_event_id",
      limit: "1",
    });
    const leads = await crmRequest(`leads?${leadQuery.toString()}`);
    const lead = leads?.[0];

    if (!lead) {
      return Response.json({ ok: false, error: "Lead não encontrado" }, { status: 404 });
    }

    const landingAttribution = parseLandingAttribution(lead.meta_source_url);
    const isClickToWhatsAppLead =
      lead.integration_source === "whatsapp" &&
      Boolean(lead.waba_id) &&
      Boolean(lead.ctwa_clid);
    const isLandingPageLead =
      lead.integration_source === "whatsapp" &&
      Boolean(lead.waba_id) &&
      normalized(lead.source) === "landing page" &&
      Boolean(landingAttribution);

    if (!isClickToWhatsAppLead && !isLandingPageLead) {
      return Response.json({
        ok: true,
        status: "not_eligible",
        event_name: eventName,
        message: "Lead sem vínculo de atribuição com anúncio ou landing page; nenhum evento foi enviado.",
      });
    }

    const expectedWaba = process.env.CRM_WABA_ID;
    if (expectedWaba && String(lead.waba_id) !== String(expectedWaba)) {
      return Response.json({ ok: false, error: "WABA do lead não corresponde à WABA configurada" }, { status: 400 });
    }

    const stageQuery = new URLSearchParams({
      id: `eq.${lead.stage_id}`,
      company_id: `eq.${company.id}`,
      select: "id,name,is_won",
      limit: "1",
    });
    const stages = await crmRequest(`pipeline_stages?${stageQuery.toString()}`);
    const stage = stages?.[0];

    if (!stage) {
      return Response.json({ ok: false, error: "Etapa atual do lead não encontrada" }, { status: 400 });
    }

    if (eventName === "QualifiedLead" && !normalized(stage.name).includes("qualific")) {
      return Response.json({ ok: false, error: "O lead não está na etapa Qualificado" }, { status: 400 });
    }

    if (eventName === "Purchase" && !stage.is_won) {
      return Response.json({ ok: false, error: "O lead não está na etapa de venda" }, { status: 400 });
    }

    if (eventName === "QualifiedLead" && lead.meta_qualified_sent_at) {
      return Response.json({
        ok: true,
        status: "already_sent",
        event_name: eventName,
        event_id: lead.meta_qualified_event_id,
        sent_at: lead.meta_qualified_sent_at,
      });
    }

    if (eventName === "Purchase" && lead.meta_purchase_sent_at) {
      return Response.json({
        ok: true,
        status: "already_sent",
        event_name: eventName,
        event_id: lead.meta_purchase_event_id,
        sent_at: lead.meta_purchase_sent_at,
      });
    }

    const numericValue = Number(body?.value ?? lead.sale_value);
    if (eventName === "Purchase" && (!Number.isFinite(numericValue) || numericValue <= 0)) {
      return Response.json({
        ok: true,
        status: "waiting_value",
        event_name: eventName,
        message: "Informe o valor da venda para enviar Purchase à Meta.",
      });
    }

    const datasetId = isLandingPageLead
      ? getWebDatasetId()
      : await getDatasetId(lead.waba_id);
    const eventId = `auron_crm_${lead.id}_${eventName.toLowerCase()}`;
    const sentAt = new Date().toISOString();

    let event;

    if (isLandingPageLead) {
      const phone = String(lead.phone || lead.wa_id || "").replace(/\D/g, "");
      const phoneHash = phone ? await sha256(phone) : null;
      const externalIdHash = await sha256(String(lead.id));

      const userData = {
        ...(landingAttribution?.fbc ? { fbc: landingAttribution.fbc } : {}),
        ...(landingAttribution?.fbp ? { fbp: landingAttribution.fbp } : {}),
        ...(landingAttribution?.client_ip_address
          ? { client_ip_address: landingAttribution.client_ip_address }
          : {}),
        ...(landingAttribution?.client_user_agent
          ? { client_user_agent: landingAttribution.client_user_agent }
          : {}),
        ...(phoneHash ? { ph: [phoneHash] } : {}),
        ...(externalIdHash ? { external_id: [externalIdHash] } : {}),
      };

      event = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        event_source_url:
          landingAttribution?.event_source_url ||
          "https://www.auronmarketing.com.br/",
        user_data: userData,
      };
    } else {
      event = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: {
          whatsapp_business_account_id: lead.waba_id,
          ctwa_clid: lead.ctwa_clid,
        },
      };
    }

    if (eventName === "Purchase") {
      event.custom_data = {
        currency: "BRL",
        value: numericValue,
      };
    }

    const metaData = await metaRequest(`${encodeURIComponent(datasetId)}/events`, {
      method: "POST",
      body: { data: [event] },
    });

    const update = {
      meta_last_error: null,
      meta_last_error_at: null,
    };

    if (eventName === "QualifiedLead") {
      update.meta_qualified_sent_at = sentAt;
      update.meta_qualified_event_id = eventId;
    } else {
      update.meta_purchase_sent_at = sentAt;
      update.meta_purchase_event_id = eventId;
    }

    await crmRequest(`leads?id=eq.${encodeURIComponent(lead.id)}&company_id=eq.${encodeURIComponent(company.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(update),
    });

    console.log("CRM_META_EVENT_ENVIADO", {
      lead_id: lead.id,
      event_name: eventName,
      event_id: eventId,
      dataset_id: datasetId,
    });

    return Response.json({
      ok: true,
      status: "sent",
      event_name: eventName,
      event_id: eventId,
      sent_at: sentAt,
      dataset_id: datasetId,
      meta: metaData,
    });
  } catch (error) {
    const message = errorText(error);
    console.error("CRM_META_EVENT_ERRO", message);

    if (leadId) {
      await markMetaError(leadId, message);
    }

    return Response.json({
      ok: false,
      status: "error",
      error: message,
      ...(error?.meta ? { meta: error.meta } : {}),
    }, { status: 500 });
  }
}
