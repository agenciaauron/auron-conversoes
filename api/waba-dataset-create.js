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
    const err = new Error(data?.error?.message || `Meta respondeu ${response.status}`);
    err.status = response.status;
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

    const current = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`);
    const currentId = extractDatasetId(current);

    if (currentId) {
      return Response.json({
        ok: true,
        created: false,
        waba_id: wabaId,
        dataset_id: currentId,
        dataset: current,
        message: "A WABA já possui dataset",
      });
    }

    const created = await metaRequest(`${encodeURIComponent(wabaId)}/dataset`, { method: "POST" });
    const datasetId = extractDatasetId(created);

    if (!datasetId) {
      return Response.json({
        ok: false,
        error: "A Meta não retornou o ID do dataset criado",
        meta: created,
      }, { status: 500 });
    }

    console.log("WABA_DATASET_CREATED", { waba_id: wabaId, dataset_id: datasetId });

    return Response.json({
      ok: true,
      created: true,
      waba_id: wabaId,
      dataset_id: datasetId,
      meta: created,
      message: "Dataset da WABA criado com sucesso",
    });
  } catch (error) {
    console.error("WABA_DATASET_CREATE_ERRO", error?.meta || error?.message || error);
    return Response.json(
      {
        ok: false,
        error: error?.message || "Erro ao criar dataset da WABA",
        ...(error?.meta ? { meta: error.meta } : {}),
      },
      { status: error?.status === 400 ? 400 : 500 }
    );
  }
}
