import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PT } from "../src/openapi.js";
import { OpenApiTrader, relative } from "../src/openapi-trade.js";

/** Conta Open API falsa: guarda o que a ponte envia e deixa o teste responder. */
function setup({ scope = "trade", quote = { bid: 1.12100, ask: 1.12102 } } = {}) {
  const acc = new EventEmitter();
  acc.accountId = 222;
  acc.sent = [];
  let n = 0;
  acc.send = (payloadType, payload) => { const id = `m${++n}`; acc.sent.push({ id, payloadType, payload }); return id; };
  const reply = (payloadType, payload, clientMsgId) => acc.emit("message", { payloadType, payload, clientMsgId });
  const quotes = new Map([["EUR/USD", quote], ["XAU/USD", { bid: 4173.5, ask: 4173.8 }]]);
  const t = new OpenApiTrader({
    account: acc, symbols: ["EUR/USD", "XAU/USD"], maxLots: 0.1, maxPositions: 3, protectCheckMs: 30, minMoveIntervalMs: 0,
    getQuote: (s) => quotes.get(s),
  });
  const events = [];
  const positions = [];
  t.on("event", (e) => events.push(e));
  t.on("positions", (p) => positions.push(p));
  acc.emit("authorized", { accountId: 222, scope });
  reply(PT.SYMBOLS_LIST_RES, { symbol: [{ symbolId: 1, symbolName: "EURUSD" }, { symbolId: 41, symbolName: "XAUUSD" }, { symbolId: 9, symbolName: "BTCUSD" }] });
  reply(PT.SYMBOL_BY_ID_RES, { symbol: [
    { symbolId: 1, digits: 5, lotSize: 10000000, minVolume: 100000, stepVolume: 100000, maxVolume: 1e10 },
    { symbolId: 41, digits: 2, lotSize: 10000, minVolume: 100, stepVolume: 100, maxVolume: 1e8 },
  ] });
  const last = (type) => acc.sent.filter((m) => m.payloadType === type).at(-1);
  return { acc, t, reply, events, positions, quotes, last };
}
const cmd = (o) => ({ id: `c${Math.random()}`, created_at: new Date().toISOString(), ...o });
const position = (o = {}) => ({
  positionId: 500, positionStatus: 1, price: 1.12102, stopLoss: 1.1195, takeProfit: 1.124,
  tradeData: { symbolId: 1, volume: 100000, tradeSide: 1, label: "MBFX", comment: JSON.stringify({ s: 1.1195, m: { enabled: true } }) }, ...o,
});

test("relative: distância de preço vira 1/100000 respeitando as casas do par", () => {
  assert.equal(relative(0.00152, 5), 152);
  assert.equal(relative(0.152, 3), 15200);
  assert.equal(relative(3.0, 2), 300000);
});

test("Open API: compra a mercado com stop e alvo presos na posição", () => {
  const h = setup();
  assert.equal(h.t.ready, true);
  const c = cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.11950, target: 1.12400, manage: { enabled: true } });
  assert.equal(h.t.execute(c), null);
  const o = h.last(PT.NEW_ORDER_REQ).payload;
  assert.deepEqual(
    [o.ctidTraderAccountId, o.symbolId, o.orderType, o.tradeSide, o.volume, o.relativeStopLoss, o.relativeTakeProfit, o.label],
    [222, 1, 1, 1, 100000, 152, 298, "MBFX"],
  );
  assert.deepEqual(JSON.parse(o.comment), { s: 1.1195, m: { enabled: true } });
  h.reply(PT.EXECUTION_EVENT, { executionType: 3, order: { clientOrderId: o.clientOrderId, positionId: 500 }, position: position(), deal: { executionPrice: 1.12102 } });
  assert.ok(h.events.some((e) => e.type === "filled" && e.command_id === c.id && e.position_id === "500" && e.price === 1.12102));
  assert.ok(h.events.some((e) => e.type === "protection_set" && e.command_id === c.id));
  assert.deepEqual(h.positions.at(-1), [{ position_id: "500", symbol: "EUR/USD", side: "buy", units: 1000, entry_price: 1.12102, stop: 1.1195, target: 1.124, lots: 0.01 }]);
});

test("Open API: posição sem stop recebe o stop; se a corretora recusar, fecha na hora", () => {
  const h = setup();
  h.t.execute(cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.11950, target: 1.12400 }));
  const o = h.last(PT.NEW_ORDER_REQ).payload;
  h.reply(PT.EXECUTION_EVENT, { executionType: 3, order: { clientOrderId: o.clientOrderId }, position: position({ stopLoss: 0, takeProfit: 0 }) });
  const amend = h.last(PT.AMEND_SLTP_REQ);
  assert.deepEqual([amend.payload.positionId, amend.payload.stopLoss, amend.payload.takeProfit], [500, 1.1195, 1.124]);
  h.reply(PT.ORDER_ERROR_EVENT, { errorCode: "TRADING_BAD_STOPS", positionId: 500 }, amend.id);
  assert.ok(h.events.some((e) => e.type === "protection_failed"));
  assert.deepEqual(h.last(PT.CLOSE_POSITION_REQ).payload, { ctidTraderAccountId: 222, positionId: 500, volume: 100000 });
});

test("Open API: recusa da corretora vira evento rejected com o motivo", () => {
  const h = setup();
  const c = cmd({ action: "open", symbol: "EUR/USD", side: "sell", lots: 0.01, stop: 1.12300, target: 1.11800 });
  h.t.execute(c);
  const req = h.last(PT.NEW_ORDER_REQ);
  assert.equal(req.payload.tradeSide, 2);
  h.reply(PT.ORDER_ERROR_EVENT, { errorCode: "NOT_ENOUGH_MONEY", description: "sem margem" }, req.id);
  assert.ok(h.events.some((e) => e.type === "rejected" && e.command_id === c.id && /NOT_ENOUGH_MONEY/.test(e.reason)));
});

