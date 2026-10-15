// Sessão FIX genérica do cTrader: conexão, logon, heartbeat e reconexão ficam aqui.
// QuoteSession (preços) e TradeSession (ordens) só tratam as mensagens de negócio.
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { encode, splitMessages, parse, get, printable } from "./fix.js";

export class FixSession extends EventEmitter {
  /** cfg: { host, port, tls, senderCompID, targetCompID, senderSubID, username, password, heartbeat, debug, log } */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = (m) => (cfg.log ?? (() => {}))(`[${cfg.senderSubID}] ${m}`);
    this.seq = 1;
    this.buf = "";
    this.socket = null;
    this.loggedOn = false;
    this.lastSent = 0;
    this.lastRecv = 0;
    this.timer = null;
    this.reqId = 1;
  }

  nextId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${this.reqId++}`;
  }

  header() {
    const c = this.cfg;
    return { senderCompID: c.senderCompID, targetCompID: c.targetCompID, senderSubID: c.senderSubID, targetSubID: c.senderSubID };
  }

  /** Envia; retorna false se não há conexão. */
  send(type, fields) {
    if (!this.socket || this.socket.destroyed) return false;
    const msg = encode(type, this.seq++, this.header(), fields);
    if (this.cfg.debug) this.log(`>> ${printable(msg)}`);
    this.socket.write(msg, "latin1");
    this.lastSent = Date.now();
    return true;
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
    this.socket.on("data", (d) => this.onData(d));
    this.socket.on("error", (e) => this.log(`erro de socket: ${e.message}`));
    this.socket.on("close", () => {
      clearInterval(this.timer);
      const was = this.loggedOn;
      this.loggedOn = false;
      this.emit("down", was ? "conexão encerrada" : "conexão recusada ou logon falhou");
    });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.keepAlive(), 1000);
  }

  close(reason = "encerrando") {
    if (this.loggedOn) this.send("5", [["58", reason]]);
    clearInterval(this.timer);
    setTimeout(() => this.socket?.destroy(), 300);
  }

  keepAlive() {
    const hb = this.cfg.heartbeat * 1000;
    const now = Date.now();
    if (this.loggedOn && now - this.lastSent >= hb) this.send("0", []);
    if (now - this.lastRecv > hb * 2.5) {
      this.log("sem resposta do servidor, reconectando");
      this.socket?.destroy();
    }
  }

  onData(chunk) {
    this.lastRecv = Date.now();
    const { messages, rest } = splitMessages(this.buf + chunk);
    this.buf = rest;
    for (const m of messages) {
      if (this.cfg.debug) this.log(`<< ${printable(m)}`);
      try {
        this.handle(parse(m));
      } catch (e) {
        this.log(`falha ao tratar mensagem: ${e.message}`);
      }
    }
  }

  handle(f) {
    const type = get(f, "35");
    switch (type) {
      case "A":
        this.loggedOn = true;
        this.log("logon aceito");
        this.emit("up");
        this.onLogon();
        return;
      case "0":
        return;
      case "1":
        this.send("0", [["112", get(f, "112") ?? ""]]);
        return;
      case "5":
        this.log(`logout do servidor: ${get(f, "58") ?? "sem motivo"}`);
        this.emit("rejected", get(f, "58") ?? "logout");
        this.socket?.destroy();
        return;
      case "3":
      case "j":
        this.log(`rejeição (${type}): ${get(f, "58") ?? ""} (tag ${get(f, "371") ?? "?"})`);
        this.onReject(f);
        return;
      default:
        this.onMessage(type, f);
    }
  }

  onLogon() {}
  onReject() {}
  onMessage() {}
}
