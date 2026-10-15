// Sessão FIX QUOTE do cTrader: lista de símbolos e assinatura de preços.
import { FixSession } from "./base.js";
import { get, parseFixTime } from "./fix.js";

/** "EUR/USD" -> "EURUSD" */
export const toBrokerName = (s) => s.replace("/", "").toUpperCase();

/** Lê a Security List (35=y): devolve Map id->símbolo do app e Map símbolo->casas decimais. */
export function readSecurityList(f, symbols, symbolIds = {}) {
  const wanted = new Map(symbols.map((s) => [toBrokerName(s), s]));
  const ids = new Map();
  const digits = new Map();
  let id = null;
  let sym = null;
  for (const [t, v] of f) {
    if (t === "55") { id = v; sym = null; }
    if (t === "1007" && id && wanted.has(v.toUpperCase())) { sym = wanted.get(v.toUpperCase()); ids.set(id, sym); }
    if (t === "1008" && sym) digits.set(sym, Number(v));
  }
  for (const [s, idv] of Object.entries(symbolIds)) ids.set(String(idv), s);
  return { ids, digits };
}

export class QuoteSession extends FixSession {
  constructor(cfg) {
    super({ ...cfg, senderSubID: "QUOTE" });
    this.ids = new Map(); // id -> símbolo do app
    this.digits = new Map();
    this.quotes = new Map(); // símbolo -> { bid, ask }
  }

  onLogon() {
    const fixed = this.cfg.symbolIds ?? {};
    if (this.cfg.symbols.every((s) => fixed[s])) {
      for (const s of this.cfg.symbols) this.ids.set(String(fixed[s]), s);
      this.subscribe();
      return;
    }
    this.send("x", [["320", this.nextId("sl")], ["559", "0"]]);
  }

  onMessage(type, f) {
    if (type === "y") return this.onSecurityList(f);
    if (type === "W") return this.onSnapshot(f);
    if (type === "X") return this.onIncremental(f);
    if (type === "Y") this.log(`assinatura recusada: ${get(f, "58") ?? ""}`);
  }

  onSecurityList(f) {
    const { ids, digits } = readSecurityList(f, this.cfg.symbols, this.cfg.symbolIds);
    this.ids = ids;
    this.digits = digits;
    this.emit("symbols", { ids, digits });
    const found = new Set(ids.values());
    const missing = this.cfg.symbols.filter((s) => !found.has(s));
    if (missing.length) this.log(`símbolos não encontrados na corretora: ${missing.join(", ")} (defina SYMBOL_IDS)`);
    this.subscribe();
  }

  subscribe() {
    for (const [id, sym] of this.ids) {
      this.send("V", [
        ["262", `md-${sym}`], ["263", "1"], ["264", "1"], ["265", "1"],
        ["267", "2"], ["269", "0"], ["269", "1"], ["146", "1"], ["55", id],
      ]);
    }
    this.emit("subscribed", [...this.ids.values()]);
    this.log(`assinado: ${[...this.ids.values()].join(", ")}`);
  }

  emitTick(sym, f) {
    const q = this.quotes.get(sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return;
    const side = this.cfg.priceSide ?? "bid";
    const price = side === "mid" ? (q.bid + q.ask) / 2 : side === "ask" ? q.ask : q.bid;
    const ts = parseFixTime(get(f, "52")) ?? Date.now();
    this.emit("tick", sym, price, ts, q);
  }

  onSnapshot(f) {
    const sym = this.ids.get(get(f, "55") ?? "");
    if (!sym) return;
    const q = this.quotes.get(sym) ?? { bid: 0, ask: 0 };
    let side = null;
    for (const [t, v] of f) {
      if (t === "269") side = v;
      if (t === "270" && side === "0") q.bid = Number(v);
      if (t === "270" && side === "1") q.ask = Number(v);
    }
    this.quotes.set(sym, q);
    this.emitTick(sym, f);
  }

  onIncremental(f) {
    // grupos: 279 (ação), 269 (lado), 55 (símbolo), 270 (preço)
    let sym = null, side = null, action = null;
    const touched = new Set();
    for (const [t, v] of f) {
      if (t === "279") { action = v; side = null; }
      if (t === "269") side = v;
      if (t === "55") sym = this.ids.get(v) ?? null;
      if (t === "270" && sym && action !== "2") {
        const q = this.quotes.get(sym) ?? { bid: 0, ask: 0 };
        if (side === "0") q.bid = Number(v);
        if (side === "1") q.ask = Number(v);
        this.quotes.set(sym, q);
        touched.add(sym);
      }
    }
    for (const s of touched) this.emitTick(s, f);
  }
}
