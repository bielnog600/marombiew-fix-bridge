// Ordens pela cTrader Open API (mesma conexão do saldo, em openapi.js).
// Diferença para a FIX: stop e alvo são atributos da própria posição. Fechou a posição,
// eles somem juntos — não existe ordem órfã capaz de reabrir posição.
// Interface igual à TradeSession da FIX: execute(cmd), onQuote(sym, q), eventos "event" e "positions".
import { EventEmitter } from "node:events";
import { PT } from "./openapi.js";
import { parseManage, pipSize } from "./trade.js";
import { toBrokerName } from "./session.js";

const OPPOSITE = { buy: "sell", sell: "buy" };
const TRADE_SIDE = { buy: 1, sell: 2 };
const MARKET = 1;

// Enums chegam como número no JSON da Spotware; aceita o nome também, por garantia.
const EXEC = {
  2: "accepted", 3: "filled", 4: "replaced", 5: "cancelled", 6: "expired", 7: "rejected", 8: "cancel_rejected", 11: "partial",
  ORDER_ACCEPTED: "accepted", ORDER_FILLED: "filled", ORDER_REPLACED: "replaced", ORDER_CANCELLED: "cancelled",
  ORDER_EXPIRED: "expired", ORDER_REJECTED: "rejected", ORDER_CANCEL_REJECTED: "cancel_rejected", ORDER_PARTIAL_FILL: "partial",
};
const sideOf = (v) => (v === 1 || v === "BUY" ? "buy" : v === 2 || v === "SELL" ? "sell" : null);
const isClosed = (pos) => pos?.positionStatus === 2 || pos?.positionStatus === "POSITION_STATUS_CLOSED";
const num = (v) => (v == null || v === "" ? null : Number(v));
const pos0 = (v) => (Number(v) > 0 ? Number(v) : null);

/** Distância de preço → unidade da Open API (1/100000 do preço), respeitando as casas do símbolo. */
export function relative(dist, digits) {
  const d = Math.min(5, Math.max(0, digits ?? 5));
  return Math.round(Math.abs(dist) * 10 ** d) * 10 ** (5 - d);
}

