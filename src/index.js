// Ponte FIX → Marombiew FX.
// QUOTE (sempre): preços 24h → velas → /api/public/fix/ingest
// TRADE (só com TRADE_ENABLED=true): busca comandos em /api/public/fix/commands,
// executa na corretora e devolve eventos e posições em /api/public/fix/report.
import { QuoteSession } from "./session.js";
import { TradeSession } from "./trade.js";
import { CandleBuilder } from "./candles.js";
import { OpenApiAccount } from "./openapi.js";
import { OpenApiTrader } from "./openapi-trade.js";

export const VERSION = "1.6.3";

const env = (k, d) => {
  const v = process.env[k];
  if (v == null || v === "") {
    if (d === undefined) throw new Error(`variável ${k} não definida (veja .env.example)`);
    return d;
  }
  return v;
};
const json = (k) => { const v = env(k, ""); return v ? JSON.parse(v) : {}; };

export function loadConfig() {
  const symbols = env("SYMBOLS", "EUR/USD,GBP/USD,USD/JPY,XAU/USD").split(",").map((s) => s.trim()).filter(Boolean);
  const ingestUrl = env("INGEST_URL");
  return {
    host: env("FIX_HOST", "live.cfixapi.com"),
    port: Number(env("FIX_PORT", "5211")),
    tradePort: Number(env("FIX_TRADE_PORT", "5212")),
    tls: env("FIX_TLS", "true") !== "false",
    senderCompID: env("FIX_SENDER_COMP_ID").trim(),
    targetCompID: env("FIX_TARGET_COMP_ID", "cServer").trim(),
    username: env("FIX_USERNAME").trim(),
    password: env("FIX_PASSWORD").trim().replace(/^"(.*)"$/, "$1"),
    heartbeat: Number(env("FIX_HEARTBEAT", "30")),
    priceSide: env("PRICE_SIDE", "bid"),
    symbols,
    symbolIds: json("SYMBOL_IDS"),
    ingestUrl,
    commandsUrl: env("COMMANDS_URL", ingestUrl.replace(/\/ingest$/, "/commands")),
    reportUrl: env("REPORT_URL", ingestUrl.replace(/\/ingest$/, "/report")),
    ingestToken: env("INGEST_TOKEN"),
    pushEveryMs: Number(env("PUSH_EVERY_MS", "10000")),
    tradeEnabled: env("TRADE_ENABLED", "false") === "true",
    // por onde as ordens saem: "openapi" (padrão; stop/alvo presos na posição) ou "fix"
    tradeVia: env("TRADE_VIA", "openapi").toLowerCase(),
    openApiEnabled: env("OPENAPI_ENABLED", "true") === "true",
    openApiUrl: env("OPENAPI_URL", "wss://live.ctraderapi.com:5036"),
    authUrl: env("CTRADER_AUTH_URL", ingestUrl.replace(/\/ingest$/, "/ctrader-auth")),
    pollEveryMs: Number(env("POLL_EVERY_MS", "1500")),
    maxLots: Number(env("MAX_LOTS_PER_ORDER", "0.10")),
    maxPositions: Number(env("MAX_OPEN_POSITIONS", "3")),
    lotSizes: json("LOT_SIZES"),
    steps: json("LOT_STEPS"),
    debug: env("DEBUG_FIX", "false") === "true",
  };
}

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

function reconnecting(session, state, isStopped) {
  session.on("up", () => { state.connected = true; state.message = ""; state.backoff = 2000; });
  session.on("rejected", (r) => (state.message = `logout: ${r}`));
  session.on("down", (why) => {
    state.connected = false;
    if (!state.message) state.message = why;
    if (isStopped()) return;
    session.log(`${why}; nova tentativa em ${state.backoff / 1000}s`);
    setTimeout(() => !isStopped() && session.connect(), state.backoff);
    state.backoff = Math.min(state.backoff * 2, 120000);
  });
}

