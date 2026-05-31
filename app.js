// MoxTokens — extrait les tokens de decks Moxfield publics.
//
// L'API Moxfield refuse les requêtes navigateur cross-origin (CORS + filtre User-Agent),
// donc tous les appels Moxfield passent par un Cloudflare Worker dédié (voir cloudflare-worker/).
// Scryfall, lui, est CORS-friendly : on l'appelle directement quand on a besoin d'images.

const PROXY = "https://moxtokens-proxy.froyer44000.workers.dev/?url=";
const MOX_API = "https://api2.moxfield.com";

const $ = (id) => document.getElementById(id);
const usernameEl = $("username");
const loadBtn = $("loadDecks");
const statusEl = $("status");
const decksSection = $("decksSection");
const decksList = $("decksList");
const extractBtn = $("extract");
const tokensSection = $("tokensSection");
const tokensGrid = $("tokensGrid");
const tokensCount = $("tokensCount");

let allDecks = [];

// ---------- persistance username ----------
const savedUser = localStorage.getItem("moxtokens.username");
if (savedUser) usernameEl.value = savedUser;

// ---------- helpers ----------
function setStatus(text, kind = "") {
  if (!text) { statusEl.hidden = true; statusEl.textContent = ""; return; }
  statusEl.hidden = false;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.innerHTML = text;
}

function busy(text) {
  setStatus(`<span class="spinner"></span>${text}`);
}