export class OpenApiTrader extends EventEmitter {
  /**
   * cfg: { account (OpenApiAccount), symbols, maxLots, maxPositions, maxCommandAgeMs, orderTimeoutMs,
   *        protectCheckMs, minMoveIntervalMs, getQuote(sym) -> { bid, ask }, log }
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.acc = cfg.account;
    this.log = (m) => (cfg.log ?? (() => {}))(`[OPENAPI-TRADE] ${m}`);
    this.loggedOn = false;
    this.ready = false;
    this.scope = null;
    this.sym = new Map(); // símbolo do app -> { id, digits, lotSize, minVolume, stepVolume, maxVolume }
    this.byId = new Map(); // symbolId -> símbolo do app
    this.positions = new Map(); // posId -> { position_id, symbol, side, units, volume, entry_price, stop, target }
    this.manage = new Map(); // posId -> estado da gestão
    this.orders = new Map(); // clientOrderId -> pedido de entrada
    this.requests = new Map(); // clientMsgId -> { kind, ... } (para casar erros)
    this.closing = new Map(); // posId -> { cmdId, reason }
    this.alerted = new Set();
    this.lastPositionsKey = "";
    this.seq = 0;

    this.acc.on("authorized", ({ scope }) => {
      this.loggedOn = true;
      this.scope = scope;
      this.ready = false;
      this.acc.send(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: this.acc.accountId, includeArchivedSymbols: false });
    });
    this.acc.on("status", (s) => {
      if (s.connected) return;
      const was = this.loggedOn;
      this.loggedOn = false;
      this.ready = false;
      if (was) this.emit("down", s.message ?? "Open API desconectada");
    });
    this.acc.on("message", (m) => {
      try { this.handle(m); } catch (e) { this.log(`erro ao tratar ${m.payloadType}: ${e.message}`); }
    });
  }

  close() { this.loggedOn = false; this.ready = false; }

  // ---------- utilidades ----------

  info(sym) { return this.sym.get(sym); }
  fmt(sym, price) { return Number(Number(price).toFixed(this.info(sym)?.digits ?? 5)); }
  toLots(sym, volume) { const i = this.info(sym); return i ? +(volume / i.lotSize).toFixed(4) : null; }
  nextClOrd() { return `MBFX-${Date.now().toString(36)}-${(++this.seq).toString(36)}`; }
  canTrade() { return this.scope !== "view"; }

  send(type, payload, meta) {
    const id = this.acc.send(type, { ctidTraderAccountId: this.acc.accountId, ...payload });
    if (id && meta) {
      this.requests.set(id, meta);
      if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value);
    }
    return id;
  }

  event(type, o, extra = {}) {
    this.emit("event", {
      command_id: o.cmdId ?? null, type, position_id: o.posId != null ? String(o.posId) : null, symbol: o.sym ?? null,
      side: o.side ?? null, units: o.units ?? null, price: null, reason: null, at: new Date().toISOString(), ...extra,
    });
  }

  publishPositions(force = false) {
    const list = [...this.positions.values()].map((p) => ({
      position_id: p.position_id, symbol: p.symbol, side: p.side, units: p.units, entry_price: p.entry_price,
      stop: p.stop, target: p.target, lots: this.toLots(p.symbol, p.volume),
    }));
    const key = JSON.stringify(list);
    if (!force && key === this.lastPositionsKey) return;
    this.lastPositionsKey = key;
    this.emit("positions", list);
  }

  // ---------- comandos vindos do app ----------

  execute(cmd, now = Date.now()) {
    const reject = (reason) => ({ command_id: cmd.id, type: "rejected", symbol: cmd.symbol, side: cmd.side, reason, at: new Date(now).toISOString() });
    if (!this.loggedOn || !this.ready) return reject("Open API desconectada");
    if (!this.canTrade()) return reject("token da cTrader é só de leitura: reconecte a conta na aba Conta");
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
      const p = this.positions.get(posId);
      if (!p || !p.stop) return reject("posição ou stop não encontrados na corretora");
      const st = this.manage.get(posId) ?? this.newManage(p, null, null);
      const init = Number(cmd.initial_stop);
      if (init > 0) st.risk = Math.abs(st.entry - init);
      if (!(st.risk > 0)) return reject("risco inicial desconhecido (informe initial_stop)");
      st.manage = parseManage(cmd.manage);
      st.cmdId = cmd.id;
      this.manage.set(posId, st);
      this.event("manage_set", { cmdId: cmd.id, sym: p.symbol, side: p.side, units: p.units, posId },
        { reason: st.manage ? "gestão ligada" : "gestão desligada" });
      return null;
    }
    if (cmd.action !== "open") return reject(`ação desconhecida: ${cmd.action}`);

    const sym = cmd.symbol;
    const info = this.info(sym);
    if (!info) return reject(`par ${sym} indisponível na Open API`);
    if (!TRADE_SIDE[cmd.side]) return reject("lado inválido");
    const lots = Number(cmd.lots);
    if (!(lots > 0)) return reject("lotes inválidos");
    if (lots > (this.cfg.maxLots ?? 0.1) + 1e-9) return reject(`lotes acima do limite da ponte (${this.cfg.maxLots ?? 0.1})`);
    if (this.positions.size + this.pendingEntries() >= (this.cfg.maxPositions ?? 3)) return reject("limite de posições abertas da ponte atingido");
    const step = info.stepVolume || 1;
    const volume = Math.round((lots * info.lotSize) / step) * step;
    if (!(volume > 0) || (info.minVolume && volume < info.minVolume)) return reject("volume abaixo do mínimo do par");
    if (info.maxVolume && volume > info.maxVolume) return reject("volume acima do máximo do par");

    const stop = Number(cmd.stop), target = Number(cmd.target);
    if (!(stop > 0) || !(target > 0)) return reject("stop e alvo são obrigatórios");
    const q = this.cfg.getQuote?.(sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return reject("sem preço ao vivo do par");
    if (cmd.side === "buy" && !(stop < q.bid && target > q.ask)) return reject(`compra exige stop < ${q.bid} e alvo > ${q.ask}`);
    if (cmd.side === "sell" && !(stop > q.ask && target < q.bid)) return reject(`venda exige stop > ${q.ask} e alvo < ${q.bid}`);

    // stop e alvo relativos ao preço de execução: o risco planejado se mantém mesmo com deslize
    const ref = cmd.side === "buy" ? q.ask : q.bid;
    const relSL = relative(ref - stop, info.digits);
    const relTP = relative(target - ref, info.digits);
    if (!(relSL > 0) || !(relTP > 0)) return reject("stop ou alvo colados no preço");

    const clOrd = this.nextClOrd();
    const units = volume / 100;
    const o = { kind: "entry", sentAt: now, clOrd, cmdId: cmd.id, sym, side: cmd.side, volume, units, stop, target, relSL, relTP, manageRaw: cmd.manage ?? null, manage: parseManage(cmd.manage) };
    this.orders.set(clOrd, o);
    setTimeout(() => {
      if (o.done || o.warned) return;
      o.warned = true;
      this.event("rejected", o, { reason: "sem resposta da corretora em 20 s — confira no cTrader" });
    }, this.cfg.orderTimeoutMs ?? 20000).unref?.();
    // plano gravado na própria posição: ponte reiniciada recupera a gestão
    const comment = JSON.stringify({ s: stop, m: cmd.manage ?? null }).slice(0, 500);
    this.send(PT.NEW_ORDER_REQ, {
      symbolId: info.id, orderType: MARKET, tradeSide: TRADE_SIDE[cmd.side], volume,
      relativeStopLoss: relSL, relativeTakeProfit: relTP, clientOrderId: clOrd, label: "MBFX", comment,
    }, { kind: "entry", clOrd });
    this.log(`ordem enviada: ${cmd.side} ${sym} ${lots} lote (stop ${stop}, alvo ${target})`);
    return null;
  }

  pendingEntries() { let n = 0; for (const o of this.orders.values()) if (!o.done && !o.warned) n++; return n; }

  closePosition(p, cmdId, reason = "manual") {
    if (this.closing.has(p.position_id)) return;
    this.closing.set(p.position_id, { cmdId, reason });
    setTimeout(() => this.closing.delete(p.position_id), 30000).unref?.();
    this.send(PT.CLOSE_POSITION_REQ, { positionId: Number(p.position_id), volume: p.volume },
      { kind: "close", posId: p.position_id, cmdId, sym: p.symbol, side: OPPOSITE[p.side], units: p.units });
  }

  amend(p, stopLoss, takeProfit, meta) {
    const payload = { positionId: Number(p.position_id), stopLoss: this.fmt(p.symbol, stopLoss) };
    if (takeProfit > 0) payload.takeProfit = this.fmt(p.symbol, takeProfit);
    this.send(PT.AMEND_SLTP_REQ, payload, { kind: "amend", posId: p.position_id, ...meta });
  }

  // ---------- respostas ----------

  handle(m) {
    const p = m.payload ?? {};
    switch (m.payloadType) {
      case PT.SYMBOLS_LIST_RES: return this.onSymbols(p);
      case PT.SYMBOL_BY_ID_RES: return this.onSymbolDetails(p);
      case PT.EXECUTION_EVENT: return this.onExecution(p);
      case PT.RECONCILE_RES: return this.onReconcile(p);
      case PT.ORDER_ERROR_EVENT:
      case PT.ERROR_RES: return this.onError(m.clientMsgId, p);
      default:
    }
  }

  onSymbols(p) {
    const wanted = new Map(this.cfg.symbols.map((s) => [toBrokerName(s), s]));
    const ids = [];
    for (const s of p.symbol ?? []) {
      const app = wanted.get(String(s.symbolName ?? "").toUpperCase());
      if (!app) continue;
      this.byId.set(String(s.symbolId), app);
      ids.push(Number(s.symbolId));
    }
    const missing = this.cfg.symbols.filter((s) => ![...this.byId.values()].includes(s));
    if (missing.length) this.log(`pares não encontrados na Open API: ${missing.join(", ")}`);
    if (ids.length) this.send(PT.SYMBOL_BY_ID_REQ, { symbolId: ids });
  }

  onSymbolDetails(p) {
    for (const s of p.symbol ?? []) {
      const app = this.byId.get(String(s.symbolId));
      if (!app) continue;
      this.sym.set(app, {
        id: Number(s.symbolId), digits: num(s.digits) ?? 5, lotSize: num(s.lotSize) ?? (app.startsWith("XAU") ? 10000 : 10000000),
        minVolume: num(s.minVolume), stepVolume: num(s.stepVolume), maxVolume: num(s.maxVolume),
      });
    }
    if (!this.ready && this.sym.size) {
      this.ready = true;
      this.log(`pronta para ordens: ${[...this.sym.keys()].join(", ")} (permissão: ${this.scope})`);
      this.acc.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.acc.accountId });
      this.emit("up");
    }
  }

  /** Converte a posição da Open API para o formato do app. */
  readPosition(pos) {
    const td = pos.tradeData ?? {};
    const symbol = this.byId.get(String(td.symbolId));
    if (!symbol) return null;
    const volume = Number(td.volume ?? 0);
    return {
      position_id: String(pos.positionId), symbol, side: sideOf(td.tradeSide), units: volume / 100, volume,
      entry_price: num(pos.price), stop: pos0(pos.stopLoss), target: pos0(pos.takeProfit), comment: td.comment ?? null, label: td.label ?? null,
    };
  }

