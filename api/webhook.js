export default function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Token de verificação inválido");
  }

  if (req.method === "POST") {
    console.log("WEBHOOK_RECEBIDO");
    console.log(JSON.stringify(req.body, null, 2));
    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: "Método não permitido" });
}
