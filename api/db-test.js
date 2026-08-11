export async function GET() {
  try {
    const baseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!baseUrl || !secretKey) {
      return Response.json(
        { ok: false, error: "Variáveis do Supabase ausentes" },
        { status: 500 }
      );
    }

    const response = await fetch(`${baseUrl}/rest/v1/leads?select=id&limit=1`, {
      headers: {
        apikey: secretKey,
      },
    });

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      data = text;
    }

    if (!response.ok) {
      return Response.json(
        { ok: false, status: response.status, error: data },
        { status: 500 }
      );
    }

    return Response.json({
      ok: true,
      database: "Supabase conectado",
      table: "leads",
      sample: data,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error?.message || "Erro desconhecido" },
      { status: 500 }
    );
  }
}
