// cTrader Open API (JSON sobre WebSocket): saldo, equity e margem reais da conta.
// A mesma conexão também leva as ordens (veja openapi-trade.js).
// Os tokens OAuth vêm do app (/api/public/fix/ctrader-auth).
import { EventEmitter } from "node:events";

export const PT = {
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
  TRADER_REQ: 2121, TRADER_RES: 2122, TRADER_UPDATED: 2123,
  RECONCILE_REQ: 2124, RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  ERROR_RES: 2142,
  NEW_ORDER_REQ: 2106, AMEND_SLTP_REQ: 2110, CLOSE_POSITION_REQ: 2111,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115, SYMBOL_BY_ID_REQ: 2116, SYMBOL_BY_ID_RES: 2117,
  ORDER_ERROR_EVENT: 2132,
  ACCOUNTS_BY_TOKEN_REQ: 2149, ACCOUNTS_BY_TOKEN_RES: 2150,
  ACCOUNT_DISCONNECT: 2164, TOKEN_INVALIDATED: 2147,
  UNREALIZED_PNL_REQ: 2187, UNREALIZED_PNL_RES: 2188,
};

const money = (v, digits) => (v == null ? null : Number(v) / 10 ** (digits ?? 2));

export class OpenApiAccount extends EventEmitter {
  /**
   * cfg: { url, login, getAuth: async () => ({ client_id, client_secret, access_token }),
   *        pollMs, log, WebSocketImpl }
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = (m) => (cfg.log ?? (() => {}))(`[OPENAPI] ${m}`);
    this.ws = null;
    this.accountId = null;
    this.auth = null;
    this.state = { balance: null, unrealized: 0, marginUsed: null, digits: 2, currency: null };
    this.timers = [];
    this.stopped = false;
    this.backoff = 5000;
    this.seq = 1;
  }

  send(payloadType, payload = {}) {
    if (!this.ws || this.ws.readyState !== 1) return null;
    const clientMsgId = `m${this.seq++}`;
    this.ws.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    return clientMsgId;
  }

  async start() {
    if (this.stopped) return;
    try {
      this.auth = await this.cfg.getAuth();
    } catch (e) {
      this.log(`sem token (${e.message}); conecte a conta cTrader no app. Nova tentativa em 60 s`);
      return this.retry(60000);
    }
    const WS = this.cfg.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new WS(this.cfg.url ?? "wss://live.ctraderapi.com:5036");
    this.ws = ws;
    ws.onopen = () => {
      this.log("conectado, autenticando aplicação");
      this.backoff = 5000;
      this.send(PT.APP_AUTH_REQ, { clientId: this.auth.client_id, clientSecret: this.auth.client_secret });
      this.timers.push(setInterval(() => this.send(PT.HEARTBEAT, {}), 25000));
      // conta reconectada no app (token novo, ex.: com permissão de operar): troca sem reiniciar a ponte
      this.timers.push(setInterval(() => this.checkToken(), this.cfg.tokenCheckMs ?? 60000));
    };
    ws.onmessage = (ev) => {
      try { this.handle(JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString())); }
      catch (e) { this.log(`mensagem inválida: ${e.message}`); }
    };
    ws.onerror = (e) => this.log(`erro: ${e?.message ?? "websocket"}`);
    ws.onclose = () => {
      this.clear();
      this.emit("status", { connected: false });
      if (!this.stopped) { this.log(`desconectado; nova tentativa em ${this.backoff / 1000}s`); this.retry(this.backoff); this.backoff = Math.min(this.backoff * 2, 300000); }
    };
  }

  async checkToken() {
    try {
      const a = await this.cfg.getAuth();
      if (a?.access_token && this.auth && a.access_token !== this.auth.access_token) {
        this.log("token novo no app (conta reconectada): reconectando com ele");
        this.backoff = 1000;
        try { this.ws?.close(); } catch {}
      }
    } catch { /* app fora do ar: segue com o token atual */ }
  }

  retry(ms) {
    if (this.stopped) return;
    const t = setTimeout(() => this.start(), ms);
    t.unref?.();
  }

  clear() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  stop() {
    this.stopped = true;
    this.clear();
    try { this.ws?.close(); } catch {}
  }

  handle(m) {
    const p = m.payload ?? {};
    this.emit("message", m);
    switch (m.payloadType) {
      case PT.APP_AUTH_RES:
        this.send(PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken: this.auth.access_token });
        return;
      case PT.ACCOUNTS_BY_TOKEN_RES: {
        const list = p.ctidTraderAccount ?? [];
        const acc = list.find((a) => String(a.traderLogin) === String(this.cfg.login)) ?? (list.length === 1 ? list[0] : null);
        if (!acc) {
          this.log(`conta ${this.cfg.login} não encontrada no token (contas: ${list.map((a) => a.traderLogin).join(", ") || "nenhuma"})`);
          this.emit("status", { connected: false, message: "conta não autorizada no token" });
          return;
        }
        this.accountId = acc.ctidTraderAccountId;
        // permissionScope: 0/SCOPE_VIEW = só leitura, 1/SCOPE_TRADE = pode operar
        const sc = p.permissionScope;
        this.scope = sc === 1 || sc === "SCOPE_TRADE" ? "trade" : sc === 0 || sc === "SCOPE_VIEW" ? "view" : "desconhecida";
        this.log(`permissão do token: ${this.scope === "trade" ? "operar (trading)" : this.scope === "view" ? "SÓ LEITURA — reconecte a conta no app para operar" : this.scope}`);
        this.send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.auth.access_token });
        return;
      }
      case PT.ACCOUNT_AUTH_RES:
        this.log(`conta ${this.cfg.login} autenticada`);
        this.emit("status", { connected: true });
        this.emit("authorized", { accountId: this.accountId, scope: this.scope });
        this.poll();
        this.timers.push(setInterval(() => this.poll(), this.cfg.pollMs ?? 5000));
        return;
      case PT.TRADER_RES:
      case PT.TRADER_UPDATED: {
        const t = p.trader ?? {};
        this.state.digits = t.moneyDigits ?? this.state.digits;
        this.state.balance = money(t.balance, this.state.digits);
        if (t.depositAssetId != null) this.state.depositAssetId = t.depositAssetId;
        this.publish();
        return;
      }
      case PT.UNREALIZED_PNL_RES: {
        const list = p.positionUnrealizedPnL ?? [];
        const digits = p.moneyDigits ?? this.state.digits;
        this.state.unrealized = list.reduce((s, x) => s + money(x.netUnrealizedPnL, digits), 0);
        this.publish();
        return;
      }
      case PT.RECONCILE_RES: {
        const list = p.position ?? [];
        this.state.marginUsed = list.reduce((s, x) => s + money(x.usedMargin, x.moneyDigits ?? this.state.digits), 0);
        this.publish();
        return;
      }
      case PT.EXECUTION_EVENT:
        this.poll(); // fechou/abriu algo: atualiza já
        return;
      case PT.ERROR_RES:
        this.log(`erro ${p.errorCode}: ${p.description ?? ""}`);
        // só erro de token derruba a conexão (ACCESS_DENIED de uma ordem não pode desligar o saldo)
        if (/TOKEN/i.test(p.errorCode ?? "")) { this.auth = null; try { this.ws.close(); } catch {} }
        return;
      case PT.TOKEN_INVALIDATED:
      case PT.ACCOUNT_DISCONNECT:
        this.log("token/conta desconectados pelo servidor; reconectando");
        try { this.ws.close(); } catch {}
        return;
      default:
    }
  }

  poll() {
    if (!this.accountId) return;
    this.send(PT.TRADER_REQ, { ctidTraderAccountId: this.accountId });
    this.send(PT.UNREALIZED_PNL_REQ, { ctidTraderAccountId: this.accountId });
    this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId });
  }

  publish() {
    const s = this.state;
    if (s.balance == null) return;
    const equity = +(s.balance + (s.unrealized ?? 0)).toFixed(2);
    const marginUsed = s.marginUsed == null ? null : +s.marginUsed.toFixed(2);
    this.emit("account", {
      login: Number(this.cfg.login), currency: this.cfg.currency ?? "EUR",
      balance: +s.balance.toFixed(2), equity, unrealized: +(s.unrealized ?? 0).toFixed(2),
      margin_used: marginUsed, free_margin: marginUsed == null ? null : +(equity - marginUsed).toFixed(2),
      at: new Date().toISOString(),
    });
  }
}
