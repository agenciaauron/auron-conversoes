function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = request.headers.get("x-auron-key");
  return Boolean(expected && provided && provided === expected);
}

async function metaRequest(path) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const graphVersion = process.env.META_GRAPH_VERSION || "v26.0";

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN não configurado");
  }

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
    method: "GET",
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
    const err = new Error(data?.error?.message || `Meta respondeu ${response.status}`);
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

    const dataset = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`);

    console.log("WABA_DATASET_OK", { waba_id: wabaId, dataset });

    return Response.json({
      ok: true,
      waba_id: wabaId,
      dataset,
      message: "Acesso ao dataset da WABA confirmado",
    });
  } catch (error) {
    console.error("WABA_DATASET_ERRO", error?.meta || error?.message || error);
    return Response.json(
      {
        ok: false,
        error: error?.message || "Erro ao consultar dataset da WABA",
        ...(error?.meta ? { meta: error.meta } : {}),
      },
      { status: error?.status === 400 ? 400 : 500 }
    );
  }
}
