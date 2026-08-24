function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = request.headers.get("x-auron-key");
  return Boolean(expected && provided && provided === expected);
}

async function metaRequest(path, { method = "GET" } = {}) {
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
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const message = data?.error?.message || `Meta respondeu ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.meta = data;
    throw err;
  }

  return data;
}

export async function POST(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const { waba_id } = await request.json();
    const wabaId = String(waba_id || "").trim();

    if (!/^\d+$/.test(wabaId)) {
      return Response.json({ ok: false, error: "WABA ID inválido" }, { status: 400 });
    }

    const subscribed = await metaRequest(`${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
    });

    let subscriptions = null;
    try {
      subscriptions = await metaRequest(`${encodeURIComponent(wabaId)}/subscribed_apps`);
    } catch (error) {
      console.log("WABA_LIST_SUBSCRIPTIONS_ERRO", error?.meta || error?.message || error);
    }

    console.log("WABA_SUBSCRIBED", { waba_id: wabaId, result: subscribed });

    return Response.json({
      ok: true,
      waba_id: wabaId,
      subscribed,
      subscriptions,
      message: "Auron Conversões inscrito na WABA com sucesso",
    });
  } catch (error) {
    console.error("WABA_SUBSCRIPTION_ERRO", error?.meta || error?.message || error);
    return Response.json(
      {
        ok: false,
        error: error?.message || "Erro ao inscrever WABA",
        ...(error?.meta ? { meta: error.meta } : {}),
      },
      { status: error?.status === 400 ? 400 : 500 }
    );
  }
}
