function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const provided = request.headers.get("x-auron-key");
  return Boolean(expected && provided && provided === expected);
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const baseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!baseUrl || !secretKey) {
      return Response.json({ ok: false, error: "Supabase não configurado" }, { status: 500 });
    }

    const fields = [
      "id",
      "nome",
      "telefone",
      "wa_id",
      "waba_id",
      "phone_number_id",
      "mensagem",
      "tipo_mensagem",
      "ctwa_clid",
      "source_id",
      "source_url",
      "headline",
      "status",
      "comprou",
      "valor_venda",
      "moeda",
      "meta_event_id",
      "purchase_sent_at",
      "data_primeira_mensagem",
      "ultima_mensagem_em",
      "created_at"
    ].join(",");

    const response = await fetch(
      `${baseUrl}/rest/v1/leads?select=${encodeURIComponent(fields)}&order=ultima_mensagem_em.desc.nullslast&limit=100`,
      { headers: { apikey: secretKey } }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("LEADS_SUPABASE_ERRO", response.status, data);
      return Response.json({ ok: false, error: "Falha ao consultar leads" }, { status: 500 });
    }

    return Response.json({ ok: true, leads: data });
  } catch (error) {
    console.error("LEADS_ERRO", error?.message || error);
    return Response.json({ ok: false, error: "Erro interno" }, { status: 500 });
  }
}