  newManage(p, plannedStop, manageRaw) {
    const risk = plannedStop > 0 && p.entry_price ? Math.abs(p.entry_price - plannedStop) : p.stop && p.entry_price ? Math.abs(p.entry_price - p.stop) : null;
    return { cmdId: null, entry: p.entry_price, risk, manage: parseManage(manageRaw), peak: 0, pending: null, lastMove: 0 };
  }

  /** Gestão gravada no comentário da posição (ponte reiniciada não perde o stop móvel). */
  restoreManage(p) {
    if (this.manage.has(p.position_id) || p.label !== "MBFX" || !p.comment) return;
    try {
      const c = JSON.parse(p.comment);
      const st = this.newManage(p, Number(c.s), c.m);
      this.manage.set(p.position_id, st);
      if (st.manage) this.log(`gestão recuperada da posição ${p.position_id} (${p.symbol})`);
    } catch { /* comentário de outra origem */ }
  }

  onReconcile(p) {
    if (!this.ready) return;
    const next = new Map();
    for (const raw of p.position ?? []) {
      const pos = this.readPosition(raw);
      if (pos) next.set(pos.position_id, pos);
    }
    // resposta pedida antes de uma execução recente: não apaga a posição que acabou de abrir
    for (const o of this.orders.values()) {
      if (o.posId && Date.now() - (o.filledAt ?? 0) < 10000 && !next.has(o.posId) && this.positions.has(o.posId)) next.set(o.posId, this.positions.get(o.posId));
    }
    for (const [k, o] of this.orders) if (o.done && Date.now() - (o.filledAt ?? o.sentAt ?? 0) > 600000) this.orders.delete(k);
    this.positions = next;
    for (const id of this.manage.keys()) if (!next.has(id)) this.manage.delete(id);
    for (const pos of next.values()) {
      this.restoreManage(pos);
      if (!pos.stop && !this.alerted.has(pos.position_id) && !this.isFresh(pos.position_id)) {
        this.alerted.add(pos.position_id);
        this.event("protection_failed", { sym: pos.symbol, side: pos.side, units: pos.units, posId: pos.position_id }, { reason: "posição sem stop na corretora" });
      }
    }
    this.publishPositions();
  }

