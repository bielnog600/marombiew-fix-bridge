import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenApiAccount, PT } from "../src/openapi.js";

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  reply(payloadType, payload) { this.onmessage?.({ data: JSON.stringify({ payloadType, payload }) }); }
  close() { this.readyState = 3; }
}

test("Open API: autentica, escolhe a conta pelo login e publica saldo, equity e margem", async () => {
  const acc = new OpenApiAccount({
    login: "9010569", pollMs: 999999, WebSocketImpl: FakeWS,
    getAuth: async () => ({ client_id: "cid", client_secret: "sec", access_token: "tok" }),
  });
  const out = [];
  acc.on("account", (a) => out.push(a));
  await acc.start();
  await new Promise((r) => setTimeout(r, 5));
  const ws = FakeWS.last;
  assert.deepEqual(ws.sent[0], { clientMsgId: ws.sent[0].clientMsgId, payloadType: PT.APP_AUTH_REQ, payload: { clientId: "cid", clientSecret: "sec" } });
  ws.reply(PT.APP_AUTH_RES, {});
  assert.equal(ws.sent.at(-1).payload.accessToken, "tok");
  ws.reply(PT.ACCOUNTS_BY_TOKEN_RES, { ctidTraderAccount: [{ ctidTraderAccountId: 111, traderLogin: 123 }, { ctidTraderAccountId: 222, traderLogin: 9010569, isLive: true }] });
  assert.equal(ws.sent.at(-1).payload.ctidTraderAccountId, 222);
  ws.reply(PT.ACCOUNT_AUTH_RES, {});
  assert.deepEqual(ws.sent.slice(-3).map((m) => m.payloadType), [PT.TRADER_REQ, PT.UNREALIZED_PNL_REQ, PT.RECONCILE_REQ]);
  ws.reply(PT.TRADER_RES, { trader: { balance: 6792, moneyDigits: 2 } });
  ws.reply(PT.UNREALIZED_PNL_RES, { moneyDigits: 2, positionUnrealizedPnL: [{ positionId: 1, netUnrealizedPnL: 48 }] });
  ws.reply(PT.RECONCILE_RES, { position: [{ usedMargin: 1020, moneyDigits: 2 }] });
  const a = out.at(-1);
  assert.deepEqual([a.balance, a.unrealized, a.equity, a.margin_used, a.free_margin], [67.92, 0.48, 68.4, 10.2, 58.2]);
  acc.stop();
});

test("Open API: sem token no app, tenta de novo depois (não derruba a ponte)", async () => {
  const logs = [];
  const acc = new OpenApiAccount({ login: "1", WebSocketImpl: FakeWS, log: (m) => logs.push(m), getAuth: async () => { throw new Error("HTTP 404"); } });
  await acc.start();
  assert.match(logs[0], /sem token/);
  acc.stop();
});

test("Open API: token novo no app (conta reconectada) faz a ponte reconectar com ele", async () => {
  let token = "velho";
  const acc = new OpenApiAccount({
    login: "9010569", pollMs: 999999, tokenCheckMs: 20, WebSocketImpl: FakeWS,
    getAuth: async () => ({ client_id: "cid", client_secret: "sec", access_token: token }),
  });
  await acc.start();
  await new Promise((r) => setTimeout(r, 5));
  const first = FakeWS.last;
  token = "novo";
  await new Promise((r) => setTimeout(r, 60));
  acc.stop();
  assert.equal(first.readyState, 3);
});
