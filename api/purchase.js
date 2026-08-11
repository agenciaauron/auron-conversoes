function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = request.headers.get("x-auron-key");
  return Boolean(expected && provided && provided === expected);
}

async function supabaseRequest(path, options = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!baseUrl || !secretKey) {
    throw new Error("Supabase não configurado");
  }

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: secretKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
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

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const err = new Error(`Meta ${response.status}`);
    err.meta = data;
    throw err;
  }

  return data;
}

function extractDatasetId(data) {
  if (!data) return null;
  if (typeof data.id === "string" || typeof data.id === "number") return String(data.id);
  if (Array.isArray(data.data) && data.data[0]?.id) return String(data.data[0].id);
  return null;
}

async function getOrCreateDatasetId(wabaId) {
  const forced = process.env.META_DATASET_ID;
  if (forced) return forced;

  try {
    const current = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`);
    const currentId = extractDatasetId(current);
    if (currentId) return currentId;
  } catch (error) {
    console.log("DATASET_GET_NAO_DISPONIVEL", error?.meta || error?.message || error);
  }

  const created = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`, { method: "POST" });
  const createdId = extractDatasetId(created);

  if (!createdId) {
    const err = new Error("A Meta não retornou o dataset_id");
    err.meta = created;
    throw err;
  }

  return createdId;
}

function makeLocalEventId() {
  return `auron_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function POST(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const { lead_id, value, currency = "BRL" } = await request.json();
    const numericValue = Number(value);

    if (!lead_id || !Number.isFinite(numericValue) || numericValue <= 0) {
      return Response.json({ ok: false, error: "Lead e valor da venda são obrigatórios" }, { status: 400 });
    }

    const query = new URLSearchParams({
      id: `eq.${lead_id}`,
      select: "id,nome,wa_id,waba_id,ctwa_clid,comprou,purchase_sent_at,moeda",
      limit: "1",
    });

    const rows = await supabaseRequest(`leads?${query.toString()}`, { method: "GET" });
    const lead = rows?.[0];

    if (!lead) {
      return Response.json({ ok: false, error: "Lead não encontrado" }, { status: 404 });
    }

    if (lead.comprou || lead.purchase_sent_at) {
      return Response.json({ ok: false, error: "Essa compra já foi enviada" }, { status: 409 });
    }

    if (!lead.waba_id || !lead.ctwa_clid) {
      return Response.json({
        ok: false,
        error: "Esse lead não possui WABA/ctwa_clid. Só é possível enviar compras vinculadas a uma conversa originada de anúncio Click-to-WhatsApp."
      }, { status: 400 });
    }

    if (!process.env.META_ACCESS_TOKEN) {
      return Response.json({
        ok: false,
        error: "Meta CAPI ainda não configurada. Falta META_ACCESS_TOKEN na Vercel."
      }, { status: 503 });
    }

    const datasetId = await getOrCreateDatasetId(lead.waba_id);
    const eventTime = Math.floor(Date.now() / 1000);
    const eventCurrency = String(currency || lead.moeda || "BRL").toUpperCase();

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime,
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: {
            whatsapp_business_account_id: lead.waba_id,
            ctwa_clid: lead.ctwa_clid,
          },
          custom_data: {
            currency: eventCurrency,
            value: numericValue,
          },
        },
      ],
    };

    const metaData = await metaRequest(`${encodeURIComponent(datasetId)}/events`, {
      method: "POST",
      body: payload,
    });

    const localEventId = makeLocalEventId();
    const sentAt = new Date().toISOString();

    await supabaseRequest(`leads?id=eq.${encodeURIComponent(lead.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "comprou",
        comprou: true,
        valor_venda: numericValue,
        moeda: eventCurrency,
        meta_event_id: localEventId,
        purchase_sent_at: sentAt,
      }),
    });

    console.log("PURCHASE_ENVIADO", { lead_id: lead.id, event: localEventId, dataset_id: datasetId });

    return Response.json({
      ok: true,
      message: "Compra enviada para a Meta",
      event_id: localEventId,
      dataset_id: datasetId,
      meta: metaData,
    });
  } catch (error) {
    console.error("PURCHASE_ERRO", error?.meta || error?.message || error);
    return Response.json({
      ok: false,
      error: error?.message || "Erro interno",
      ...(error?.meta ? { meta: error.meta } : {}),
    }, { status: 500 });
  }
}
