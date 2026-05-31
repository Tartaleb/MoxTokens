// Source lisible du bookmarklet MoxTokens.
// app.js charge ce fichier au démarrage et l'injecte dans le href du lien #bookmarklet.
//
// Stratégie principale : /v3/decks (endpoint authentifié, existe en 401 sans cookie).
// On parcourt récursivement les dossiers via folderId. Format/date sont inclus
// dans la réponse, donc pas d'enrichissement côté app nécessaire.
//
// Fallback : si l'API refuse, on scrape le DOM avec auto-scroll (incomplet sur les
// dossiers fermés, mais c'est mieux que rien).

(async function () {
  if (!location.host.endsWith("moxfield.com")) {
    alert("Lance ce bookmarklet depuis moxfield.com.");
    return;
  }

  // ---------- récup du token JWT depuis localStorage/sessionStorage ----------
  // Moxfield (comme beaucoup de SPA) stocke un Bearer token et l'envoie en header
  // Authorization. credentials:'include' ne suffit donc pas. On scanne les storages
  // pour trouver une chaîne ressemblant à un JWT ("eyJ..."), ou un objet JSON qui
  // en contient une dans un champ token/access_token/etc.
  function findToken() {
    const isJwt = (s) => typeof s === "string" && /^eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(s);
    const tokenFields = ["access_token", "accessToken", "token", "jwt", "bearerToken", "authToken", "id_token", "idToken"];
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const val = storage.getItem(key);
        if (!val) continue;
        if (isJwt(val)) { console.log("[MoxTokens] token trouvé directement dans", storage === localStorage ? "localStorage" : "sessionStorage", "clé:", key); return val; }
        try {
          const obj = JSON.parse(val);
          if (!obj || typeof obj !== "object") continue;
          for (const f of tokenFields) {
            if (isJwt(obj[f])) { console.log("[MoxTokens] token trouvé dans", storage === localStorage ? "localStorage" : "sessionStorage", "clé:", key, "champ:", f); return obj[f]; }
          }
          // Recherche récursive 1 niveau (au cas où c'est nested)
          for (const k of Object.keys(obj)) {
            const sub = obj[k];
            if (sub && typeof sub === "object") {
              for (const f of tokenFields) {
                if (isJwt(sub[f])) { console.log("[MoxTokens] token trouvé dans", storage === localStorage ? "localStorage" : "sessionStorage", "clé:", key, "->", k, ".", f); return sub[f]; }
              }
            }
          }
        } catch {}
      }
    }
    return null;
  }

  const TOKEN = findToken();
  if (!TOKEN) {
    console.warn("[MoxTokens] aucun token JWT trouvé. Dump des clés stockées (sans les valeurs) :");
    const dump = (storage, label) => {
      const keys = [];
      for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
      console.warn(`[MoxTokens] ${label} (${keys.length} clés) :`, keys);
      // Aussi : pour chaque clé, longueur de la valeur et si ça ressemble à du JSON
      for (const k of keys) {
        const v = storage.getItem(k) || "";
        const preview = v.length > 80 ? v.slice(0, 80) + "…" : v;
        const looksJson = v.startsWith("{") || v.startsWith("[");
        console.warn(`  [${label}] "${k}" (${v.length} chars, json=${looksJson}) : ${preview}`);
      }
    };
    dump(localStorage, "localStorage");
    dump(sessionStorage, "sessionStorage");
    console.warn("[MoxTokens] document.cookie (HttpOnly invisibles) :", document.cookie || "(vide ou tout HttpOnly)");
  }

  function authedFetch(url, init = {}) {
    const headers = Object.assign({ "Accept": "application/json" }, init.headers || {});
    const tok = TOKEN || TOKEN_FROM_BOOTSTRAP;
    if (tok) headers["Authorization"] = "Bearer " + tok;
    return fetch(url, Object.assign({ credentials: "include" }, init, { headers }));
  }

  // Bootstrap : Moxfield appelle /v1/startup/authenticated en premier après login.
  // Ça pourrait poser/rafraîchir un cookie de session côté api2.moxfield.com (qui est un
  // sous-domaine différent de la page hôte) — sans ça, le cookie peut ne pas être
  // partagé entre www.moxfield.com et api2.moxfield.com.
  async function bootstrapSession() {
    try {
      const r = await authedFetch("https://api2.moxfield.com/v1/startup/authenticated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      console.log("[MoxTokens] bootstrap /v1/startup/authenticated :", r.status);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) {
          console.log("[MoxTokens] bootstrap réponse complète :", j);
          // Inspection des valeurs ressemblant à un token
          for (const k of Object.keys(j)) {
            const v = j[k];
            if (typeof v === "string") {
              console.log("[MoxTokens] bootstrap." + k + " (string, " + v.length + " chars) :", v.length > 60 ? v.slice(0, 60) + "…" : v);
            } else {
              console.log("[MoxTokens] bootstrap." + k + " (" + typeof v + ") :", Array.isArray(v) ? "array[" + v.length + "]" : v);
            }
          }
          // Champs typiques d'un token
          const candidate = j.token || j.accessToken || j.access_token || j.refresh || j.refreshToken || j.bearerToken || (j.user && j.user.token);
          if (typeof candidate === "string" && candidate.length > 20) {
            console.log("[MoxTokens] candidat token extrait de la réponse bootstrap (longueur " + candidate.length + ")");
            return candidate;
          }
        }
      }
    } catch (e) {
      console.warn("[MoxTokens] bootstrap échec :", e);
    }
    return null;
  }

  // ---------- stratégie 1 : /v3/decks récursif ----------
  let TOKEN_FROM_BOOTSTRAP = null;
  async function fetchViaApi() {
    // Tentative de bootstrap pour activer la session côté api2.moxfield.com
    TOKEN_FROM_BOOTSTRAP = await bootstrapSession();
    if (TOKEN_FROM_BOOTSTRAP) {
      // Si on a chopé un token via bootstrap, on l'utilise pour les calls suivants
      // (override de TOKEN qui était null)
    }
    const seen = new Set();
    const out = [];
    const folderQueue = [null]; // null = racine
    const visitedFolders = new Set();
    let apiCalls = 0;
    let firstResponseLogged = false;

    while (folderQueue.length) {
      const folderId = folderQueue.shift();
      if (folderId !== null) {
        if (visitedFolders.has(folderId)) continue;
        visitedFolders.add(folderId);
      }
      let page = 1;
      while (true) {
        apiCalls++;
        const params = new URLSearchParams({ pageSize: "100", pageNumber: String(page) });
        if (folderId) params.set("folderId", folderId);
        const url = "https://api2.moxfield.com/v3/decks?" + params.toString();
        const r = await authedFetch(url);
        if (!r.ok) {
          if (page === 1 && folderId === null) throw new Error("HTTP " + r.status);
          break;
        }
        const j = await r.json();
        if (!firstResponseLogged) {
          firstResponseLogged = true;
          console.log("[MoxTokens] première réponse /v3/decks (clés racine) :", Object.keys(j));
          console.log("[MoxTokens] première réponse /v3/decks (objet complet) :", j);
          console.log("[MoxTokens] totalResults =", j.totalResults, "totalPages =", j.totalPages, "pageSize =", j.pageSize);
        }

        // Collecte les decks — robuste face à plusieurs shapes possibles
        const deckArrays = [j.data, j.decks, j.items].filter(Array.isArray);
        for (const arr of deckArrays) {
          for (const d of arr) {
            // Skip si c'est en fait un sous-dossier (a un id mais pas un format ni un publicId valide)
            if (d.isFolder || d.folderType) {
              const fid = d.id || d.folderId;
              if (fid && !visitedFolders.has(fid)) folderQueue.push(fid);
              continue;
            }
            const id = d.publicId || d.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({
              publicId: id,
              name: d.name || "(sans nom)",
              format: d.format || "",
              lastUpdatedAtUtc: d.lastUpdatedAtUtc || "",
            });
          }
        }
        // Sous-dossiers explicites dans la réponse
        for (const f of (j.folders || j.subfolders || [])) {
          const fid = f.id || f.folderId;
          if (fid && !visitedFolders.has(fid)) folderQueue.push(fid);
        }

        const totalPages = j.totalPages || 1;
        if (page >= totalPages) break;
        page++;
        if (page > 50) break;
      }
    }
    return { decks: out, apiCalls, folders: visitedFolders.size };
  }

  // ---------- stratégie 1bis : /v2/decks/personal POST ----------
  async function fetchViaPersonalPost() {
    const seen = new Set();
    const out = [];
    let page = 1;
    while (true) {
      const r = await authedFetch("https://api2.moxfield.com/v2/decks/personal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNumber: page, pageSize: 100 }),
      });
      if (!r.ok) {
        if (page === 1) throw new Error("personal POST HTTP " + r.status);
        break;
      }
      const j = await r.json().catch(() => null);
      if (!j) break;
      if (page === 1) console.log("[MoxTokens] /v2/decks/personal réponse (clés) :", Object.keys(j));
      for (const d of (j.data || j.decks || [])) {
        const id = d.publicId || d.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          publicId: id,
          name: d.name || "(sans nom)",
          format: d.format || "",
          lastUpdatedAtUtc: d.lastUpdatedAtUtc || "",
        });
      }
      if (page >= (j.totalPages || 1) || !(j.data || j.decks || []).length) break;
      page++;
      if (page > 50) break;
    }
    return out;
  }

  // ---------- stratégie 2 (fallback) : DOM scrape avec auto-scroll ----------
  async function fetchViaDom() {
    const collect = () => {
      const m = new Map();
      document.querySelectorAll('a[href*="/decks/"]').forEach((a) => {
        const mm = a.getAttribute("href").match(/\/decks\/([A-Za-z0-9_-]{15,})(?:[/?#]|$)/);
        if (!mm) return;
        const id = mm[1];
        if (m.has(id)) return;
        const name = ((a.textContent || "").trim()) || "(sans nom)";
        m.set(id, { publicId: id, name, format: "", lastUpdatedAtUtc: "" });
      });
      return m;
    };
    let stable = 0, prev = 0, rounds = 0;
    while (stable < 3 && rounds < 80) {
      rounds++;
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 600));
      const c = collect().size;
      if (c === prev) stable++; else { stable = 0; prev = c; }
    }
    window.scrollTo(0, 0);
    return { decks: [...collect().values()], rounds };
  }

  // ---------- run ----------
  let result, method, errors = [];
  // 1) Tente /v3/decks
  try {
    const r = await fetchViaApi();
    result = r;
    method = "API /v3/decks (" + r.apiCalls + " appels, " + r.folders + " dossiers)";
  } catch (e) {
    errors.push("v3/decks : " + e.message);
    console.warn("[moxtokens] /v3/decks failed:", e);
  }
  // 2) Sinon : /v2/decks/personal POST
  if (!result) {
    try {
      const decks = await fetchViaPersonalPost();
      result = { decks };
      method = "API /v2/decks/personal POST";
    } catch (e) {
      errors.push("v2/decks/personal : " + e.message);
      console.warn("[moxtokens] /v2/decks/personal failed:", e);
    }
  }
  // 3) Sinon : DOM scrape
  if (!result) {
    try {
      const r = await fetchViaDom();
      result = r;
      method = "DOM scrape (" + r.rounds + " scroll ticks)";
    } catch (e) {
      errors.push("DOM : " + e.message);
    }
  }
  if (!result) {
    alert("MoxTokens : aucune stratégie n'a fonctionné.\n\n" + errors.join("\n"));
    return;
  }

  if (!result.decks.length) {
    alert("MoxTokens : aucun deck trouvé (méthode : " + method + ").");
    return;
  }

  const payload = JSON.stringify(result.decks);
  try {
    await navigator.clipboard.writeText(payload);
    alert(
      "MoxTokens : " + result.decks.length + " decks copiés.\n" +
      "Méthode : " + method + ".\n\n" +
      "Reviens sur MoxTokens et clique « Coller la liste »."
    );
  } catch (e) {
    const w = window.open("", "_blank");
    if (w) {
      w.document.write("<title>MoxTokens — " + result.decks.length + " decks</title><pre>" + payload.replace(/</g, "&lt;") + "</pre>");
    } else {
      alert("Clipboard refusé et popup bloquée. Active les popups pour moxfield.com.");
    }
  }
})();
