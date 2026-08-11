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

async function saveLead({ entry, value, message, body }) {
  const wabaId = entry?.id || null;
  const waId = message?.from || null;

  if (!wabaId || !waId) return;

  const contact = (value?.contacts || []).find((item) => item?.wa_id === waId) || value?.contacts?.[0];
  const referral = message?.referral || {};
  const timestamp = message?.timestamp
    ? new Date(Number(message.timestamp) * 1000).toISOString()
    : new Date().toISOString();

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
