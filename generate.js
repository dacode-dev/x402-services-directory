#!/usr/bin/env node
// Generates the x402 Services Directory from public facilitator discovery endpoints.
// Output: docs/index.html (human) + docs/services.json (machine).
// Zero dependencies — Node 18+ built-in fetch.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = join(ROOT, "docs");
const SOURCES = [
  "https://facilitator.openx402.ai/discovery/resources",
  "https://facilitator.payai.network/discovery/resources",
];
const PROBE_TIMEOUT_MS = 6_000;
const PROBE_CONCURRENCY = 8;

const usdcAmount = (accepts) => {
  const a = Array.isArray(accepts) ? accepts[0] : undefined;
  if (!a) return null;
  const n = Number(a.amount);
  if (!Number.isFinite(n)) return null;
  // USDC has 6 decimals on Base; other assets would need their own scaling.
  const asset = String(a.asset || "").toLowerCase();
  if (asset && asset !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
    return { raw: a.amount, usd: null, asset };
  }
  return { raw: a.amount, usd: n / 1e6, asset: asset || "usdc" };
};

async function fetchSource(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body) ? body : body.items || [];
  return { url, items };
}

// Probes a resource for a live payment gate. GET first, then POST {} for POST-shaped APIs.
async function probe(resource) {
  for (const method of ["GET", "POST"]) {
    try {
      const res = await fetch(resource.url, {
        method,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status === 402) {
        const challenge =
          res.headers.get("payment-required") !== null ||
          JSON.stringify(await res.text().catch(() => "")).includes("payTo");
        return { alive: true, httpStatus: 402, challengePresent: challenge, probedWith: method };
      }
      if (res.status < 500) {
        // Definitive non-402 answer from the origin: reachable but not gated (or auth-walled).
        return { alive: true, httpStatus: res.status, challengePresent: false, probedWith: method };
      }
    } catch {
      /* try next method */
    }
  }
  return { alive: false, httpStatus: null, challengePresent: false, probedWith: null };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}

async function main() {
  const results = [];
  for (const src of SOURCES) {
    try {
      results.push(await fetchSource(src));
    } catch (err) {
      console.error(`source failed: ${err.message}`);
    }
  }

  const seen = new Map();
  for (const { url, items } of results) {
    for (const item of items) {
      const resourceUrl = typeof item.resource === "string" ? item.resource : item.resource?.url;
      if (!resourceUrl) continue;
      const accepts = Array.isArray(item.accepts) ? item.accepts : [];
      const entry = {
        url: resourceUrl,
        host: hostOf(resourceUrl),
        type: item.type || "http",
        network: accepts[0]?.network || null,
        price: usdcAmount(accepts),
        payTo: accepts[0]?.payTo || null,
        x402Version: item.x402Version || null,
        facilitator: new URL(url).host,
        lastIndexed: item.lastUpdated || null,
        source: url,
      };
      const key = `${entry.url}|${entry.network}`;
      if (!seen.has(key)) seen.set(key, entry);
    }
  }

  const services = [...seen.values()];
  console.log(`normalized ${services.length} services`);

  // Bounded-concurrency liveness probing.
  const queue = [...services];
  const probed = [];
  async function worker() {
    while (queue.length) {
      const svc = queue.shift();
      const probeResult = await probe(svc);
      probed.push({ ...svc, ...probeResult });
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    sources: SOURCES,
    counts: {
      total: probed.length,
      alive: probed.filter((s) => s.alive).length,
      sellable: probed.filter((s) => s.challengePresent).length,
      hosts: new Set(probed.map((s) => s.host)).size,
    },
    services: probed.sort((a, b) => a.host.localeCompare(b.host) || String(a.url).localeCompare(String(b.url))),
  };

  mkdirSync(DOCS, { recursive: true });
  writeFileSync(join(DOCS, "services.json"), JSON.stringify(payload, null, 2) + "\n");
  writeFileSync(
    join(DOCS, "stats.json"),
    JSON.stringify({ generatedAt, ...payload.counts }, null, 1) + "\n",
  );

  const rows = payload.services
    .map((s) => {
      const price = s.price ? (s.price.usd != null ? `$${s.price.usd.toFixed(2)}` : s.price.raw) : "—";
      const state = s.challengePresent ? "sellable" : s.alive ? `alive (${s.httpStatus})` : "unreachable";
      const color = s.challengePresent ? "#16a34a" : s.alive ? "#a16207" : "#dc2626";
      return `<tr><td><a href="${s.url}">${s.url.replace(/^https?:\/\//, "").slice(0, 70)}</a></td><td>${s.host}</td><td>${price}</td><td>${s.network || "—"}</td><td style="color:${color};font-weight:600">${state}</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Services Directory</title>
<meta name="description" content="Live directory of x402-paid API services: prices, networks, and verified payment gates. Machine-readable JSON included.">
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#111}
h1{font-size:1.6rem} .sub{color:#555;margin-top:-0.5rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #ddd;vertical-align:top}
th{background:#f5f5f5}
code{font-size:.85rem;background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}
.stats{display:flex;gap:2rem;margin:1rem 0}
.stats b{font-size:1.4rem;display:block}
footer{margin-top:2rem;color:#666;font-size:.85rem}
</style></head><body>
<h1>x402 Services Directory</h1>
<p class="sub">Live view of x402-paid APIs registered with supported facilitators. Regenerated automatically; each service probed for a real 402 payment challenge.</p>
<div class="stats">
<div><b>${payload.counts.total}</b>services</div>
<div><b>${payload.counts.sellable}</b>verified sellable</div>
<div><b>${payload.counts.hosts}</b>sellers</div>
<div><b>${generatedAt.slice(0, 16).replace("T", " ")}Z</b>generated</div>
</div>
<table><thead><tr><th>Endpoint</th><th>Seller host</th><th>Price</th><th>Network</th><th>Gate check</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p>Machine-readable: <a href="services.json">services.json</a>. Source data comes from public facilitator discovery endpoints; listing here is automatic and not an endorsement.</p>
<footer>Built as a free ecosystem utility. Data © respective sellers; probe results are best-effort.</footer>
</body></html>\n`;

  writeFileSync(join(DOCS, "index.html"), html);
  console.log(`wrote docs/index.html + docs/services.json at ${generatedAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
