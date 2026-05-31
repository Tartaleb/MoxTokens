// Source lisible du bookmarklet MoxTokens.
// app.js charge ce fichier au démarrage et l'injecte dans le href du lien #bookmarklet.
//
// Stratégie : DOM scraping de la page "Mes decks" de moxfield.com.
// L'API publique (et même /v2/decks/search authentifié) caps à 62 decks,
// alors qu'un user peut en avoir bien plus (130+ testé). La page web, elle,
// affiche TOUT — donc on extrait depuis le DOM.
//
// Auto-scroll jusqu'à ce que le nombre de liens /decks/ n'augmente plus,
// puis collecte chaque publicId + nom visible. Format/date sont enrichis
// côté app MoxTokens via /v3/decks/all/{id} après le paste.

(async function () {
  if (!location.host.endsWith("moxfield.com")) {
    alert("Lance ce bookmarklet depuis moxfield.com (idéalement /decks/personal).");
    return;
  }

  const isPersonal = location.pathname.toLowerCase().includes("/decks/personal");
  if (!isPersonal) {
    if (!confirm("Tu n'es pas sur /decks/personal — la collecte risque d'être incomplète.\n\nContinuer quand même ?")) return;
  }

  const collectLinks = () => {
    const out = new Map();
    document.querySelectorAll('a[href*="/decks/"]').forEach((a) => {
      // /decks/<base64ish, 22 chars typique> — on rejette les URLs trop courtes (catégories)
      const m = a.getAttribute("href").match(/\/decks\/([A-Za-z0-9_-]{15,})(?:[/?#]|$)/);
      if (!m) return;
      const id = m[1];
      if (out.has(id)) return;
      // Nom : texte du lien, ou h3/h4 le plus proche
      const txt = (a.textContent || "").trim();
      let name = txt && txt.length > 1 ? txt : "";
      if (!name) {
        const card = a.closest("article, [class*='deck-card'], [class*='DeckCard'], [class*='card']") || a.parentElement;
        const h = card && card.querySelector("h1, h2, h3, h4, [class*='name'], [class*='title']");
        if (h) name = (h.textContent || "").trim();
      }
      out.set(id, { publicId: id, name: name || "(sans nom)" });
    });
    return out;
  };

  // Auto-scroll : on descend, on attend, on remesure. Stable = 3 ticks sans nouveau.
  let stable = 0;
  let prev = 0;
  let rounds = 0;
  while (stable < 3 && rounds < 80) {
    rounds++;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 600));
    const count = collectLinks().size;
    if (count === prev) stable++;
    else { stable = 0; prev = count; }
  }
  // Remonte en haut pour ne pas perturber l'utilisateur
  window.scrollTo(0, 0);

  const map = collectLinks();
  const list = [...map.values()];

  if (!list.length) {
    alert("Aucun deck trouvé dans la page. Vérifie que tu es bien sur /decks/personal et connecté.");
    return;
  }

  const payload = JSON.stringify(list);
  try {
    await navigator.clipboard.writeText(payload);
    alert(
      "MoxTokens : " + list.length + " decks copiés (auto-scroll " + rounds + " ticks).\n\n" +
      "Reviens sur MoxTokens et clique « Coller la liste ».\n" +
      "Format/date seront enrichis automatiquement (1 appel API par deck)."
    );
  } catch (e) {
    const w = window.open("", "_blank");
    if (w) {
      w.document.write("<title>MoxTokens — " + list.length + " decks</title><pre>" + payload.replace(/</g, "&lt;") + "</pre>");
    } else {
      alert("Clipboard refusé et popup bloquée. Active les popups pour moxfield.com.");
    }
  }
})();
