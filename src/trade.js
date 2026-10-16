// Sessão FIX TRADE do cTrader: ordens a mercado com stop e alvo, fechamento e posições.
// Toda ordem de entrada recebe stop e alvo vinculados à posição (tag 721) logo após executar.
// Se o stop não puder ser colocado, a posição é fechada na hora: nunca fica posição sem stop.
import { FixSession } from "./base.js";
import { get, fixTime } from "./fix.js";
import { readSecurityList } from "./session.js";

export const DEFAULT_LOT_SIZES = { "XAU/USD": 100 };
export const DEFAULT_STEPS = { "XAU/USD": 1 };
const DEFAULT_DIGITS = (s) => (s.includes("JPY") ? 3 : s.startsWith("XAU") ? 2 : 5);

const SIDE = { buy: "1", sell: "2" };
export const pipSize = (s) => (s.includes("JPY") ? 0.01 : s.startsWith("XAU") ? 0.1 : 0.0001);

/** Lê e limita a gestão pedida pelo app. null = sem gestão (stop fixo). */
export function parseManage(m) {
  if (!m || m.enabled === false) return null;
  const n = (v, d, lo, hi) => { const x = Number(v ?? d); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    beR: n(m.be_r, 0.8, 0.3, 3),            // lucro (em R) que leva o stop para a entrada
    lockPips: n(m.lock_pips, 1, 0, 20),      // pips garantidos ao mover para a entrada
    trailStartR: n(m.trail_start_r, 1, 0.3, 5), // lucro (em R) que liga o stop móvel
    trailR: n(m.trail_r, 0.5, 0.2, 3),       // quanto do pico o stop móvel deixa devolver (em R)
  };
}
const OPPOSITE = { buy: "sell", sell: "buy" };

export class TradeSession extends FixSession {
  /**
   * cfg extra: symbols, symbolIds, lotSizes, steps, maxLots, maxPositions, maxCommandAgeMs,
   *            getQuote(sym) -> { bid, ask } | undefined
   */
  constructor(cfg) {
    super({ ...cfg, senderSubID: "TRADE" });
    this.ids = new Map(); // id -> símbolo
    this.symIds = new Map(); // símbolo -> id
    this.digits = new Map();
    this.orders = new Map(); // clOrdID -> { kind: entry|sl|tp|close, cmdId, sym, side, units, posId, price }
    this.protect = new Map(); // posId -> { sl, tp, stop, target, cmdId }
    this.positions = new Map(); // posId -> { position_id, symbol, side, units, entry_price }
    this.posBatch = null;
    this.posTimer = null;
    this.ready = false;
    this.seqToOrder = new Map(); // MsgSeqNum -> ClOrdID (para rejeições 35=3)
    this.closedPositions = new Set(); // posições que a ponte viu fechar
    this.alerted = new Set(); // posições sem stop já avisadas
  }

  /** Envia mensagem de ordem guardando o número de sequência, para casar rejeições de sessão. */
  sendOrder(clOrd, type, fields) {
    this.seqToOrder.set(String(this.seq), clOrd);
    if (this.seqToOrder.size > 500) this.seqToOrder.delete(this.seqToOrder.keys().next().value);
    return this.send(type, fields);
  }

  lotSize(sym) { return { ...DEFAULT_LOT_SIZES, ...(this.cfg.lotSizes ?? {}) }[sym] ?? 100000; }
  step(sym) { return { ...DEFAULT_STEPS, ...(this.cfg.steps ?? {}) }[sym] ?? 1000; }
  fmt(sym, price) { return Number(price).toFixed(this.digits.get(sym) ?? DEFAULT_DIGITS(sym)); }
  toUnits(sym, lots) {
    const st = this.step(sym);
    return Math.round((lots * this.lotSize(sym)) / st) * st;
  }
  toLots(sym, units) { return +(units / this.lotSize(sym)).toFixed(4); }

  onLogon() {
    this.ready = false;
    this.send("x", [["320", this.nextId("sl")], ["559", "0"]]);
    clearInterval(this.posTimer);
    this.posTimer = setInterval(() => this.requestPositions(), 15000);
  }

  close(reason) {
    clearInterval(this.posTimer);
    super.close(reason);
  }