  /** Posição recém-aberta pela ponte, ainda dentro da checagem de proteção. */
  isFresh(posId) { for (const o of this.orders.values()) if (o.posId === posId && !o.checked) return true; return false; }

  onExecution(p) {
    const type = EXEC[p.executionType] ?? null;
    const order = p.order ?? {};
    const raw = p.position;
    const pos = raw ? this.readPosition(raw) : null;
    const posId = String(raw?.positionId ?? order.positionId ?? p.deal?.positionId ?? "");
    const o = this.orders.get(order.clientOrderId ?? "");
    const price = num(p.deal?.executionPrice ?? order.executionPrice ?? raw?.price);

    if (o?.kind === "entry" && !o.done) {
      if (type === "rejected" || type === "cancelled" || type === "expired") {
        o.done = true;
        return this.event("rejected", o, { reason: p.errorCode ?? "recusada pela corretora" });
      }
      if ((type === "filled" || type === "partial") && pos) {
        o.done = true;
        o.posId = posId;
        o.filledAt = Date.now();
        this.positions.set(posId, pos);
        const st = this.newManage(pos, o.stop, o.manageRaw);
        st.cmdId = o.cmdId;
        this.manage.set(posId, st);
        this.event("filled", { ...o, posId }, { price });
        this.ensureProtection(o, pos);
        this.publishPositions(true);
      }
      return;
    }

    if (!pos) return;
    if (isClosed(raw)) {
      const prev = this.positions.get(posId) ?? pos;
      const req = this.closing.get(posId);
      this.closing.delete(posId);
      let reason = req?.reason;
      if (!reason) {
        const st = prev.stop, tg = prev.target;
        reason = st && tg && price ? (Math.abs(price - st) <= Math.abs(price - tg) ? "stop" : "alvo") : "fechada na corretora";
        const m = this.manage.get(posId);
        if (reason === "stop" && m?.stage) reason = m.stage; // stop que já tinha sido movido pela gestão
      }
      this.positions.delete(posId);
      this.manage.delete(posId);
      this.event("closed", { cmdId: req?.cmdId ?? null, sym: prev.symbol, side: OPPOSITE[prev.side], units: prev.units, posId }, { price, reason });
      this.publishPositions(true);
      return;
    }

    // posição aberta mudou (stop movido, alvo, volume)
    this.positions.set(posId, pos);
    const st = this.manage.get(posId);
    if (st?.pending && pos.stop && Math.abs(pos.stop - st.pending.stop) < pipSize(pos.symbol) / 10) {
      const stage = st.pending.stage;
      st.stage = stage;
      st.pending = null;
      this.log(`stop movido para ${pos.stop} (${stage}) em ${pos.symbol}`);
      this.event("stop_moved", { cmdId: st.cmdId, sym: pos.symbol, side: pos.side, units: pos.units, posId }, { price: pos.stop, reason: stage });
    }
    this.publishPositions();
  }

