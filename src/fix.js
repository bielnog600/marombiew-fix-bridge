// Codificação e leitura de mensagens FIX 4.4 (sem dependências).
export const SOH = "\x01";

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

/** Formato FIX UTCTimestamp: YYYYMMDD-HH:MM:SS.sss */
export function fixTime(d = new Date()) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** Converte UTCTimestamp FIX em milissegundos (null se inválido). */
export function parseFixTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(s ?? "");
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

export function checksum(str) {
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum += str.charCodeAt(i);
  return pad(sum % 256, 3);
}

/**
 * Monta uma mensagem FIX completa.
 * header: { senderCompID, targetCompID, senderSubID, targetSubID }
 * fields: lista de [tag, valor] do corpo, na ordem exigida (grupos repetidos incluídos).
 */
export function encode(msgType, seq, header, fields, now = new Date()) {
  const parts = [
    ["35", msgType],
    ["49", header.senderCompID],
    ["56", header.targetCompID],
    ["34", seq],
    ["52", fixTime(now)],
  ];
  if (header.senderSubID) parts.push(["50", header.senderSubID]);
  if (header.targetSubID) parts.push(["57", header.targetSubID]);
  for (const f of fields) parts.push(f);
  const body = parts.map(([t, v]) => `${t}=${v}${SOH}`).join("");
  const head = `8=FIX.4.4${SOH}9=${Buffer.byteLength(body, "latin1")}${SOH}`;
  const withoutCs = head + body;
  return `${withoutCs}10=${checksum(withoutCs)}${SOH}`;
}

/**
 * Extrai mensagens completas de um buffer de texto (stream TCP).
 * Retorna { messages: string[], rest: string }.
 */
export function splitMessages(buf) {
  const messages = [];
  let rest = buf;
  for (;;) {
    const start = rest.indexOf(`8=FIX`);
    if (start < 0) return { messages, rest: "" };
    if (start > 0) rest = rest.slice(start);
    const m = /^8=[^\x01]+\x019=(\d+)\x01/.exec(rest);
    if (!m) return { messages, rest };
    const bodyStart = m[0].length;
    const bodyLen = Number(m[1]);
    const csStart = bodyStart + bodyLen;
    // "10=XXX\x01" = 7 caracteres
    if (rest.length < csStart + 7) return { messages, rest };
    const msg = rest.slice(0, csStart + 7);
    if (!msg.slice(csStart).startsWith("10=")) {
      // fluxo corrompido: descarta até o próximo início
      rest = rest.slice(1);
      continue;
    }
    messages.push(msg);
    rest = rest.slice(csStart + 7);
  }
}

/** Lê a mensagem como lista ordenada de [tag, valor] (preserva grupos repetidos). */
export function parse(msg) {
  const out = [];
  for (const part of msg.split(SOH)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) continue;
    out.push([part.slice(0, i), part.slice(i + 1)]);
  }
  return out;
}

export function get(fields, tag) {
  const f = fields.find(([t]) => t === tag);
  return f ? f[1] : undefined;
}

/** Texto legível para log (troca SOH por | e esconde a senha). */
export function printable(msg) {
  return msg.replace(/554=[^\x01]*/g, "554=****").split(SOH).join("|");
}
