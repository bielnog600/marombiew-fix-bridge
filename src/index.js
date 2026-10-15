// Ponte FIX → Marombiew FX: mantém a sessão QUOTE do cTrader aberta 24h,
// monta velas e envia para /api/public/fix/ingest.
import { QuoteSession } from "./session.js";
import { CandleBuilder } from "./candles.js";

export const VERSION = "1.0.1";

const env = (k, d) => {
  const v = process.env[k];
  if (v == null || v === "") {
    if (d === undefined) throw new Error(`variável ${k} não definida (veja .env.example)`);
    return d;
  }
  return v;
};

export function loadConfig() {
  const symbols = env("SYMBOLS", "EUR/USD,GBP/USD,USD/JPY,XAU/USD").split(",").map((s) => s.trim()).filter(Boolean);
  let symbolIds = {};
  const raw = env("SYMBOL_IDS", "");
  if (raw) symbolIds = JSON.parse(raw);
  return {
    host: env("FIX_HOST", "live.cfixapi.com"),
    port: Number(env("FIX_PORT", "5211")),
    tls: env("FIX_TLS", "true") !== "false",
    senderCompID: env("FIX_SENDER_COMP_ID").trim(),
    targetCompID: env("FIX_TARGET_COMP_ID", "cServer"),
    senderSubID: env("FIX_SENDER_SUB_ID", "QUOTE"),
    username: env("FIX_USERNAME").trim(),
    password: env("FIX_PASSWORD").trim().replace(/^"(.*)"$/, "$1"),
    heartbeat: Number(env("FIX_HEARTBEAT", "30")),
    priceSide: env("PRICE_SIDE", "bid"),
    symbols,
    symbolIds,
    ingestUrl: env("INGEST_URL"),
    ingestToken: env("INGEST_TOKEN"),
    pushEveryMs: Number(env("PUSH_EVERY_MS", "10000")),
    debug: env("DEBUG_FIX", "false") === "true",
  };
}

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

export function startBridge(cfg = loadConfig()) {
  if (cfg.senderSubID !== "QUOTE") throw new Error("esta ponte só usa a sessão QUOTE (preços). Nunca configure TRADE aqui.");
  const builder = new CandleBuilder();
  const session = new QuoteSession({ ...cfg, log });
  const state = { connected: false, lastTickAt: null, subscribed: [], message: "iniciando", backoff: 2000 };
  let sending = false;
  let stopped = false;

  session.on("tick", (sym, price, ts) => {
    builder.tick(sym, price, ts);
    state.lastTickAt = new Date(ts).toISOString();
  });
  session.on("up", () => {
    state.connected = true;
    state.message = "";
    state.backoff = 2000;
    push();
  });
  session.on("subscribed", (s) => (state.subscribed = s));
  session.on("rejected", (r) => (state.message = `logout: ${r}`));
  session.on("down", (why) => {
    state.connected = false;
    if (!state.message) state.message = why;
    push();
    if (stopped) return;
    log(`${why}; nova tentativa em ${state.backoff / 1000}s`);
    setTimeout(() => !stopped && session.connect(), state.backoff);
    state.backoff = Math.min(state.backoff * 2, 120000);
  });
  builder.onClose = () => setTimeout(push, 200);

  async function push() {
    if (sending) return;
    sending = true;
    try {
      builder.flush();
      do {
        const candles = builder.take(500);
        const body = {
          source: "ctrader-fix",
          status: {
            connected: state.connected,
            last_tick_at: state.lastTickAt,
            symbols: state.subscribed,
            bridge_version: VERSION,
            message: state.message,
          },
          candles,
        };
        try {
          const res = await fetch(cfg.ingestUrl, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${cfg.ingestToken}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            builder.restore(candles);
            log(`envio recusado: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            break;
          }
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
  session.connect();

  const stop = () => {
    stopped = true;
    clearInterval(pushTimer);
    session.close("ponte desligada");
  };
  return { stop, session, builder, state, push };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  log(`Marombiew FIX bridge ${VERSION}`);
  const bridge = startBridge();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { bridge.stop(); setTimeout(() => process.exit(0), 1000); });
}
