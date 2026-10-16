import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { encode, splitMessages, parse, get, checksum, SOH } from "../src/fix.js";
import { CandleBuilder } from "../src/candles.js";
import { startBridge } from "../src/index.js";

test("mensagem FIX tem BodyLength e CheckSum corretos", () => {
  const m = encode("A", 1, { senderCompID: "live5.icmarkets.1", targetCompID: "cServer", senderSubID: "QUOTE", targetSubID: "QUOTE" }, [["98", "0"], ["108", "30"]]);
  const body = m.slice(m.indexOf(`${SOH}35=`) + 1, m.lastIndexOf("10="));
  assert.equal(Number(/9=(\d+)/.exec(m)[1]), Buffer.byteLength(body, "latin1"));
  assert.equal(m.slice(-4, -1), checksum(m.slice(0, m.lastIndexOf("10="))));
});

test("splitMessages junta mensagens partidas no TCP", () => {
  const a = encode("0", 2, { senderCompID: "x", targetCompID: "y" }, []);
  const b = encode("1", 3, { senderCompID: "x", targetCompID: "y" }, [["112", "T"]]);
  const all = a + b;
  const r1 = splitMessages(all.slice(0, a.length + 10));
  assert.equal(r1.messages.length, 1);
  const r2 = splitMessages(r1.rest + all.slice(a.length + 10));
  assert.equal(r2.messages.length, 1);
  assert.equal(get(parse(r2.messages[0]), "112"), "T");
});

test("velas: OHLC, fechamento e tick atrasado", () => {
  const b = new CandleBuilder(["M5"]);
  const closed = [];
  b.onClose = (c) => closed.push(c);
  const t0 = 1760518800 * 1000; // múltiplo de 300 s
  b.tick("EUR/USD", 1.1, t0);
  b.tick("EUR/USD", 1.105, t0 + 60e3);
  b.tick("EUR/USD", 1.098, t0 + 120e3);
  b.tick("EUR/USD", 1.101, t0 + 299e3);
  b.tick("EUR/USD", 1.2, t0 + 301e3); // nova vela
  b.tick("EUR/USD", 1.5, t0 + 200e3); // atrasado, ignorado
  assert.equal(closed.length, 1);
  assert.deepEqual([closed[0].open, closed[0].high, closed[0].low, closed[0].close, closed[0].ticks], [1.1, 1.105, 1.098, 1.101, 4]);
  b.flush(t0 + 601e3);
  assert.equal(closed.length, 2);
  const sent = b.take();
  assert.equal(sent.filter((c) => c.closed).length, 2);
});

test("ponte completa contra servidor FIX simulado", async () => {
  const received = [];
  const fixLog = [];
  const fixServer = net.createServer((sock) => {
    sock.setEncoding("latin1");
    let buf = "", seq = 1;
    const h = { senderCompID: "cServer", targetCompID: "live5.icmarkets.9", senderSubID: "QUOTE", targetSubID: "QUOTE" };
    const out = (t, f) => sock.write(encode(t, seq++, h, f), "latin1");
    sock.on("data", (d) => {
      const r = splitMessages(buf + d);
      buf = r.rest;
      for (const m of r.messages) {
        const f = parse(m);
        const type = get(f, "35");
        fixLog.push(type);
        if (type === "A") {
          assert.equal(get(f, "553"), "9");
          assert.equal(get(f, "554"), "segredo");
          assert.equal(get(f, "50"), "QUOTE");
          out("A", [["98", "0"], ["108", "30"]]);
        }
        if (type === "x") out("y", [["320", get(f, "320")], ["560", "0"], ["146", "2"], ["55", "1"], ["1007", "EURUSD"], ["1008", "5"], ["55", "41"], ["1007", "XAUUSD"], ["1008", "2"]]);
        if (type === "V" && get(f, "55") === "1") {
          out("W", [["262", get(f, "262")], ["55", "1"], ["268", "2"], ["269", "0"], ["270", "1.12100"], ["269", "1"], ["270", "1.12102"]]);
          out("X", [["268", "1"], ["279", "0"], ["269", "0"], ["278", "a"], ["55", "1"], ["270", "1.12150"]]);
        }
      }
    });
  });
  await new Promise((r) => fixServer.listen(0, r));

  const ingest = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer tok");
      received.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => ingest.listen(0, r));

  const bridge = startBridge({
    host: "127.0.0.1", port: fixServer.address().port, tls: false, tradeEnabled: false,
    senderCompID: "live5.icmarkets.9", targetCompID: "cServer",
    username: "9", password: "segredo", heartbeat: 30, priceSide: "bid",
    symbols: ["EUR/USD", "XAU/USD"], symbolIds: {},
    ingestUrl: `http://127.0.0.1:${ingest.address().port}/api/public/fix/ingest`, ingestToken: "tok",
    pushEveryMs: 300, debug: false,
  });
  await new Promise((r) => setTimeout(r, 1500));
  bridge.stop();
  await new Promise((r) => setTimeout(r, 400));
  fixServer.close();
  ingest.close();
  ingest.closeAllConnections();

  assert.deepEqual(fixLog.slice(0, 2), ["A", "x"]);
  assert.equal(fixLog.filter((t) => t === "V").length, 2);
  const withCandles = received.filter((b) => b.candles.length);
  assert.ok(withCandles.length >= 1, "deve enviar velas");
  const m5 = withCandles.flatMap((b) => b.candles).filter((c) => c.symbol === "EUR/USD" && c.tf === "M5").at(-1);
  assert.equal(m5.close, 1.1215);
  assert.equal(m5.high, 1.1215);
  assert.equal(m5.low, 1.121);
  const last = received.at(-1).status;
  assert.equal(last.bridge_version, "1.4.0");
  assert.ok(received.some((b) => b.status.connected && b.status.symbols.includes("XAU/USD")));
});

