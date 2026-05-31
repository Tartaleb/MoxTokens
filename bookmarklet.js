// Source lisible du bookmarklet MoxTokens.
// Le fichier app.js minifie ce code et l'injecte dans le href du lien #bookmarklet
// au chargement de la page.
//
// Ce code tourne dans le contexte de www.moxfield.com (origin), donc :
//   - fetch() vers api2.moxfield.com avec credentials:'include' envoie le cookie de session
//     → la requête est authentifiée comme l'utilisateur connecté
//   - on contourne ainsi le cap des ~62 decks de l'API publique non auth
//
// Stratégies tentées dans l'ordre, résultats fusionnés par publicId :
//   1) /v2/decks/search?authorUserNames=<user>&pageSize=100 (avec auth)
//   2) /v2/decks/personal POST (endpoint "mes decks", existe en 405 sans auth)
//
// Sortie : JSON [{publicId,name,format,lastUpdatedAtUtc}, ...] copié dans le presse-papier.

(async function () {
  if (!location.host.endsWith("moxfield.com")) {
    alert("Le bookmarklet MoxTokens doit être lancé depuis une page moxfield.com.");
    return;
  }

  const username = prompt("Username Moxfield :");
  if (!username) return;

  const seen = new Set();
  const out = [];
  const add = (d) => {
    const id = d.publicId || d.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      publicId: id,
      name: d.name || "(sans nom)",
      format: d.format || "—",
      lastUpdatedAtUtc: d.lastUpdatedAtUtc || "",
    });
  };

  let strat1 = 0, strat2 = 0, lastTotal = 0;

  // Stratégie 1 : search authentifié paginé
  try {
    let page = 1;
    while (true) {
      const url = "https://api2.moxfield.com/v2/decks/search"
        + "?authorUserNames=" + encodeURIComponent(username)
        + "&pageSize=100&pageNumber=" + page
        + "&sortType=updated&sortDirection=descending";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) break;
      const j = await r.json();
      lastTotal = j.totalResults || lastTotal;
      const before = out.length;
      for (const d of (j.data || [])) add(d);
      strat1 += (out.length - before);
      if (page >= (j.totalPages || 1) || !(j.data || []).length) break;
      page++;
      if (page > 50) break;
    }
  } catch (e) { console.warn("[moxtokens] strat1", e); }

  // Stratégie 2 : /v2/decks/personal POST (endpoint "mes decks", auth-only)
  try {
    let page = 1;
    while (true) {
      const r = await fetch("https://api2.moxfield.com/v2/decks/personal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNumber: page, pageSize: 100 }),
      });
      if (!r.ok) break;
      const j = await r.json();
      const before = out.length;
      for (const d of (j.data || [])) add(d);
      strat2 += (out.length - before);
      if (page >= (j.totalPages || 1) || !(j.data || []).length) break;
      page++;
      if (page > 50) break;
    }
  } catch (e) { console.warn("[moxtokens] strat2", e); }

  try {
    await navigator.clipboard.writeText(JSON.stringify(out));
    alert(
      "MoxTokens : " + out.length + " decks copiés.\n" +
      "(search auth : " + strat1 + " nouveaux / personal : " + strat2 + " nouveaux / cap public API : " + lastTotal + ")\n\n" +
      "Reviens sur MoxTokens et clique « Coller la liste »."
    );
  } catch (e) {
    // Fallback si clipboard refusé : ouvre une fenêtre avec le JSON à copier à la main
    const w = window.open("", "_blank");
    if (w) {
      w.document.write("<pre>" + JSON.stringify(out, null, 2) + "</pre>");
      w.document.title = "MoxTokens — " + out.length + " decks";
    } else {
      alert("Clipboard refusé et popup bloquée. Active les popups pour moxfield.com et réessaye.");
    }
  }
})();
