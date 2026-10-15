// Sessão FIX QUOTE do cTrader: logon, heartbeat, lista de símbolos e assinatura de preços.
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { encode, splitMessages, parse, get, parseFixTime, printable } from "./fix.js";

/** "EUR/USD" -> "EURUSD" */
export const toBrokerName = (s) => s.replace("/", "").toUpperCase();

export class QuoteSession extends EventEmitter {
  /**
   * cfg: { host, port, tls, senderCompID, targetCompID, senderSubID, username, password,
   *        heartbeat, symbols: ["EUR/USD",...], symbolIds: { "EUR/USD": "1" }, priceSide, log }
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
    this.seq = 1;
    this.buf = "";
    this.socket = null;
    this.loggedOn = false;
    this.ids = new Map(); // id -> app symbol
    this.quotes = new Map(); // app symbol -> { bid, ask }
    this.lastSent = 0;
    this.lastRecv = 0;
    this.timer = null;
    this.reqId = 1;
  }

  header() {
    const c = this.cfg;
    return { senderCompID: c.senderCompID, targetCompID: c.targetCompID, senderSubID: c.senderSubID, targetSubID: c.senderSubID };
  }

  send(type, fields) {
    if (!this.socket || this.socket.destroyed) return;
    const msg = encode(type, this.seq++, this.header(), fields);
    if (this.cfg.debug) this.log(`>> ${printable(msg)}`);
    this.socket.write(msg, "latin1");
    this.lastSent = Date.now();
  }

  connect() {
    const { host, port } = this.cfg;
    this.seq = 1;
    this.buf = "";
    this.loggedOn = false;
    const opts = { host, port, servername: host };
    this.socket = this.cfg.tls === false ? net.connect(opts) : tls.connect(opts);
    this.socket.setEncoding("latin1");
    this.socket.setKeepAlive(true, 15000);
    this.socket.once(this.cfg.tls === false ? "connect" : "secureConnect", () => {
      this.log(`conectado em ${host}:${port}, enviando logon`);
      this.lastRecv = Date.now();
      this.send("A", [
        ["98", "0"],
        ["108", String(this.cfg.heartbeat)],
        ["141", "Y"],
        ["553", this.cfg.username],
        ["554", this.cfg.password],
      ]);
    });
    this.socket.on("data", (d) => this.#onData(d));
    this.socket.on("error", (e) => this.log(`erro de socket: ${e.message}`));
    this.socket.on("close", () => {
      clearInterval(this.timer);
      const was = this.loggedOn;
      this.loggedOn = false;
      this.emit("down", was ? "conexão encerrada" : "conexão recusada ou logon falhou");
    });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.#keepAlive(), 1000);
  }

  close(reason = "encerrando") {
    if (this.loggedOn) this.send("5", [["58", reason]]);
    clearInterval(this.timer);
    setTimeout(() => this.socket?.destroy(), 300);
  }

  #keepAlive() {
    const hb = this.cfg.heartbeat * 1000;
    const now = Date.now();
    if (this.loggedOn && now - this.lastSent >= hb) this.send("0", []);
    // sem nada recebido por 2,5 heartbeats: conexão morta
    if (now - this.lastRecv > hb * 2.5) {
      this.log("sem resposta do servidor, reconectando");
      this.socket?.destroy();
    }
  }

  #onData(chunk) {
    this.lastRecv = Date.now();
    const { messages, rest } = splitMessages(this.buf + chunk);
    this.buf = rest;
    for (const m of messages) {
      if (this.cfg.debug) this.log(`<< ${printable(m)}`);
      try {
        this.#handle(parse(m));
      } catch (e) {
        this.log(`falha ao tratar mensagem: ${e.message}`);
      }
    }
  }

  #handle(f) {
    const type = get(f, "35");
    switch (type) {
      case "A":
        this.loggedOn = true;
        this.log("logon aceito");
        this.emit("up");
        this.#requestSymbols();
        break;
      case "0":
        break;
      case "1":
        this.send("0", [["112", get(f, "112") ?? ""]]);
        break;
      case "5":
        this.log(`logout do servidor: ${get(f, "58") ?? "sem motivo"}`);
        this.emit("rejected", get(f, "58") ?? "logout");
        this.socket?.destroy();
        break;
      case "3":
      case "j":
        this.log(`rejeição (${type}): ${get(f, "58") ?? ""} (tag ${get(f, "371") ?? "?"})`);
        break;
      case "y":
        this.#onSecurityList(f);
        break;
      case "W":
        this.#onSnapshot(f);
        break;
      case "X":
        this.#onIncremental(f);
        break;
      case "Y":
        this.log(`assinatura recusada: ${get(f, "58") ?? ""}`);
        break;
      default:
        break;
    }
  }

  #requestSymbols() {
    const fixed = this.cfg.symbolIds ?? {};
    if (this.cfg.symbols.every((s) => fixed[s])) {
      for (const s of this.cfg.symbols) this.ids.set(String(fixed[s]), s);
      this.#subscribe();
      return;
    }
    this.send("x", [["320", `sl-${this.reqId++}`], ["559", "0"]]);
  }

  #onSecurityList(f) {
    const wanted = new Map(this.cfg.symbols.map((s) => [toBrokerName(s), s]));
    let id = null;
    for (const [t, v] of f) {
      if (t === "55") id = v;
      if (t === "1007" && id && wanted.has(v.toUpperCase())) this.ids.set(id, wanted.get(v.toUpperCase()));
    }
    for (const [s, idv] of Object.entries(this.cfg.symbolIds ?? {})) this.ids.set(String(idv), s);
    const found = new Set(this.ids.values());
    const missing = this.cfg.symbols.filter((s) => !found.has(s));
    if (missing.length) this.log(`símbolos não encontrados na corretora: ${missing.join(", ")} (defina SYMBOL_IDS)`);
    this.#subscribe();
  }

  #subscribe() {
    for (const [id, sym] of this.ids) {
      this.send("V", [
        ["262", `md-${sym}`],
        ["263", "1"],
        ["264", "1"],
        ["265", "1"],
        ["267", "2"],
        ["269", "0"],
        ["269", "1"],
        ["146", "1"],
        ["55", id],
      ]);
    }
    this.emit("subscribed", [...this.ids.values()]);
    this.log(`assinado: ${[...this.ids.values()].join(", ")}`);
  }

  #emitTick(sym, f) {
    const q = this.quotes.get(sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return;
    const side = this.cfg.priceSide ?? "bid";
    const price = side === "mid" ? (q.bid + q.ask) / 2 : side === "ask" ? q.ask : q.bid;
    const ts = parseFixTime(get(f, "52")) ?? Date.now();
    this.emit("tick", sym, price, ts);
  }

  #onSnapshot(f) {
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
    this.#emitTick(sym, f);
  }

  #onIncremental(f) {
    // grupos: 279 (ação), 269 (lado), 55 (símbolo), 270 (preço)
    let sym = null, side = null, action = null;
    const touched = new Set();
    const apply = () => {
      if (!sym || side == null) return;
      const q = this.quotes.get(sym) ?? { bid: 0, ask: 0 };
      this.quotes.set(sym, q);
      touched.add(sym);
    };
    for (const [t, v] of f) {
      if (t === "279") { action = v; side = null; }
      if (t === "269") side = v;
      if (t === "55") { sym = this.ids.get(v) ?? null; apply(); }
      if (t === "270" && sym && action !== "2") {
        const q = this.quotes.get(sym) ?? { bid: 0, ask: 0 };
        if (side === "0") q.bid = Number(v);
        if (side === "1") q.ask = Number(v);
        this.quotes.set(sym, q);
        touched.add(sym);
      }
    }
    for (const s of touched) this.#emitTick(s, f);
  }
}
