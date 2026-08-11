# Auron Conversões — Webhook inicial

## Rotas
- `/api/health`
- `/api/webhook`

## Variável de ambiente
Cadastre `VERIFY_TOKEN` na hospedagem.

Use uma senha longa e exclusiva. O mesmo valor deverá ser digitado no campo **Verificar token** da Meta.

Não use o Access Token da Meta nesse campo.

## Depois do deploy
Se o domínio for `https://auron-conversoes.vercel.app`, use:

Callback URL:
`https://auron-conversoes.vercel.app/api/webhook`

Verify token:
o mesmo valor de `VERIFY_TOKEN`.

## Próximas etapas
1. validar assinatura dos webhooks;
2. armazenar leads e `ctwa_clid`;
3. criar painel;
4. enviar `Purchase` pela Conversions API for Business Messaging.
