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

    const accessToken = process.env.META_ACCESS_TOKEN;
    const datasetId = process.env.META_DATASET_ID;
    const graphVersion = process.env.META_GRAPH_VERSION || "v26.0";

    if (!accessToken || !datasetId) {
      return Response.json({
        ok: false,
        error: "Meta CAPI ainda não configurada. Faltam META_ACCESS_TOKEN e/ou META_DATASET_ID na Vercel."
      }, { status: 503 });
    }

    const eventTime = Math.floor(Date.now() / 1000);
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
            currency: String(currency || lead.moeda || "BRL").toUpperCase(),
            value: numericValue,
          },
        },
      ],
    };

    const metaResponse = await fetch(`https://graph.facebook.com/${graphVersion}/${datasetId}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const metaText = await metaResponse.text();
    let metaData = null;
    if (metaText) {
      try { metaData = JSON.parse(metaText); } catch { metaData = metaText; }
    }

    if (!metaResponse.ok) {
      console.error("META_PURCHASE_ERRO", metaResponse.status, metaData);
      return Response.json({
        ok: false,
        error: "A Meta recusou o evento de compra",
        meta: metaData,
      }, { status: 502 });
    }

    const localEventId = makeLocalEventId();
    const sentAt = new Date().toISOString();

    await supabaseRequest(`leads?id=eq.${encodeURIComponent(lead.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "comprou",
        comprou: true,
        valor_venda: numericValue,
        moeda: String(currency || lead.moeda || "BRL").toUpperCase(),
        meta_event_id: localEventId,
        purchase_sent_at: sentAt,
      }),
    });

    console.log("PURCHASE_ENVIADO", { lead_id: lead.id, event: localEventId });

    return Response.json({
      ok: true,
      message: "Compra enviada para a Meta",
      event_id: localEventId,
      meta: metaData,
    });
  } catch (error) {
    console.error("PURCHASE_ERRO", error?.message || error);
    return Response.json({ ok: false, error: error?.message || "Erro interno" }, { status: 500 });
  }
}