  /** Confere se a posição nasceu com stop; se não, coloca; se não conseguir, fecha. */
  ensureProtection(o, pos) {
    if (pos.stop) {
      o.checked = true;
      this.event("protection_set", { ...o, posId: pos.position_id });
      return;
    }
    const sign = o.side === "buy" ? 1 : -1;
    const entry = pos.entry_price;
    const stop = entry - sign * o.relSL / 1e5, target = entry + sign * o.relTP / 1e5;
    this.log(`posição ${pos.position_id} sem stop após executar: colocando stop ${this.fmt(o.sym, stop)}`);
    this.amend(pos, stop, target, { initial: true, cmdId: o.cmdId });
    setTimeout(() => {
      o.checked = true;
      const now = this.positions.get(pos.position_id);
      if (!now) return;
      if (now.stop) return this.event("protection_set", { ...o, posId: pos.position_id });
      this.event("protection_failed", { ...o, posId: pos.position_id }, { reason: "stop não confirmado; posição fechada" });
      this.closePosition(now, o.cmdId, "sem stop");
    }, this.cfg.protectCheckMs ?? 5000).unref?.();
  }

  onError(clientMsgId, p) {
    const r = clientMsgId ? this.requests.get(clientMsgId) : null;
    const reason = `${p.errorCode ?? "erro"}${p.description ? `: ${p.description}` : ""}`.slice(0, 300);
    if (!r) {
      // erro de ordem sem clientMsgId conhecido: tenta casar pela posição
      const posId = p.positionId != null ? String(p.positionId) : null;
      const st = posId ? this.manage.get(posId) : null;
      if (st?.pending) { st.pending = null; st.lastMove = Date.now(); }
      return;
    }
    this.requests.delete(clientMsgId);
    this.log(`recusado (${r.kind}): ${reason}`);
    if (r.kind === "entry") {
      const o = this.orders.get(r.clOrd);
      if (o && !o.done) { o.done = true; this.event("rejected", o, { reason }); }
      return;
    }
    if (r.kind === "close") {
      this.closing.delete(r.posId);
      return this.event("rejected", r, { reason: `fechamento recusado: ${reason}` });
    }
    if (r.kind === "amend") {
      const st = this.manage.get(r.posId);
      if (st) { st.pending = null; st.lastMove = Date.now(); }
      if (r.initial) {
        const pos = this.positions.get(r.posId);
        if (pos && !pos.stop) {
          this.event("protection_failed", { cmdId: r.cmdId, sym: pos.symbol, side: pos.side, units: pos.units, posId: r.posId }, { reason: `stop recusado (${reason}); posição fechada` });
          this.closePosition(pos, r.cmdId, "sem stop");
        }
      }
    }
  }

