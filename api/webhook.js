function supabaseHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!baseUrl || !secretKey) {
    throw new Error("SUPABASE_URL ou SUPABASE_SECRET_KEY não configurada");
  }

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {}),
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

function crmSupabaseHeaders(extra = {}) {
  return {
    apikey: process.env.CRM_SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function crmSupabaseRequest(path, options = {}) {
  const baseUrl = process.env.CRM_SUPABASE_URL;
  const secretKey = process.env.CRM_SUPABASE_SECRET_KEY;

  if (!baseUrl || !secretKey) {
    throw new Error("CRM_SUPABASE_URL ou CRM_SUPABASE_SECRET_KEY não configurada");
  }

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: crmSupabaseHeaders(options.headers || {}),
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`CRM Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

function getMessageText(message) {
  if (!message) return null;

  if (message.type === "text") return message.text?.body || null;
  if (message.type === "button") return message.button?.text || null;
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      null
    );
  }

  const typedContent = message[message.type];
  if (typedContent && typeof typedContent === "object") {
    return JSON.stringify(typedContent);
  }

  return null;
}

function messageTimestamp(message) {
  return message?.timestamp
    ? new Date(Number(message.timestamp) * 1000).toISOString()
    : new Date().toISOString();
}

async function saveLead({ entry, value, message, body }) {
  const wabaId = entry?.id || null;
  const waId = message?.from || null;

  if (!wabaId || !waId) return;

  const contact = (value?.contacts || []).find((item) => item?.wa_id === waId) || value?.contacts?.[0];
  const referral = message?.referral || {};
  const timestamp = messageTimestamp(message);

  const query = new URLSearchParams({
    waba_id: `eq.${wabaId}`,
    wa_id: `eq.${waId}`,
    select: "id,data_primeira_mensagem,ctwa_clid,source_id,source_url,headline",
    limit: "1",
  });

  const existing = await supabaseRequest(`leads?${query.toString()}`, {
    method: "GET",
  });

  const commonData = {
    nome: contact?.profile?.name || null,
    telefone: message?.from || contact?.wa_id || null,
    wa_id: waId,
    waba_id: wabaId,
    phone_number_id: value?.metadata?.phone_number_id || null,
    mensagem: getMessageText(message),
    tipo_mensagem: message?.type || null,
    ultima_mensagem_em: timestamp,
    raw_payload: body,
  };

  if (existing?.length) {
    const previous = existing[0];
    const updateData = { ...commonData };

    if (referral.ctwa_clid) updateData.ctwa_clid = referral.ctwa_clid;
    if (referral.source_id) updateData.source_id = referral.source_id;
    if (referral.source_url) updateData.source_url = referral.source_url;
    if (referral.headline) updateData.headline = referral.headline;

    await supabaseRequest(`leads?id=eq.${encodeURIComponent(previous.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(updateData),
    });

    console.log("LEAD_ATUALIZADO", waId, referral.ctwa_clid || previous.ctwa_clid || "sem_ctwa_clid");
    return;
  }

  const insertData = {
    ...commonData,
    ctwa_clid: referral.ctwa_clid || null,
    source_id: referral.source_id || null,
    source_url: referral.source_url || null,
    headline: referral.headline || null,
    data_primeira_mensagem: timestamp,
  };

  await supabaseRequest("leads", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(insertData),
  });

  console.log("LEAD_CRIADO", waId, referral.ctwa_clid || "sem_ctwa_clid");
}

async function getCrmContext() {
  const companySlug = process.env.CRM_COMPANY_SLUG || "auron-marketing";

  const companiesQuery = new URLSearchParams({
    slug: `eq.${companySlug}`,
    select: "id,name",
    limit: "1",
  });

  const companies = await crmSupabaseRequest(`companies?${companiesQuery.toString()}`, {
    method: "GET",
  });
  const company = companies?.[0];

  if (!company?.id) {
    throw new Error(`Empresa do CRM não encontrada para o slug ${companySlug}`);
  }

  const stagesQuery = new URLSearchParams({
    company_id: `eq.${company.id}`,
    select: "id,name,position",
    order: "position.asc",
    limit: "1",
  });

  const stages = await crmSupabaseRequest(`pipeline_stages?${stagesQuery.toString()}`, {
    method: "GET",
  });
  const firstStage = stages?.[0];

  if (!firstStage?.id) {
    throw new Error("Etapa inicial do CRM não encontrada");
  }

  const membersQuery = new URLSearchParams({
    company_id: `eq.${company.id}`,
    select: "user_id,role",
    limit: "1",
  });

  const members = await crmSupabaseRequest(`company_members?${membersQuery.toString()}`, {
    method: "GET",
  });

  return {
    company,
    firstStage,
    assignedTo: members?.[0]?.user_id || null,
  };
}