export function startBridge(cfg = loadConfig()) {
  let stopped = false;
  const isStopped = () => stopped;
  const auth = { authorization: `Bearer ${cfg.ingestToken}` };

  // ---------- preços ----------
  const builder = new CandleBuilder();
  const quote = new QuoteSession({ ...cfg, log });
  const qs = { connected: false, lastTickAt: null, subscribed: [], message: "iniciando", backoff: 2000 };
  reconnecting(quote, qs, isStopped);
  quote.on("tick", (sym, price, ts, q) => {
    builder.tick(sym, price, ts);
    qs.lastTickAt = new Date(ts).toISOString();
    trade?.onQuote(sym, q);
  });
  quote.on("subscribed", (s) => (qs.subscribed = s));
  quote.on("up", () => push());
  quote.on("down", () => push());
  builder.onClose = () => setTimeout(push, 200);

  let sending = false;
  async function push() {
    if (sending) return;
    sending = true;
    try {
      builder.flush();
      do {
        const candles = builder.take(500);
        const body = {
          source: "ctrader-fix",
          status: { connected: qs.connected, last_tick_at: qs.lastTickAt, symbols: qs.subscribed, bridge_version: VERSION, message: qs.message },
          candles,
        };
        try {
          const res = await fetch(cfg.ingestUrl, {
            method: "POST", headers: { "content-type": "application/json", ...auth },
            body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) { builder.restore(candles); log(`envio recusado: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); break; }
        } catch (e) {
          builder.restore(candles);
          log(`falha no envio: ${e.message}`);
          break;
        }
      } while (builder.dirty.size > 0);
    } finally {
      sending = false;
    }
  }
  const pushTimer = setInterval(push, cfg.pushEveryMs);
  quote.connect();

  // ---------- ordens ----------
  let trade = null;
  let pollTimer = null;
  const ts = { connected: false, message: "", backoff: 2000 };
  const pendingEvents = [];
  let pendingPositions = null;
  let reporting = false;
  let pendingAccount = null;

  async function report() {
    if (reporting || (!trade && !pendingAccount)) return;
    reporting = true;
    const events = pendingEvents.splice(0);
    const positions = pendingPositions;
    pendingPositions = null;
    const account = pendingAccount;
    pendingAccount = null;
    try {
      const res = await fetch(cfg.reportUrl, {
        method: "POST", headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ trade_connected: !!(trade && ts.connected && trade.ready), events, positions, ...(account ? { account } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      pendingEvents.unshift(...events);
      if (positions && !pendingPositions) pendingPositions = positions;
      if (account && !pendingAccount) pendingAccount = account;
      log(`[TRADE] falha ao relatar: ${e.message}`);
      reporting = false;
      if (!stopped) setTimeout(report, 5000);
      return;
    } finally {
      reporting = false;
      // eventos que chegaram durante o envio saem logo em seguida
      if (!stopped && (pendingEvents.length || pendingPositions)) setTimeout(report, 300);
      if (!stopped && pendingAccount) setTimeout(report, 1000);
    }
  }

  let polling = false;
  async function poll() {
    if (polling || !trade?.loggedOn || !trade.ready) return;
    polling = true;
    try {
      const res = await fetch(cfg.commandsUrl, { headers: auth, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { commands = [] } = await res.json();
      for (const cmd of commands) {
        log(`[TRADE] comando ${cmd.id}: ${cmd.action} ${cmd.side ?? ""} ${cmd.symbol ?? ""} ${cmd.lots ?? ""}`);
        const rejection = trade.execute(cmd);
        if (rejection) { log(`[TRADE] recusado: ${rejection.reason}`); pendingEvents.push(rejection); }
      }
      if (commands.length) report();
    } catch (e) {
      log(`[TRADE] falha ao buscar comandos: ${e.message}`);
    } finally {
      polling = false;
    }
  }

  // ---------- saldo real (cTrader Open API) ----------
  let openapi = null;
  if (cfg.openApiEnabled) {
    openapi = new OpenApiAccount({
      url: cfg.openApiUrl, login: cfg.username, log, pollMs: 5000,
      getAuth: async () => {
        const res = await fetch(cfg.authUrl, { headers: auth, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });
    let lastSent = "";
    let lastAt = 0;
    openapi.on("account", (a) => {
      // manda quando muda, e pelo menos a cada 60 s (o app considera velho depois de 5 min)
      const key = `${a.balance}|${a.equity}|${a.margin_used}`;
      if (key === lastSent && Date.now() - lastAt < 60000) return;
      lastSent = key;
      lastAt = Date.now();
      pendingAccount = a;
      report();
    });
  }

  const viaOpenApi = cfg.tradeEnabled && cfg.tradeVia !== "fix" && !!openapi;
  if (cfg.tradeEnabled && cfg.tradeVia !== "fix" && !openapi) log("TRADE_VIA=openapi exige OPENAPI_ENABLED=true; usando FIX");

  if (viaOpenApi) {
    trade = new OpenApiTrader({
      account: openapi, symbols: cfg.symbols, log,
      maxLots: cfg.maxLots, maxPositions: cfg.maxPositions,
      getQuote: (s) => quote.quotes.get(s),
    });
    ts.connected = false;
    trade.on("up", () => { ts.connected = true; report(); });
    trade.on("down", () => { ts.connected = false; report(); });
    trade.on("event", (e) => { log(`[TRADE] ${e.type} ${e.symbol} ${e.price ?? ""} ${e.reason ?? ""}`); pendingEvents.push(e); report(); });
    trade.on("positions", (p) => { pendingPositions = p; report(); });
    pollTimer = setInterval(poll, cfg.pollEveryMs);
    log(`ordens pela cTrader Open API (máx ${cfg.maxLots} lote por ordem, ${cfg.maxPositions} posições); sessão FIX TRADE não é aberta`);
  } else if (cfg.tradeEnabled) {
    trade = new TradeSession({
      ...cfg, port: cfg.tradePort, log,
      maxLots: cfg.maxLots, maxPositions: cfg.maxPositions,
      getQuote: (s) => quote.quotes.get(s),
    });
    reconnecting(trade, ts, isStopped);
    trade.on("event", (e) => { log(`[TRADE] ${e.type} ${e.symbol} ${e.price ?? ""} ${e.reason ?? ""}`); pendingEvents.push(e); report(); });
    trade.on("positions", (p) => { pendingPositions = p; report(); });
    trade.on("down", () => report());
    pollTimer = setInterval(poll, cfg.pollEveryMs);
    trade.connect();
    log(`ordens pela sessão FIX TRADE (máx ${cfg.maxLots} lote por ordem, ${cfg.maxPositions} posições)`);
  } else {
    log("sessão TRADE desligada (TRADE_ENABLED=false): só preços");
  }

  openapi?.start();

  const stop = () => {
    openapi?.stop();
    stopped = true;
    clearInterval(pushTimer);
    clearInterval(pollTimer);
    quote.close("ponte desligada");
    trade?.close("ponte desligada");
  };
  return { stop, session: quote, quote, trade, builder, state: qs, push };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  log(`Marombiew FIX bridge ${VERSION}`);
  const bridge = startBridge();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { bridge.stop(); setTimeout(() => process.exit(0), 1000); });
}
