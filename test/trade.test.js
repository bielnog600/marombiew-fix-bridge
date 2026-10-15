import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { encode, splitMessages, parse, get } from "../src/fix.js";
import { startBridge } from "../src/index.js";
import { TradeSession } from "../src/trade.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Servidor FIX simulado: QUOTE e TRADE no mesmo processo (portas diferentes). */
function fakeBroker({ rejectStop = false } = {}) {
  const sent = { QUOTE: [], TRADE: [] };
  let posSeq = 100;
  const positions = new Map();
  const mk = (sub) => net.createServer((sock) => {
    sock.setEncoding("latin1");
    let buf = "", seq = 1;
    const h = { senderCompID: "cServer", targetCompID: "live5.icmarkets.9", senderSubID: sub, targetSubID: sub };
    const out = (t, f) => sock.write(encode(t, seq++, h, f), "latin1");
    sock.on("data", (d) => {
      const r = splitMessages(buf + d);
      buf = r.rest;
      for (const m of r.messages) {
        const f = parse(m);
        const type = get(f, "35");
        sent[sub].push(f);
        if (type === "A") out("A", [["98", "0"], ["108", "30"]]);
        if (type === "x") out("y", [["320", get(f, "320")], ["146", "2"], ["55", "1"], ["1007", "EURUSD"], ["1008", "5"], ["55", "41"], ["1007", "XAUUSD"], ["1008", "2"]]);
        if (type === "V" && get(f, "55") === "1") out("W", [["55", "1"], ["268", "2"], ["269", "0"], ["270", "1.12100"], ["269", "1"], ["270", "1.12102"]]);
        if (type === "V" && get(f, "55") === "41") out("W", [["55", "41"], ["268", "2"], ["269", "0"], ["270", "4173.50"], ["269", "1"], ["270", "4173.80"]]);
        if (type === "D") {
          const ord = get(f, "40"), cl = get(f, "11");
          if (ord === "1" && !get(f, "721")) {
            const pid = String(posSeq++);
            positions.set(pid, { sym: get(f, "55"), side: get(f, "54"), qty: get(f, "38") });
            out("8", [["11", cl], ["150", "F"], ["39", "2"], ["6", "1.12102"], ["721", pid], ["55", get(f, "55")]]);
          } else if (ord === "1") {
            positions.delete(get(f, "721"));
            out("8", [["11", cl], ["150", "F"], ["39", "2"], ["6", "1.12090"], ["721", get(f, "721")]]);
          } else if (ord === "3" && rejectStop) {
            out("8", [["11", cl], ["150", "8"], ["39", "8"], ["58", "INVALID_STOP"], ["721", get(f, "721")]]);
          } else {
            out("8", [["11", cl], ["150", "0"], ["39", "0"], ["721", get(f, "721")]]);
          }
        }
        if (type === "AN") {
          const req = get(f, "710");
          if (!positions.size) out("AP", [["710", req], ["727", "0"], ["728", "2"]]);
          for (const [pid, p] of positions) out("AP", [["710", req], ["727", String(positions.size)], ["721", pid], ["55", p.sym], [p.side === "1" ? "704" : "705", p.qty], ["730", "1.12102"]]);
        }
      }
    });
  });
  return { quote: mk("QUOTE"), trade: mk("TRADE"), sent, positions };
}

