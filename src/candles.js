// Monta velas OHLC a partir dos ticks, nos timeframes do Marombiew FX.
export const TF_SECONDS = { M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 };

export function bucketStart(tsSec, tf) {
  const s = TF_SECONDS[tf];
  return Math.floor(tsSec / s) * s;
}

export class CandleBuilder {
  constructor(timeframes = Object.keys(TF_SECONDS)) {
    this.timeframes = timeframes;
    this.current = new Map(); // "SYM|TF" -> candle aberta
    this.dirty = new Map(); // "SYM|TF|time" -> candle a enviar
    this.onClose = null; // callback quando uma vela fecha
  }

  tick(symbol, price, tsMs) {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const tsSec = Math.floor(tsMs / 1000);
    for (const tf of this.timeframes) {
      const key = `${symbol}|${tf}`;
      const start = bucketStart(tsSec, tf);
      let c = this.current.get(key);
      if (c && start < c.time) continue; // tick atrasado de vela já fechada: ignora
      if (c && start > c.time) {
        this.#close(c);
        c = undefined;
      }
      if (!c) {
        c = { symbol, tf, time: start, open: price, high: price, low: price, close: price, ticks: 0, closed: false };
        this.current.set(key, c);
      }
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.ticks++;
      this.dirty.set(`${key}|${c.time}`, { ...c });
    }
  }

  /** Fecha velas cujo período já acabou, mesmo sem tick novo (mercado parado). */
  flush(nowMs = Date.now()) {
    const nowSec = Math.floor(nowMs / 1000);
    for (const [key, c] of this.current) {
      if (nowSec >= c.time + TF_SECONDS[c.tf]) {
        this.#close(c);
        this.current.delete(key);
      }
    }
  }

  #close(c) {
    c.closed = true;
    this.dirty.set(`${c.symbol}|${c.tf}|${c.time}`, { ...c });
    this.onClose?.(c);
  }

  /** Retira até `max` velas pendentes (fechadas primeiro). */
  take(max = 500) {
    const all = [...this.dirty.entries()].sort((a, b) => Number(b[1].closed) - Number(a[1].closed));
    const batch = all.slice(0, max);
    for (const [k] of batch) this.dirty.delete(k);
    return batch.map(([, c]) => c);
  }

  /** Devolve velas que falharam no envio, sem sobrescrever versões mais novas. */
  restore(candles) {
    for (const c of candles) {
      const k = `${c.symbol}|${c.tf}|${c.time}`;
      if (!this.dirty.has(k)) this.dirty.set(k, c);
    }
  }
}
