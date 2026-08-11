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
  const body = await request.json();

  console.log("WEBHOOK_RECEBIDO");
  console.log(JSON.stringify(body, null, 2));

  return Response.json({ received: true });
}