  /** Rejeição de sessão (35=3) ou de negócio (35=j) para uma ordem: trata como execução recusada. */
  onReject(f) {
    const clOrd = get(f, "379") ?? this.seqToOrder.get(get(f, "45") ?? "");
    if (!clOrd || !this.orders.has(clOrd)) return;
    const reason = `${get(f, "58") ?? "recusada"}${get(f, "371") ? ` (tag ${get(f, "371")})` : ""}`;
    this.onExecution([["35", "8"], ["11", clOrd], ["150", "8"], ["39", "8"], ["58", reason]]);
  }

  onMessage(type, f) {
    if (type === "y") return this.onSecurityList(f);
    if (type === "8") return this.onExecution(f);
    if (type === "AP") return this.onPositionReport(f);
    if (type === "9") return this.onCancelReject(f);
  }

  onSecurityList(f) {
    const { ids, digits } = readSecurityList(f, this.cfg.symbols, this.cfg.symbolIds);
    this.ids = ids;
    this.symIds = new Map([...ids].map(([id, s]) => [s, id]));
    this.digits = digits;
    this.ready = true;
    this.log(`pronta para ordens: ${[...this.symIds.keys()].join(", ")}`);
    this.requestPositions();
    // recupera stop/alvo das posições abertas (ponte reiniciada não perde a gestão)
    this.send("AF", [["584", this.nextId("M")], ["585", "7"]]);
  }

  // ---------- comandos vindos do app ----------