  // ---------- gestão do lucro (stop na entrada + stop móvel) ----------

  onQuote(sym, q, now = Date.now()) {
    if (!this.loggedOn || !this.ready || !this.canTrade() || !q || !(q.bid > 0) || !(q.ask > 0)) return;
    for (const [posId, st] of this.manage) {
      const p = this.positions.get(posId);
      if (!p || p.symbol !== sym || !st.manage || !p.stop || !st.entry || !(st.risk > 0) || this.closing.has(posId)) continue;
      if (st.pending) {
        if (now - st.pending.at > 10000) st.pending = null; // sem confirmação: tenta de novo depois
        else continue;
      }
      const sign = p.side === "buy" ? 1 : -1;
      const exit = p.side === "buy" ? q.bid : q.ask;
      const profit = (exit - st.entry) * sign;
      st.peak = Math.max(st.peak, profit);
      const m = st.manage, pip = pipSize(sym);
      let want = null, stage = null;
      if (st.peak >= m.beR * st.risk) { want = st.entry + sign * m.lockPips * pip; stage = "stop na entrada"; }
      if (st.peak >= m.trailStartR * st.risk) {
        const trail = st.entry + sign * (st.peak - m.trailR * st.risk);
        if (want === null || (trail - want) * sign > 0) { want = trail; stage = "stop móvel"; }
      }
      if (want === null || (want - p.stop) * sign < pip) continue; // só melhora, e só se valer ≥ 1 pip
      if ((exit - want) * sign <= 0) {
        this.log(`lucro devolvido em ${sym}, fechando a mercado (${stage})`);
        this.closePosition(p, st.cmdId, stage);
        continue;
      }
      if (now - st.lastMove < (this.cfg.minMoveIntervalMs ?? 2000)) continue;
      const stop = this.fmt(sym, want);
      st.pending = { stop, stage, at: now };
      st.lastMove = now;
      this.amend(p, stop, p.target, { stage });
    }
  }
}
