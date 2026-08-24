function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = request.headers.get("x-auron-key");
  return Boolean(expected && provided && provided === expected);
}

async function crmRequest(path) {
  const baseUrl = process.env.CRM_SUPABASE_URL;
  const secretKey = process.env.CRM_SUPABASE_SECRET_KEY;

  if (!baseUrl || !secretKey) {
    throw new Error("CRM_SUPABASE_URL ou CRM_SUPABASE_SECRET_KEY não configurada");
  }

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: secretKey,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    throw new Error(`CRM Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

export async function POST(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const companySlug = process.env.CRM_COMPANY_SLUG || "auron-marketing";
    const configuredWaba = process.env.CRM_WABA_ID || null;

    const companyParams = new URLSearchParams({
      slug: `eq.${companySlug}`,
      select: "id,name,slug",
      limit: "1",
    });
    const companies = await crmRequest(`companies?${companyParams.toString()}`);
    const company = companies?.[0];

    if (!company) {
      return Response.json({ ok: false, error: `Empresa ${companySlug} não encontrada no CRM` }, { status: 400 });
    }

    const stageParams = new URLSearchParams({
      company_id: `eq.${company.id}`,
      select: "id,name,position",
      order: "position.asc",
      limit: "1",
    });
    const stages = await crmRequest(`pipeline_stages?${stageParams.toString()}`);

    const memberParams = new URLSearchParams({
      company_id: `eq.${company.id}`,
      select: "user_id,role",
      limit: "1",
    });
    const members = await crmRequest(`company_members?${memberParams.toString()}`);

    // Também valida se a migration de integração já foi aplicada.
    const leadParams = new URLSearchParams({
      company_id: `eq.${company.id}`,
      select: "id,integration_source,integration_external_id,wa_id,waba_id,ctwa_clid",
      limit: "1",
    });
    await crmRequest(`leads?${leadParams.toString()}`);

    return Response.json({
      ok: true,
      ready: true,
      company,
      first_stage: stages?.[0] || null,
      assigned_user: members?.[0] || null,
      configured_waba_id: configuredWaba,
      message: "Auron Conversões está pronto para gravar leads no Auron CRM",
    });
  } catch (error) {
    console.error("CRM_CHECK_ERRO", error?.message || error);
    return Response.json({ ok: false, error: error?.message || "Erro ao validar CRM" }, { status: 500 });
  }
}
