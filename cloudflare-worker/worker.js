// MoxTokens CORS proxy — déployé sur Cloudflare Workers (plan gratuit : 100k requêtes/jour).
//
// Usage : GET https://<worker>.workers.dev/?url=<urlencoded URL cible>
// Whitelist stricte des domaines pour ne pas devenir un proxy ouvert.
//
// Pourquoi un proxy ? api2.moxfield.com refuse les requêtes navigateur cross-origin
// (pas d'en-tête CORS, et filtre sur User-Agent / Origin). On passe par le worker pour
// poser les bons headers et renvoyer la réponse avec Access-Control-Allow-Origin: *.

const ALLOWED = [
  "api2.moxfield.com",
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const u = new URL(request.url);
    const target = u.searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400, headers: corsHeaders() });
    }

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch { return new Response("Invalid url", { status: 400, headers: corsHeaders() }); }

    const host = targetUrl.hostname.toLowerCase();
    if (!ALLOWED.some((d) => host === d || host.endsWith("." + d))) {
      return new Response("Domain not allowed", { status: 403, headers: corsHeaders() });
    }

    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.moxfield.com",
        "Referer": "https://www.moxfield.com/",
      },
      redirect: "follow",
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },
};
