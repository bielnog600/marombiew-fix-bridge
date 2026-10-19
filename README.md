# Ponte FIX → Marombiew FX

Serviço que fica ligado 24h, conectado à sessão **QUOTE** (só preços) da sua conta cTrader na IC.
Ele recebe os ticks, monta as velas M5/M15/H1/H4/D1 e envia para o Marombiew FX a cada 10 segundos
e logo que uma vela fecha. Não envia ordens: a sessão TRADE é bloqueada no código.

Com `TRADE_ENABLED=true`, ela também abre a sessão **TRADE** e executa as ordens que o app
coloca na fila (botões COMPRA/VENDA e auto trader). Desligado por padrão.

Sem dependências: só Node 20 ou mais novo.

## O que precisa

1. **Um servidor ligado 24h.** O backend do Lovable não segura conexão aberta, então a ponte roda fora:
   - VPS barata (Hetzner, Contabo, DigitalOcean), 1 vCPU e 512 MB bastam; ou
   - Railway / Render / Fly.io como "worker" (serviço sem site), usando o Dockerfile.
   Seu computador também funciona para teste, mas desligou, parou o feed.
2. **A senha da conta 9010569** (a mesma do cTrader).
3. **O token de ingestão**: a mesma string no secret `FIX_INGEST_TOKEN` do Lovable e no `INGEST_TOKEN` daqui.
4. **O link publicado do Marombiew FX**, para montar o `INGEST_URL`.

## Instalar numa VPS (Ubuntu)

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Copie esta pasta para o servidor (scp, git ou upload) e entre nela
cd marombiew-fix-bridge
cp .env.example .env
nano .env        # preencha FIX_PASSWORD, INGEST_URL e INGEST_TOKEN

# 3. Suba (reinicia sozinho se o servidor reiniciar ou a ponte cair)
docker compose up -d --build

# 4. Acompanhe
docker compose logs -f
```

Logs esperados:

```
conectado em live.cfixapi.com:5211, enviando logon
logon aceito
assinado: EUR/USD, GBP/USD, USD/JPY, XAU/USD
```

Sem Docker: `node --env-file=.env src/index.js` (use `pm2` ou `systemd` para manter ligado).

## Variáveis

| Variável | Para quê |
|---|---|
| `FIX_SENDER_COMP_ID` | `live5.icmarkets.9010569` |
| `FIX_USERNAME` | número da conta: `9010569` |
| `FIX_PASSWORD` | senha da conta |
| `FIX_PORT` | `5211` (SSL). Não use a porta sem SSL fora de teste |
| `SYMBOLS` | pares no formato do app, separados por vírgula |
| `SYMBOL_IDS` | só se um par não for encontrado sozinho: `{"XAU/USD":"41"}` |
| `PRICE_SIDE` | `bid` (padrão, igual ao gráfico do cTrader), `ask` ou `mid` |
| `INGEST_URL` | `https://<app publicado>/api/public/fix/ingest` |
| `INGEST_TOKEN` | igual ao secret `FIX_INGEST_TOKEN` no Lovable |
| `DEBUG_FIX` | `true` mostra as mensagens FIX no log (senha escondida) |

## Ordens (sessão TRADE)

Fluxo: o app grava o comando → a ponte busca em `/api/public/fix/commands` a cada 1,5 s →
envia à corretora → relata em `/api/public/fix/report` (eventos e posições abertas).

O que a ponte garante, independente do app:

- Toda entrada sai **a mercado** e, assim que executa, recebe **stop e alvo vinculados à posição**.
- Se a corretora recusar o stop, a posição é **fechada na hora**. Nunca fica posição sem stop.
- Quando o stop ou o alvo executa, a outra ordem é cancelada (formato oficial 41+37+11).
- Fechamento manual cancela stop e alvo **antes** de mandar a ordem de fechamento.
- A cada 15 s a ponte confere posições (AN) e ordens pendentes (AF): ordem de stop/alvo sem posição
  correspondente (ou do mesmo lado da posição) é **órfã** e é cancelada.
