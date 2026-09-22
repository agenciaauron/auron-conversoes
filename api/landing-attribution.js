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

function clean(value, max = 1000) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function randomRef() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const ref = randomRef();
    const now = new Date().toISOString();

    const forwardedFor = request.headers.get("x-forwarded-for") || "";
    const clientIp = clean(forwardedFor.split(",")[0], 100);
    const userAgent = clean(request.headers.get("user-agent"), 700);

    const attribution = {
      ref,
      page_url: clean(body?.page_url, 2000),
      fbclid: clean(body?.fbclid, 800),
      fbc: clean(body?.fbc, 1000),
      fbp: clean(body?.fbp, 1000),
      utm_source: clean(body?.utm_source, 300),
      utm_medium: clean(body?.utm_medium, 300),
      utm_campaign: clean(body?.utm_campaign, 500),
      utm_content: clean(body?.utm_content, 500),
      utm_term: clean(body?.utm_term, 500),
      client_ip_address: clientIp,
      client_user_agent: userAgent,
      captured_at: now,
    };

    await supabaseRequest("leads", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        nome: "Landing attribution",
        telefone: null,
        wa_id: `lp:${ref}`,
        waba_id: "landing_attribution",
        mensagem: "landing_attribution",
        tipo_mensagem: "landing_attribution",
        ultima_mensagem_em: now,
        data_primeira_mensagem: now,
        source_url: attribution.page_url,
        headline: attribution.utm_campaign,
        raw_payload: attribution,
      }),
    });

    return Response.json({ ok: true, ref });
  } catch (error) {
    console.error("LANDING_ATTRIBUTION_ERRO", error?.message || error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