async function syncLeadToCrm({ entry, value, message }) {
  const wabaId = String(entry?.id || "");
  const waId = String(message?.from || "");
  const referral = message?.referral || {};

  // O CRM recebe apenas contatos originados de anúncio Click-to-WhatsApp.
  // Mensagens diretas continuam sendo registradas apenas no Auron Conversões.
  if (!referral.ctwa_clid || !wabaId || !waId) {
    return { skipped: true, reason: "sem_ctwa_clid" };
  }

  const configuredWaba = String(process.env.CRM_WABA_ID || "").trim();
  if (configuredWaba && configuredWaba !== wabaId) {
    return { skipped: true, reason: "waba_nao_configurada" };
  }

  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_SECRET_KEY) {
    return { skipped: true, reason: "crm_nao_configurado" };
  }

  const { company, firstStage, assignedTo } = await getCrmContext();
  const contact = (value?.contacts || []).find((item) => item?.wa_id === waId) || value?.contacts?.[0];
  const externalId = `${wabaId}:${waId}`;
  const timestamp = messageTimestamp(message);

  const existingQuery = new URLSearchParams({
    company_id: `eq.${company.id}`,
    integration_source: "eq.whatsapp",
    integration_external_id: `eq.${externalId}`,
    select: "id,stage_id",
    limit: "1",
  });

  const existing = await crmSupabaseRequest(`leads?${existingQuery.toString()}`, {
    method: "GET",
  });

  const crmData = {
    name: contact?.profile?.name || `WhatsApp ${waId.slice(-4)}`,
    phone: waId,
    source: "Anúncio WhatsApp",
    campaign: referral.headline || null,
    integration_source: "whatsapp",
    integration_external_id: externalId,
    wa_id: waId,
    waba_id: wabaId,
    ctwa_clid: referral.ctwa_clid,
    meta_source_id: referral.source_id || null,
    meta_source_url: referral.source_url || null,
    meta_headline: referral.headline || null,
    last_message: getMessageText(message),
    last_message_at: timestamp,
  };

  if (existing?.length) {
    await crmSupabaseRequest(`leads?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(crmData),
    });

    console.log("CRM_LEAD_ATUALIZADO", { wa_id: waId, lead_id: existing[0].id });
    return { synced: true, created: false, leadId: existing[0].id };
  }

  const insertData = {
    ...crmData,
    company_id: company.id,
    stage_id: firstStage.id,
    ...(assignedTo ? { assigned_to: assignedTo } : {}),
  };

  const inserted = await crmSupabaseRequest("leads?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(insertData),
  });

  const leadId = inserted?.[0]?.id || null;
  console.log("CRM_LEAD_CRIADO", { wa_id: waId, lead_id: leadId, company_id: company.id });
  return { synced: true, created: true, leadId };
}

export async function GET(request) {
  const url = new URL(request.url);

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Token de verificação inválido", { status: 403 });
}

export async function POST(request) {
  try {
    const body = await request.json();

    console.log("WEBHOOK_RECEBIDO");

    let processed = 0;

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (change?.field !== "messages") continue;

        const value = change?.value || {};

        for (const message of value?.messages || []) {
          await saveLead({ entry, value, message, body });

          try {
            const crmResult = await syncLeadToCrm({ entry, value, message });
            if (crmResult?.skipped) {
              console.log("CRM_SYNC_IGNORADO", crmResult.reason);
            }
          } catch (crmError) {
            // Não derruba o webhook do WhatsApp se o CRM estiver temporariamente indisponível.
            console.error("CRM_SYNC_ERRO", crmError?.message || crmError);
          }

          processed += 1;
        }
      }
    }

    console.log("WEBHOOK_PROCESSADO", { processed });

    return Response.json({ received: true, processed });
  } catch (error) {
    console.error("WEBHOOK_ERRO", error?.message || error);
    return Response.json(
      { received: false, error: "Falha ao processar webhook" },
      { status: 500 }
    );
  }
}