- Se mesmo assim uma ordem órfã executar e reabrir uma posição, a ponte **fecha na hora** e avisa.
- Recusa: comando com mais de 30 s, lote acima de `MAX_LOTS_PER_ORDER`, posições acima de
  `MAX_OPEN_POSITIONS`, sem stop ou alvo, stop/alvo do lado errado do preço atual, par sem preço ao vivo.
- Volume: 0.01 lote = 1.000 unidades no forex e 1 unidade (onça) no ouro. Ajustável com `LOT_SIZES`
  e `LOT_STEPS` se a corretora usar outro tamanho.
- **Gestão do lucro** (quando o comando traz `manage`, o app manda isso no auto trader):
  - lucro ≥ `be_r` × risco → stop vai para a entrada + `lock_pips`;
  - lucro ≥ `trail_start_r` × risco → stop móvel a `trail_r` × risco abaixo do pico;
  - o stop só anda a favor, nunca recua; se o lucro voltar além do novo stop antes de mover, fecha a mercado.
  - Padrão: `be_r` 0.8, `lock_pips` 1, `trail_start_r` 1, `trail_r` 0.5. Evento `stop_moved` vai no relatório.
  - Ao reiniciar, a ponte pede à corretora as ordens abertas (35=AF) e recupera stop e alvo de cada posição.
  - Comando `manage` (`position_id`, `initial_stop`, `manage`) liga ou desliga a gestão numa posição já aberta.
- Saldo e equity **não** vêm pelo FIX; isso fica para a cTrader Open API.

## Ordens pela cTrader Open API (padrão desde a 1.6.0)

Com `TRADE_ENABLED=true`, as ordens saem pela **Open API** (`TRADE_VIA=openapi`, o padrão), na mesma
conexão do saldo. O stop e o alvo vão **na própria ordem** e ficam presos à posição: fechou a posição,
eles somem juntos. Não existe mais ordem de stop/alvo solta que possa reabrir posição.

- O token precisa da permissão **"Access your accounts and trade"**. O log mostra
  `permissão do token: operar (trading)`. Se mostrar `SÓ LEITURA`, reconecte a conta na aba Conta do app.
- Stop e alvo são enviados relativos ao preço de execução: com deslize, o risco planejado se mantém.
- Se a posição nascer sem stop, a ponte coloca o stop; se a corretora recusar, fecha a posição na hora.
- Stop na entrada e stop móvel alteram o stop da posição (amend). O plano da gestão fica gravado no
  comentário da posição, então uma ponte reiniciada continua a gestão.
- Nesse modo a sessão FIX TRADE não é aberta. A FIX continua só para os preços.
- Para voltar às ordens pela FIX: `TRADE_VIA=fix`.

## Saldo real (cTrader Open API)

A ponte abre uma conexão Open API (WebSocket, só leitura) e manda saldo, equity e margem da conta
para o app a cada 5 s, junto com o relatório. Os tokens vêm do app (`/api/public/fix/ctrader-auth`),
depois que você clica em "Conectar conta cTrader" na aba Conta. Sem token, ela só tenta de novo a cada
60 s e o resto continua funcionando. Desligar: `OPENAPI_ENABLED=false`.

## Problemas comuns

- **Logout logo após o logon**: senha errada, conta errada ou FIX desligado na conta.
  No cTrader: Configurações → FIX API confere os dados.
- **"símbolos não encontrados"**: o nome do par na corretora é diferente. Rode com `DEBUG_FIX=true`,
  procure a lista (mensagem `35=y`) e passe o ID em `SYMBOL_IDS`.
- **"envio recusado: HTTP 401"**: token diferente entre a ponte e o Lovable.
- **"envio recusado: HTTP 404"**: `INGEST_URL` errado ou o app ainda não foi publicado com a mudança.
- **Mercado fechado** (fim de semana): não chegam ticks. A ponte continua conectada e o app volta a
  usar a Twelve Data até os preços voltarem.

## Segurança

- A senha fica só no `.env` do servidor. Nunca no Lovable, no chat ou no git.
- Se a senha da conta aparecer em algum lugar, troque no cTrader e atualize o `.env`.
- A sessão TRADE só abre com `TRADE_ENABLED=true`. Para parar o robô na hora, troque para `false`.

## Testes

```bash
npm test
```
Testa a montagem das mensagens FIX, as velas e o fluxo completo contra um servidor FIX simulado.