  /** Valida e executa um comando do app. Retorna evento de recusa ou null. */
  execute(cmd, now = Date.now()) {
    const reject = (reason) => ({ command_id: cmd.id, type: "rejected", symbol: cmd.symbol, side: cmd.side, reason, at: new Date(now).toISOString() });
    if (!this.loggedOn || !this.ready) return reject("sessão TRADE desconectada");
    const age = now - Date.parse(cmd.created_at);
    if (!(age <= (this.cfg.maxCommandAgeMs ?? 30000))) return reject("comando expirado (mais de 30 s)");

    if (cmd.action === "close_all") {
      if (this.positions.size === 0) return reject("nenhuma posição aberta");
      for (const p of this.positions.values()) this.closePosition(p, cmd.id);
      return null;
    }
    if (cmd.action === "close") {
      const p = this.positions.get(String(cmd.position_id));
      if (!p) return reject("posição não encontrada");
      this.closePosition(p, cmd.id);
      return null;
    }
    if (cmd.action === "manage") {
      const posId = String(cmd.position_id);
      const pr = this.protect.get(posId);
      const p = this.positions.get(posId);
      if (!p || !pr || !pr.sl) return reject("stop da posição não encontrado na ponte");
      pr.entry = pr.entry ?? p.entry_price;
      const init = Number(cmd.initial_stop);
      if (init > 0 && pr.entry) pr.risk = Math.abs(pr.entry - init);
      if (!(pr.risk > 0)) return reject("risco inicial desconhecido (informe initial_stop)");
      pr.manage = parseManage(cmd.manage);
      pr.cmdId = cmd.id;
      this.event("manage_set", { cmdId: cmd.id, sym: p.symbol, side: p.side, units: p.units, posId },
        { reason: pr.manage ? "gestão ligada" : "gestão desligada" });
      return null;
    }
    if (cmd.action !== "open") return reject(`ação desconhecida: ${cmd.action}`);

    const sym = cmd.symbol;
    const id = this.symIds.get(sym);
    if (!id) return reject(`par ${sym} indisponível na sessão TRADE`);
    if (!SIDE[cmd.side]) return reject("lado inválido");
    const lots = Number(cmd.lots);
    if (!(lots > 0)) return reject("lotes inválidos");
    if (lots > (this.cfg.maxLots ?? 0.1) + 1e-9) return reject(`lotes acima do limite da ponte (${this.cfg.maxLots ?? 0.1})`);
    if (this.positions.size >= (this.cfg.maxPositions ?? 3)) return reject("limite de posições abertas da ponte atingido");
    const units = this.toUnits(sym, lots);
    if (!(units > 0)) return reject("volume abaixo do mínimo");

    const stop = Number(cmd.stop), target = Number(cmd.target);
    if (!(stop > 0) || !(target > 0)) return reject("stop e alvo são obrigatórios");
    const q = this.cfg.getQuote?.(sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return reject("sem preço ao vivo do par");
    if (cmd.side === "buy" && !(stop < q.bid && target > q.ask)) return reject(`compra exige stop < ${q.bid} e alvo > ${q.ask}`);
    if (cmd.side === "sell" && !(stop > q.ask && target < q.bid)) return reject(`venda exige stop > ${q.ask} e alvo < ${q.bid}`);

    const clOrd = this.nextId("E");
    const entry = { kind: "entry", cmdId: cmd.id, sym, side: cmd.side, units, stop, target, manage: parseManage(cmd.manage) };
    this.orders.set(clOrd, entry);
    // sem resposta em 20 s: avisa (não marca como encerrada; se executar depois, o stop ainda é colocado)
    setTimeout(() => {
      if (entry.done || entry.warned) return;
      entry.warned = true;
      this.event("rejected", entry, { reason: "sem resposta da corretora em 20 s — confira no cTrader" });
      this.requestPositions();
    }, this.cfg.orderTimeoutMs ?? 20000).unref?.();
    this.sendOrder(clOrd, "D", [
      ["11", clOrd], ["55", id], ["54", SIDE[cmd.side]], ["60", fixTime().slice(0, 17)],
      ["38", String(units)], ["40", "1"], ["494", "MBFX"],
    ]);
    this.log(`ordem enviada: ${cmd.side} ${sym} ${units} unidades (stop ${stop}, alvo ${target})`);
    return null;
  }

  closePosition(p, cmdId, reason = "manual") {
    const pr = this.protect.get(p.position_id);
    if (pr) { this.cancel(pr.sl); this.cancel(pr.tp); }
    this.closedPositions.add(String(p.position_id));
    const clOrd = this.nextId("C");
    this.orders.set(clOrd, { kind: "close", cmdId, sym: p.symbol, side: OPPOSITE[p.side], units: p.units, posId: p.position_id, reason });
    this.sendOrder(clOrd, "D", [
      ["11", clOrd], ["55", this.symIds.get(p.symbol)], ["54", SIDE[OPPOSITE[p.side]]], ["60", fixTime().slice(0, 17)],
      ["38", String(p.units)], ["40", "1"], ["721", p.position_id], ["494", "MBFX"],
    ]);
  }

  placeProtection(posId, o) {
    const opp = OPPOSITE[o.side];
    const sl = this.nextId("S"), tp = this.nextId("T");
    this.protect.set(posId, {
      sl, tp, stop: o.stop, target: o.target, cmdId: o.cmdId, slOk: false, tpOk: false,
      sym: o.sym, side: o.side, units: o.units, entry: o.fillPrice ?? null,
      risk: o.fillPrice ? Math.abs(o.fillPrice - o.stop) : null, manage: o.manage ?? null,
      peak: 0, stage: "inicial", pending: false, lastMove: 0,
    });
    this.orders.set(sl, { kind: "sl", cmdId: o.cmdId, sym: o.sym, side: opp, units: o.units, posId });
    this.orders.set(tp, { kind: "tp", cmdId: o.cmdId, sym: o.sym, side: opp, units: o.units, posId });
    const id = this.symIds.get(o.sym);
    const base = [["55", id], ["54", SIDE[opp]], ["60", fixTime().slice(0, 17)], ["38", String(o.units)]];
    this.sendOrder(sl, "D", [["11", sl], ...base, ["40", "3"], ["99", this.fmt(o.sym, o.stop)], ["721", posId], ["494", "MBFX-SL"]]);
    this.sendOrder(tp, "D", [["11", tp], ...base, ["40", "2"], ["44", this.fmt(o.sym, o.target)], ["721", posId], ["494", "MBFX-TP"]]);
  }

  /** Cancela uma ordem pendente. Formato do cliente oficial da Spotware: 41 + 37 + 11. */
  cancel(clOrd) {
    const o = this.orders.get(clOrd);
    if (!o || o.done || o.cancelling) return;
    o.cancelling = true;
    const fields = [["41", clOrd]];
    if (o.orderId) fields.push(["37", o.orderId]);
    fields.push(["11", this.nextId("X")]);
    this.send("F", fields);
    this.log(`cancelando ${o.kind} ${clOrd} (${o.sym}, posição ${o.posId})`);
    // confirmação no próximo inventário de ordens; se falhar, a varredura tenta de novo
    setTimeout(() => { o.cancelling = false; }, 10000).unref?.();
  }

  /** Pede à corretora todas as ordens pendentes (resposta: 35=8 com 150=I). */
  requestOrders() {
    if (!this.loggedOn || !this.ready) return;
    this.send("AF", [["584", this.nextId("M")], ["585", "7"]]);
  }

  // ---------- respostas da corretora ----------

  event(type, o, extra = {}) {
    this.emit("event", {
      command_id: o.cmdId ?? null, type, position_id: o.posId ?? null, symbol: o.sym, side: o.side,
      units: o.units, lots: this.toLots(o.sym, o.units), price: null, reason: null, at: new Date().toISOString(), ...extra,
    });
  }

  onExecution(f) {
    const clOrd = get(f, "11");
    const o = this.orders.get(clOrd ?? "");
    if (!o) return this.recoverOrder(f);
    if (get(f, "37")) o.orderId = get(f, "37");
    if (get(f, "150") === "I") return this.checkOrphan(clOrd, o, get(f, "39"));
    const exec = get(f, "150");
    const status = get(f, "39");
    const reason = get(f, "58") ?? null;
    const price = Number(get(f, "6") ?? get(f, "31") ?? NaN);
    const posId = get(f, "721") ?? o.posId ?? null;
    const filled = status === "2" || exec === "F";
    const rejected = exec === "8" || status === "8";
    const gone = exec === "4" || exec === "C" || status === "4" || status === "C";

    if (o.kind === "entry") {
      if (rejected) { o.done = true; return this.event("rejected", o, { reason: reason ?? "recusada pela corretora" }); }
      if (filled && !o.done) {
        o.done = true;
        o.posId = posId;
        o.fillPrice = price;
        this.positions.set(String(posId), { position_id: String(posId), symbol: o.sym, side: o.side, units: o.units, entry_price: price, stop: o.stop, target: o.target });
        this.event("filled", o, { price });
        if (!posId) {
          this.event("protection_failed", o, { reason: "corretora não informou o ID da posição; feche manualmente" });
          return;
        }
        this.placeProtection(String(posId), o);
      }
      return;
    }

    if (o.kind === "sl" || o.kind === "tp") {
      const pr = this.protect.get(o.posId);
      if (rejected) {
        o.done = true;
        this.event("protection_failed", o, { reason: `${o.kind === "sl" ? "stop" : "alvo"} recusado: ${reason ?? ""}`.trim() });
        // posição sem proteção não fica aberta
        const p = this.positions.get(o.posId);
        if (p && o.kind === "sl") { this.log(`stop recusado, fechando posição ${o.posId}`); this.closePosition(p, o.cmdId); }
        return;
      }
      if (exec === "5" && pr && o.replacing) {
        o.replacing = false;
        const old = this.orders.get(o.origClOrd);
        if (old) old.done = true;
        pr.sl = clOrd;
        pr.stop = o.newStop;
        pr.pending = false;
        const p = this.positions.get(o.posId);
        if (p) p.stop = o.newStop;
        this.log(`stop movido para ${this.fmt(o.sym, o.newStop)} (${o.stage})`);
        this.event("stop_moved", o, { price: o.newStop, reason: o.stage });
        return;
      }
      if (exec === "0" && pr && !filled) {
        if (o.kind === "sl") pr.slOk = true; else pr.tpOk = true;
        if (pr.slOk && pr.tpOk && !pr.reported) { pr.reported = true; this.event("protection_set", o, { price: null }); }
        return;
      }
      if (filled && (this.closedPositions.has(String(o.posId)) || !pr)) {
        o.done = true;
        this.log(`ORDEM ÓRFÃ executada (${o.kind} ${o.sym}, posição ${o.posId}): fechando a posição reaberta`);
        this.event("protection_failed", o, { price, reason: "ordem órfã executada; posição reaberta fechada automaticamente" });
        const reopened = { position_id: String(o.posId), symbol: o.sym, side: o.side, units: o.units, entry_price: price };
        this.closedPositions.delete(String(o.posId));
        this.closePosition(reopened, o.cmdId, "ordem órfã");
        return;
      }
      if (filled) {
        o.done = true;
        this.closedPositions.add(String(o.posId));
        if (pr) this.cancel(o.kind === "sl" ? pr.tp : pr.sl);
        this.positions.delete(o.posId);
        this.protect.delete(o.posId);
        this.event("closed", o, { price, reason: o.kind === "sl" ? "stop" : "alvo" });
        return;
      }
      if (gone) o.done = true;
      return;
    }

    if (o.kind === "close") {
      if (rejected) { o.done = true; return this.event("rejected", o, { reason: reason ?? "fechamento recusado" }); }
      if (filled && !o.done) {
        o.done = true;
        const pr = this.protect.get(o.posId);
        if (pr) { this.cancel(pr.sl); this.cancel(pr.tp); }
        this.positions.delete(o.posId);
        this.protect.delete(o.posId);
        this.event("closed", o, { price, reason: o.reason ?? "manual" });
      }
    }
  }

  /** Ordem de stop/alvo existente na corretora (resposta ao AF): volta a ser acompanhada. */
  recoverOrder(f) {
    const exec = get(f, "150");
    const posId = get(f, "721");
    const sym = this.ids.get(get(f, "55") ?? "");
    const cl = get(f, "11");
    const type = get(f, "40");
    if (exec !== "I" || !posId || !sym || !cl || (type !== "3" && type !== "2")) return;
    const ordSide = get(f, "54") === "1" ? "buy" : "sell";
    const units = Number(get(f, "38") ?? 0);
    const kind = type === "3" ? "sl" : "tp";
    const rec = { kind, cmdId: null, sym, side: ordSide, units, posId, orderId: get(f, "37") ?? null };
    this.orders.set(cl, rec);
    if (this.checkOrphan(cl, rec, get(f, "39"))) return;
    const pr = this.protect.get(posId) ?? {
      sl: null, tp: null, stop: null, target: null, cmdId: null, slOk: true, tpOk: true, reported: true,
      sym, side: OPPOSITE[ordSide], units, entry: this.positions.get(posId)?.entry_price ?? null, risk: null, manage: null,
      peak: 0, stage: "inicial", pending: false, lastMove: 0,
    };
    if (kind === "sl") { pr.sl = cl; pr.stop = Number(get(f, "99")); }
    else { pr.tp = cl; pr.target = Number(get(f, "44")); }
    this.protect.set(posId, pr);
    const p = this.positions.get(posId);
    if (p) { p.stop = pr.stop ?? p.stop; p.target = pr.target ?? p.target; }
    this.log(`recuperado ${kind === "sl" ? "stop" : "alvo"} da posição ${posId} (${sym})`);
  }

  /**
   * Ordem pendente que não protege nenhuma posição aberta (posição fechada, ou mesmo lado da posição)
   * é órfã: cancela. Retorna true se for órfã.
   */
  checkOrphan(cl, o, ordStatus) {
    if (ordStatus === "2" || ordStatus === "4" || ordStatus === "8" || ordStatus === "C") { o.done = true; return false; }
    if (o.kind !== "sl" && o.kind !== "tp") return false;
    if (!this.positionsFresh) return false; // só decide com o inventário de posições atualizado
    const p = this.positions.get(String(o.posId));
    const orphan = !p || p.side === o.side;
    if (!orphan) return false;
    this.log(`ordem órfã encontrada (${o.kind} ${o.sym}, posição ${o.posId}): cancelando`);
    this.event("orphan_cancelled", o, { reason: `${o.kind === "sl" ? "stop" : "alvo"} órfão cancelado` });
    this.cancel(cl);
    const pr = this.protect.get(String(o.posId));
    if (pr && (pr.sl === cl || pr.tp === cl)) this.protect.delete(String(o.posId));
    return true;
  }

  onCancelReject(f) {
    const o = this.orders.get(get(f, "11") ?? "");
    this.log(`alteração/cancelamento recusado: ${get(f, "58") ?? ""}`);
    if (!o?.replacing) return;
    o.replacing = false;
    o.done = true;
    const pr = this.protect.get(o.posId);
    if (pr) { pr.pending = false; pr.lastMove = Date.now(); }
  }

  // ---------- gestão do lucro (stop na entrada + stop móvel) ----------

  /**
   * Chamado a cada tick. Só mexe no stop a favor da posição; nunca afasta o stop.
   * Se o novo stop já estiver do lado errado do preço (o lucro voltou rápido), fecha a mercado.
   */
  onQuote(sym, q, now = Date.now()) {
    if (!this.loggedOn || !this.ready || !q || !(q.bid > 0) || !(q.ask > 0)) return;
    for (const [posId, pr] of this.protect) {
      if (pr.sym !== sym || !pr.manage || !pr.slOk || pr.pending || !pr.entry || !(pr.risk > 0)) continue;
      const sign = pr.side === "buy" ? 1 : -1;
      const exit = pr.side === "buy" ? q.bid : q.ask; // preço pelo qual a posição fecharia agora
      const profit = (exit - pr.entry) * sign;
      pr.peak = Math.max(pr.peak, profit);
      const m = pr.manage, pip = pipSize(sym);
      let want = null, stage = null;
      if (pr.peak >= m.beR * pr.risk) { want = pr.entry + sign * m.lockPips * pip; stage = "stop na entrada"; }
      if (pr.peak >= m.trailStartR * pr.risk) {
        const trail = pr.entry + sign * (pr.peak - m.trailR * pr.risk);
        if (want === null || (trail - want) * sign > 0) { want = trail; stage = "stop móvel"; }
      }
      if (want === null) continue;
      // só melhora o stop, e só quando a melhora vale a pena (≥ 1 pip) — evita mexer a cada tick
      if ((want - pr.stop) * sign < pip) continue;
      const p = this.positions.get(posId);
      if (!p) continue;
      // lucro já voltou além do novo stop: fecha agora a mercado
      if ((exit - want) * sign <= 0) {
        pr.pending = true;
        this.log(`lucro devolvido em ${sym}, fechando a mercado (${stage})`);
        this.closePosition(p, pr.cmdId, stage);
        continue;
      }
      if (now - pr.lastMove < (this.cfg.minMoveIntervalMs ?? 2000)) continue;
      this.moveStop(posId, pr, Number(this.fmt(sym, want)), stage);
    }
  }

  moveStop(posId, pr, newStop, stage) {
    const orig = pr.sl;
    const old = this.orders.get(orig);
    if (!old || old.done) return;
    const cl = this.nextId("S");
    this.orders.set(cl, { ...old, done: false, replacing: true, origClOrd: orig, newStop, stage });
    pr.pending = true;
    pr.lastMove = Date.now();
    this.sendOrder(cl, "G", [["41", orig], ["11", cl], ["38", String(pr.units)], ["99", this.fmt(pr.sym, newStop)]]);
  }

  requestPositions() {
    if (!this.loggedOn || !this.ready) return;
    const reqId = this.nextId("P");
    this.posBatch = { reqId, total: null, items: [] };
    this.send("AN", [["710", reqId]]);
  }

  onPositionReport(f) {
    const b = this.posBatch;
    if (!b || get(f, "710") !== b.reqId) return;
    const total = Number(get(f, "727") ?? 0);
    const result = get(f, "728");
    b.total = total;
    const posId = get(f, "721");
    const sym = this.ids.get(get(f, "55") ?? "");
    if (result && result !== "0") b.total = 0; // sem posições
    else if (posId && sym) {
      const long = Number(get(f, "704") ?? 0), short = Number(get(f, "705") ?? 0);
      const side = long > 0 ? "buy" : "sell";
      const pr = this.protect.get(posId);
      b.items.push({
        position_id: posId, symbol: sym, side, units: long > 0 ? long : short,
        entry_price: Number(get(f, "730") ?? NaN), stop: pr?.stop ?? null, target: pr?.target ?? null,
      });
    }
    if (b.items.length >= b.total) {
      this.positions = new Map(b.items.map((p) => [p.position_id, p]));
      for (const p of this.positions.values()) {
        const pr = this.protect.get(p.position_id);
        if (pr && !pr.entry && p.entry_price > 0) pr.entry = p.entry_price;
        if (pr && pr.side !== p.side) this.protect.delete(p.position_id); // proteção de outra "vida" da posição
      }
      if (this.closedPositions.size > 1000) this.closedPositions = new Set([...this.closedPositions].slice(-500));
      this.positionsFresh = true;
      this.requestOrders(); // varre ordens órfãs a cada inventário
      // posição aberta sem stop conhecido: avisa uma vez (depois do inventário de ordens chegar)
      setTimeout(() => {
        for (const p of this.positions.values()) {
          const pr = this.protect.get(p.position_id);
          if (pr?.sl || this.alerted.has(p.position_id)) continue;
          this.alerted.add(p.position_id);
          this.event("protection_failed", { cmdId: null, sym: p.symbol, side: p.side, units: p.units, posId: p.position_id },
            { reason: "posição sem stop na corretora" });
        }
      }, 5000).unref?.();
      this.posBatch = null;
      this.emit("positions", [...this.positions.values()].map((p) => ({ ...p, lots: this.toLots(p.symbol, p.units) })));
    }
  }
}