test("Open API: travas da ponte e token só de leitura", () => {
  const h = setup();
  const r = (o) => h.t.execute(cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.1195, target: 1.124, ...o }))?.reason;
  assert.match(r({ lots: 0.5 }), /limite da ponte/);
  assert.match(r({ stop: 1.1215 }), /compra exige/);
  assert.match(r({ stop: null }), /obrigatórios/);
  assert.match(r({ created_at: new Date(Date.now() - 60000).toISOString() }), /expirado/);
  const v = setup({ scope: "view" });
  assert.match(v.t.execute(cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.1195, target: 1.124 })).reason, /só de leitura/);
  assert.equal(v.acc.sent.filter((m) => m.payloadType === PT.NEW_ORDER_REQ).length, 0);
});

test("Open API: stop na entrada e stop móvel por amend; nunca afasta o stop", () => {
  const h = setup();
  h.reply(PT.RECONCILE_RES, { position: [position()] }); // gestão recuperada do comentário (ponte reiniciada)
  assert.equal(h.t.manage.get("500").risk.toFixed(5), "0.00152");
  h.t.onQuote("EUR/USD", { bid: 1.12200, ask: 1.12202 }); // +0.64 R: nada
  assert.equal(h.last(PT.AMEND_SLTP_REQ), undefined);
  h.t.onQuote("EUR/USD", { bid: 1.12230, ask: 1.12232 }); // +0.84 R: stop na entrada +1 pip
  let a = h.last(PT.AMEND_SLTP_REQ);
  assert.deepEqual([a.payload.stopLoss, a.payload.takeProfit], [1.12112, 1.124]);
  h.reply(PT.EXECUTION_EVENT, { executionType: 4, position: position({ stopLoss: 1.12112 }) });
  assert.ok(h.events.some((e) => e.type === "stop_moved" && e.price === 1.12112 && e.reason === "stop na entrada"));
  h.t.onQuote("EUR/USD", { bid: 1.12350, ask: 1.12352 }); // pico +1.62 R: stop móvel = pico - 0.5 R
  a = h.last(PT.AMEND_SLTP_REQ);
  assert.equal(a.payload.stopLoss, 1.12274);
  h.reply(PT.EXECUTION_EVENT, { executionType: 4, position: position({ stopLoss: 1.12274 }) });
  assert.ok(h.events.some((e) => e.type === "stop_moved" && e.reason === "stop móvel"));
  const count = h.acc.sent.filter((m) => m.payloadType === PT.AMEND_SLTP_REQ).length;
  h.t.onQuote("EUR/USD", { bid: 1.12300, ask: 1.12302 }); // voltou um pouco: não mexe
  assert.equal(h.acc.sent.filter((m) => m.payloadType === PT.AMEND_SLTP_REQ).length, count);
  // stop bateu: fechamento com o motivo da gestão
  h.reply(PT.EXECUTION_EVENT, { executionType: 3, position: position({ positionStatus: 2, stopLoss: 1.12274 }), deal: { executionPrice: 1.12274 } });
  assert.ok(h.events.some((e) => e.type === "closed" && e.position_id === "500" && e.reason === "stop móvel" && e.side === "sell"));
  assert.deepEqual(h.positions.at(-1), []);
});

test("Open API: fechar manual e fechar todas", () => {
  const h = setup();
  h.reply(PT.RECONCILE_RES, { position: [position(), position({ positionId: 501, tradeData: { symbolId: 41, volume: 100, tradeSide: 2 } })] });
  const c = cmd({ action: "close", position_id: "500" });
  assert.equal(h.t.execute(c), null);
  assert.deepEqual(h.last(PT.CLOSE_POSITION_REQ).payload, { ctidTraderAccountId: 222, positionId: 500, volume: 100000 });
  h.reply(PT.EXECUTION_EVENT, { executionType: 3, position: position({ positionStatus: 2 }), deal: { executionPrice: 1.1215 } });
  assert.ok(h.events.some((e) => e.type === "closed" && e.command_id === c.id && e.reason === "manual" && e.price === 1.1215));
  h.t.execute(cmd({ action: "close_all" }));
  assert.deepEqual(h.last(PT.CLOSE_POSITION_REQ).payload, { ctidTraderAccountId: 222, positionId: 501, volume: 100 });
  assert.equal(h.positions.at(-1).length, 1);
  assert.equal(h.positions.at(-1)[0].lots, 0.01); // 1 oz de ouro = 0,01 lote
});

test("Open API: posição aberta sem stop na corretora gera alerta uma vez", () => {
  const h = setup();
  h.reply(PT.RECONCILE_RES, { position: [position({ stopLoss: 0 })] });
  h.reply(PT.RECONCILE_RES, { position: [position({ stopLoss: 0 })] });
  assert.equal(h.events.filter((e) => e.type === "protection_failed").length, 1);
});

test("Open API: fechamento sem preço no evento usa a cotação ao vivo (nunca 0)", () => {
  const h = setup();
  h.reply(PT.RECONCILE_RES, { position: [position()] });
  const c = cmd({ action: "close", position_id: "500" });
  h.t.execute(c);
  h.reply(PT.EXECUTION_EVENT, { executionType: 3, order: { executionPrice: 0 }, position: position({ positionStatus: 2, price: 0 }) });
  const e = h.events.find((x) => x.type === "closed");
  assert.equal(e.price, 1.121); // bid do EUR/USD no teste
});