async function harness(opts = {}) {
  const broker = fakeBroker(opts);
  await new Promise((r) => broker.quote.listen(0, r));
  await new Promise((r) => broker.trade.listen(0, r));
  const queue = [];
  const reports = [];
  const app = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer tok");
      if (req.url.endsWith("/commands")) return res.end(JSON.stringify({ commands: queue.splice(0) }));
      if (req.url.endsWith("/report")) reports.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}/api/public/fix`;
  const bridge = startBridge({
    host: "127.0.0.1", port: broker.quote.address().port, tradePort: broker.trade.address().port, tls: false,
    senderCompID: "live5.icmarkets.9", targetCompID: "cServer", username: "9", password: "x", heartbeat: 30,
    priceSide: "bid", symbols: ["EUR/USD", "XAU/USD"], symbolIds: {},
    ingestUrl: `${base}/ingest`, commandsUrl: `${base}/commands`, reportUrl: `${base}/report`, ingestToken: "tok",
    pushEveryMs: 60000, tradeEnabled: true, pollEveryMs: 100, maxLots: 0.1, maxPositions: 3, lotSizes: {}, steps: {}, debug: false,
  });
  await wait(500);
  const done = async () => {
    bridge.stop();
    await wait(400);
    for (const srv of [broker.quote, broker.trade, app]) { srv.close(); srv.closeAllConnections?.(); }
  };
  const events = () => reports.flatMap((r) => r.events);
  return { broker, queue, reports, events, bridge, done };
}

const cmd = (o) => ({ id: `c${Math.random()}`, created_at: new Date().toISOString(), ...o });

test("compra: executa a mercado e coloca stop e alvo vinculados à posição", async () => {
  const h = await harness();
  const c = cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.11950, target: 1.12400 });
  h.queue.push(c);
  await wait(800);
  const ds = h.broker.sent.TRADE.filter((f) => get(f, "35") === "D");
  assert.equal(ds.length, 3);
  const [entry, sl, tp] = ds;
  assert.deepEqual([get(entry, "40"), get(entry, "54"), get(entry, "38"), get(entry, "55")], ["1", "1", "1000", "1"]);
  assert.deepEqual([get(sl, "40"), get(sl, "54"), get(sl, "99"), get(sl, "721")], ["3", "2", "1.11950", "100"]);
  assert.deepEqual([get(tp, "40"), get(tp, "54"), get(tp, "44"), get(tp, "721")], ["2", "2", "1.12400", "100"]);
  const ev = h.events();
  assert.ok(ev.some((e) => e.type === "filled" && e.command_id === c.id && e.price === 1.12102 && e.position_id === "100"));
  assert.ok(ev.some((e) => e.type === "protection_set" && e.command_id === c.id));
  await h.done();
});

test("stop recusado: posição é fechada na hora", async () => {
  const h = await harness({ rejectStop: true });
  h.queue.push(cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.02, stop: 1.11950, target: 1.12400 }));
  await wait(800);
  const ds = h.broker.sent.TRADE.filter((f) => get(f, "35") === "D");
  const closeOrder = ds.find((f) => get(f, "40") === "1" && get(f, "721") === "100");
  assert.ok(closeOrder, "deve fechar a posição sem stop");
  assert.equal(get(closeOrder, "54"), "2");
  const types = h.events().map((e) => e.type);
  assert.ok(types.includes("protection_failed"));
  assert.ok(types.includes("closed"));
  assert.equal(h.broker.positions.size, 0);
  await h.done();
});

test("travas: lote acima do limite, stop do lado errado, comando velho e sem stop", async () => {
  const h = await harness();
  h.queue.push(
    cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.5, stop: 1.1195, target: 1.124 }),
    cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.1230, target: 1.124 }),
    cmd({ action: "open", symbol: "EUR/USD", side: "sell", lots: 0.01, stop: 1.1250, target: 1.119, created_at: new Date(Date.now() - 60000).toISOString() }),
    cmd({ action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 0, target: 1.124 }),
  );
  await wait(800);
  assert.equal(h.broker.sent.TRADE.filter((f) => get(f, "35") === "D").length, 0, "nenhuma ordem pode sair");
  const reasons = h.events().filter((e) => e.type === "rejected").map((e) => e.reason);
  assert.equal(reasons.length, 4);
  assert.match(reasons[0], /limite/);
  assert.match(reasons[1], /stop/);
  assert.match(reasons[2], /expirado/);
  assert.match(reasons[3], /obrigatórios/);
  await h.done();
});

test("fechar posição e relatório de posições", async () => {
  const h = await harness();
  h.queue.push(cmd({ action: "open", symbol: "EUR/USD", side: "sell", lots: 0.01, stop: 1.1240, target: 1.1180 }));
  await wait(700);
  h.bridge.trade.requestPositions();
  await wait(300);
  const snap = h.reports.filter((r) => r.positions).at(-1).positions;
  assert.equal(snap.length, 1);
  assert.deepEqual([snap[0].position_id, snap[0].side, snap[0].units, snap[0].lots], ["100", "sell", 1000, 0.01]);
  h.queue.push(cmd({ action: "close", position_id: "100" }));
  await wait(600);
  const closed = h.events().find((e) => e.type === "closed");
  assert.equal(closed.reason, "manual");
  // stop e alvo da posição fechada são cancelados
  assert.equal(h.broker.sent.TRADE.filter((f) => get(f, "35") === "F").length, 2);
  await h.done();
});

test("ouro: 0.01 lote = 1 unidade e preço com 2 casas", () => {
  const t = new TradeSession({ symbols: ["XAU/USD"], senderCompID: "a", targetCompID: "b", heartbeat: 30 });
  assert.equal(t.toUnits("XAU/USD", 0.01), 1);
  assert.equal(t.toUnits("EUR/USD", 0.05), 5000);
  assert.equal(t.fmt("XAU/USD", 4170.123), "4170.12");
});

test("rejeição de negócio (35=j) e de sessão (35=3) viram ordem recusada", () => {
  const t = new TradeSession({ symbols: ["EUR/USD"], senderCompID: "a", targetCompID: "b", heartbeat: 30, maxLots: 1, maxPositions: 3,
    getQuote: () => ({ bid: 1.12, ask: 1.1202 }), orderTimeoutMs: 999999 });
  const ev = [];
  t.on("event", (e) => ev.push(e));
  t.send = () => true;
  t.loggedOn = true; t.ready = true; t.symIds.set("EUR/USD", "1");
  const mk = () => ({ id: "c", created_at: new Date().toISOString(), action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.119, target: 1.123 });
  t.seq = 7;
  assert.equal(t.execute(mk()), null);
  const cl1 = [...t.orders.keys()][0];
  t.handle([["35", "j"], ["379", cl1], ["380", "0"], ["58", "TRADING_DISABLED"]]);
  t.seq = 9;
  assert.equal(t.execute(mk()), null);
  t.handle([["35", "3"], ["45", "9"], ["371", "38"], ["58", "Invalid tag value"]]);
  const rej = ev.filter((e) => e.type === "rejected");
  assert.equal(rej.length, 2);
  assert.match(rej[0].reason, /TRADING_DISABLED/);
  assert.match(rej[1].reason, /Invalid tag value \(tag 38\)/);
});

test("sem resposta em 20 s: avisa, e se executar depois ainda coloca o stop", async () => {
  const t = new TradeSession({ symbols: ["EUR/USD"], senderCompID: "a", targetCompID: "b", heartbeat: 30, maxLots: 1, maxPositions: 3,
    getQuote: () => ({ bid: 1.12, ask: 1.1202 }), orderTimeoutMs: 50 });
  const ev = [], sent = [];
  t.on("event", (e) => ev.push(e));
  t.send = (type, f) => { sent.push(f); return true; };
  t.loggedOn = true; t.ready = true; t.symIds.set("EUR/USD", "1");
  t.execute({ id: "c", created_at: new Date().toISOString(), action: "open", symbol: "EUR/USD", side: "buy", lots: 0.01, stop: 1.119, target: 1.123 });
  await new Promise((r) => setTimeout(r, 120));
  assert.match(ev[0].reason, /sem resposta/);
  const cl = [...t.orders.keys()][0];
  t.handle([["35", "8"], ["11", cl], ["150", "F"], ["39", "2"], ["6", "1.1201"], ["721", "77"]]);
  assert.ok(ev.some((e) => e.type === "filled"));
  assert.ok(sent.some((f) => f.some(([k, v]) => k === "40" && v === "3")), "stop colocado mesmo após o aviso");
});
