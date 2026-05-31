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
    console.warn("[MoxTokens] aucun token JWT trouvé dans localStorage/sessionStorage. Vérifie que tu es bien connecté à moxfield.com.");
  }

  function authedFetch(url) {
    const headers = { "Accept": "application/json" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    return fetch(url, { credentials: "include", headers });
  }

  // ---------- stratégie 1 : /v3/decks récursif ----------
  async function fetchViaApi() {
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
  let result, method;
  try {
    const r = await fetchViaApi();
    result = r;
    method = "API /v3/decks (" + r.apiCalls + " appels, " + r.folders + " dossiers)";
  } catch (e) {
    console.warn("[moxtokens] API failed:", e);
    try {
      const r = await fetchViaDom();
      result = r;
      method = "DOM scrape (" + r.rounds + " scroll ticks)";
    } catch (e2) {
      alert("MoxTokens : impossible de récupérer la liste.\nAPI : " + e.message + "\nDOM : " + e2.message);
      return;
    }
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