async function proxyFetch(moxPath) {
  const url = PROXY + encodeURIComponent(MOX_API + moxPath);
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Moxfield ${r.status} — ${body.slice(0, 200) || moxPath}`);
  }
  return r.json();
}

// ---------- 1. lister les decks d'un user ----------
async function loadAllDecks(username) {
  // L'endpoint /v2/users/{name}/decks est cassé (404) côté Moxfield depuis 2026.
  // On passe par le moteur de recherche /v2/decks/search?authorUserNames=... qui renvoie
  // le même format paginé (data[], totalPages, etc.) et n'a pas le bug.
  const out = [];
  let page = 1;
  while (true) {
    const data = await proxyFetch(`/v2/decks/search?pageSize=100&pageNumber=${page}&authorUserNames=${encodeURIComponent(username)}`);
    const rows = data.data || [];
    out.push(...rows);
    const total = data.totalPages || 1;
    if (page >= total || rows.length === 0) break;
    page++;
    if (page > 50) break; // garde-fou
  }
  return out;
}

function renderDecks(decks) {
  decksList.innerHTML = "";
  if (!decks.length) {
    decksList.innerHTML = `<p class="micro">Aucun deck public trouvé pour cet utilisateur.</p>`;
    extractBtn.disabled = true;
    return;
  }
  // tri : plus récent d'abord
  decks.sort((a, b) => (b.lastUpdatedAtUtc || "").localeCompare(a.lastUpdatedAtUtc || ""));
  for (const d of decks) {
    const id = d.publicId || d.id;
    if (!id) continue;
    const label = document.createElement("label");
    label.className = "deck";
    const fmt = (d.format || "—").toString();
    const updated = (d.lastUpdatedAtUtc || "").slice(0, 10);
    label.innerHTML = `
      <input type="checkbox" value="${id}" data-name="${escapeAttr(d.name || "(sans nom)")}" />
      <div class="deck-info">
        <div class="deck-name">${escapeHtml(d.name || "(sans nom)")}</div>
        <div class="deck-meta">${escapeHtml(fmt)}${updated ? " • maj " + updated : ""}</div>
      </div>
    `;
    decksList.appendChild(label);
  }
  extractBtn.disabled = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- 2. récupérer les decks + leurs cartes ----------
async function loadDeck(publicId) {
  return proxyFetch(`/v3/decks/all/${encodeURIComponent(publicId)}`);
}

function scryfallIdsFromDeck(deck) {
  // Récupère les scryfall_id de toutes les cartes de tous les boards (mainboard, sideboard, etc.)
  // Moxfield ne nous donne pas les tokens directement — il faut passer par Scryfall ensuite.
  const ids = new Set();
  for (const board of Object.values(deck.boards || {})) {
    if (!board || !board.cards) continue;
    for (const entry of Object.values(board.cards)) {
      const sid = entry && entry.card && entry.card.scryfall_id;
      if (sid) ids.add(sid);
    }
  }
  return [...ids];
}

// ---------- 3. Scryfall : bulk lookup + related-parts ----------
// /cards/collection accepte jusqu'à 75 identifiers par requête (POST JSON).
async function scryfallCollection(ids, onProgress) {
  const out = [];
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    const r = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
    });
    if (!r.ok) throw new Error(`Scryfall ${r.status}`);
    const data = await r.json();
    out.push(...(data.data || []));
    if (onProgress) onProgress(Math.min(i + 75, ids.length), ids.length);
    if (i + 75 < ids.length) await new Promise((res) => setTimeout(res, 100));
  }
  return out;
}

// Pour chaque carte récupérée, regarde all_parts[] : on garde les entrées component === "token"
// (ainsi que "combo_piece" qui est parfois utilisé pour des emblèmes / faces alt).
function tokenIdsFromCards(cards) {
  const ids = new Set();
  for (const c of cards) {
    if (!Array.isArray(c.all_parts)) continue;
    for (const p of c.all_parts) {
      if (!p.id || p.id === c.id) continue;
      if (p.component === "token") ids.add(p.id);
    }
  }
  return [...ids];
}

function tokenImage(t) {
  if (t.image_uris && t.image_uris.normal) return t.image_uris.normal;
  if (t.card_faces && t.card_faces[0] && t.card_faces[0].image_uris && t.card_faces[0].image_uris.normal) {
    return t.card_faces[0].image_uris.normal;
  }
  return null;
}

function renderTokens(tokens) {
  tokensGrid.innerHTML = "";
  tokensCount.textContent = tokens.length;
  if (!tokens.length) {
    tokensGrid.innerHTML = `<p class="micro">Aucun token trouvé dans les decks sélectionnés.</p>`;
    return;
  }
  // tri alpha par nom
  tokens.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  for (const t of tokens) {
    const card = document.createElement("div");
    card.className = "token";
    const img = tokenImage(t);
    const name = escapeHtml(t.name || "(token)");
    const sub = escapeHtml((t.type_line || t.colors_str || "").toString());
    card.innerHTML = `
      ${img
        ? `<img class="token-img" src="${img}" alt="${name}" loading="lazy" />`
        : `<div class="token-img placeholder">pas d'image</div>`}
      <div class="token-body">
        <div class="token-name">${name}</div>
        ${sub ? `<div class="token-sub">${sub}</div>` : ""}
      </div>
    `;
    tokensGrid.appendChild(card);
  }
}

// ---------- événements UI ----------
loadBtn.addEventListener("click", async () => {
  const username = usernameEl.value.trim();
  if (!username) { setStatus("Saisis un username Moxfield.", "error"); return; }
  localStorage.setItem("moxtokens.username", username);
  loadBtn.disabled = true;
  decksSection.hidden = true;
  tokensSection.hidden = true;
  try {
    busy(`Chargement des decks de <strong>${escapeHtml(username)}</strong>…`);
    allDecks = await loadAllDecks(username);
    setStatus(`${allDecks.length} deck${allDecks.length > 1 ? "s" : ""} public${allDecks.length > 1 ? "s" : ""} trouvé${allDecks.length > 1 ? "s" : ""}.`, "success");
    renderDecks(allDecks);
    decksSection.hidden = false;
  } catch (e) {
    setStatus(`Erreur : ${escapeHtml(e.message)}`, "error");
  } finally {
    loadBtn.disabled = false;
  }
});

$("selectAll").addEventListener("click", () => {
  decksList.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = true));
});
$("selectNone").addEventListener("click", () => {
  decksList.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = false));
});

extractBtn.addEventListener("click", async () => {
  const selected = [...decksList.querySelectorAll('input[type="checkbox"]:checked')];
  if (!selected.length) { setStatus("Coche au moins un deck.", "error"); return; }
  extractBtn.disabled = true;
  tokensSection.hidden = true;
  try {
    // 1) charger chaque deck via le proxy Moxfield et collecter les scryfall_id uniques
    const allCardIds = new Set();
    let i = 0;
    for (const cb of selected) {
      i++;
      busy(`Deck ${i}/${selected.length} : <em>${escapeHtml(cb.dataset.name || "")}</em>`);
      try {
        const deck = await loadDeck(cb.value);
        for (const id of scryfallIdsFromDeck(deck)) allCardIds.add(id);
      } catch (e) {
        console.warn("deck failed", cb.value, e);
      }
    }
    const cardIds = [...allCardIds];
    if (!cardIds.length) {
      setStatus("Aucune carte trouvée dans les decks sélectionnés.", "error");
      return;
    }

    // 2) Scryfall bulk : récup des cartes pour lire all_parts (related tokens)
    busy(`Scryfall : lecture de ${cardIds.length} cartes…`);
    const cards = await scryfallCollection(cardIds, (done, total) => {
      busy(`Scryfall : ${done}/${total} cartes lues…`);
    });

    // 3) extraire les scryfall_id de tous les tokens référencés
    const tokenIds = tokenIdsFromCards(cards);
    if (!tokenIds.length) {
      renderTokens([]);
      setStatus("Aucun token référencé par les cartes des decks sélectionnés.", "success");
      tokensSection.hidden = false;
      return;
    }

    // 4) Scryfall bulk : récup des tokens eux-mêmes (nom + image)
    busy(`Scryfall : récupération de ${tokenIds.length} tokens…`);
    const tokens = await scryfallCollection(tokenIds, (done, total) => {
      busy(`Scryfall : ${done}/${total} tokens lus…`);
    });

    renderTokens(tokens);
    setStatus(`${tokens.length} token${tokens.length > 1 ? "s uniques extraits" : " unique extrait"} depuis ${selected.length} deck${selected.length > 1 ? "s" : ""} (${cardIds.length} cartes analysées).`, "success");
    tokensSection.hidden = false;
  } catch (e) {
    setStatus(`Erreur : ${escapeHtml(e.message)}`, "error");
  } finally {
    extractBtn.disabled = false;
  }
});

$("copyNames").addEventListener("click", async () => {
  const names = [...tokensGrid.querySelectorAll(".token-name")].map((n) => n.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(names);
    setStatus("Noms copiés dans le presse-papier.", "success");
  } catch {
    setStatus("Impossible de copier (autorisation refusée).", "error");
  }
});
