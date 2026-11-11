// Probe of the Node APIs the Workers backend imports that celld (0.6.3) may lack: `celld dev benchmarks/agent-memory/celld-probe`, then GET /.
import * as dns from "node:dns/promises";
import * as crypto from "node:crypto";
const t = async (name, fn) => { try { return [name, "ok", String(await fn()).slice(0, 80)]; } catch (e) { return [name, "FAIL", String(e?.message ?? e).slice(0, 160)]; } };
export default { async fetch() {
  const rows = await Promise.all([
    t("dns.resolve4", () => dns.resolve4("example.com")),
    t("aes-256-gcm createCipheriv", () => { const c = crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), crypto.randomBytes(12)); return Buffer.concat([c.update("x"), c.final()]).length; }),
    t("scrypt", () => new Promise((res, rej) => crypto.scrypt("pw", "salt", 32, (e, k) => e ? rej(e) : res(k.length)))),
    t("ed25519 createPrivateKey+sign", () => { const { privateKey } = crypto.generateKeyPairSync("ed25519"); return crypto.sign(null, Buffer.from("m"), privateKey).length; }),
    t("createHash sha256", () => crypto.createHash("sha256").update("x").digest("hex")),
    t("createHmac", () => crypto.createHmac("sha256", "k").update("x").digest("hex")),
    t("timingSafeEqual", () => crypto.timingSafeEqual(Buffer.from("a"), Buffer.from("a"))),
  ]);
  return Response.json(rows);
} };
