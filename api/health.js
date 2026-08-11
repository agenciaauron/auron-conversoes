export function GET() {
  return Response.json({
    ok: true,
    service: "Auron Conversões",
    timestamp: new Date().toISOString()
  });
}
