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
const boardsChoice = $("boardsChoice");
const formatFilter = $("formatFilter");
const dateFilter = $("dateFilter");
const dateFilterClear = $("dateFilterClear");
const decksVisibleCount = $("decksVisibleCount");
const extractListBtn = $("extractList");
const extractImagesBtn = $("extractImages");
const resultSection = $("resultSection");
const resultTitle = $("resultTitle");
const resultCount = $("resultCount");
const resultBody = $("resultBody");

// Ordre d'affichage des sections dans la sortie "liste de noms"
const BOARD_ORDER = ["commanders", "mainboard", "sideboard", "maybeboard"];
const BOARD_LABELS = {
  commanders: "Commanders",
  mainboard: "Mainboard",
  sideboard: "Sideboard",
  maybeboard: "Maybeboard",
  tokens: "Tokens",
};

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

// État des cases à cocher conservé entre re-rendus du filtre
const checkedDeckIds = new Set();
// Formats actuellement actifs (cochés dans le filtre). null = tout afficher (état initial).
let activeFormats = null;

function renderFormatFilter(decks) {
  formatFilter.innerHTML = "";
  const counts = new Map();
  for (const d of decks) {
    const f = (d.format || "—").toString();
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  const formats = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (activeFormats === null) activeFormats = new Set(formats.map(([f]) => f));
  for (const [f, n] of formats) {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox" value="${escapeAttr(f)}" ${activeFormats.has(f) ? "checked" : ""} /><span>${escapeHtml(f)} (${n})</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) activeFormats.add(f); else activeFormats.delete(f);
      renderDecks(allDecks);
    });
    formatFilter.appendChild(label);
  }
}

function renderDecks(decks) {
  decksList.innerHTML = "";
  if (!decks.length) {
    decksList.innerHTML = `<p class="micro">Aucun deck public trouvé pour cet utilisateur.</p>`;
    decksVisibleCount.textContent = "";
    extractListBtn.disabled = true;
    extractImagesBtn.disabled = true;
    return;
  }
  // tri : plus récent d'abord
  const sorted = [...decks].sort((a, b) => (b.lastUpdatedAtUtc || "").localeCompare(a.lastUpdatedAtUtc || ""));
  const dateMin = dateFilter.value; // "YYYY-MM-DD" ou ""
  const filtered = sorted.filter((d) => {
    if (activeFormats !== null && !activeFormats.has((d.format || "—").toString())) return false;
    if (dateMin) {
      const updated = (d.lastUpdatedAtUtc || "").slice(0, 10);
      if (!updated || updated < dateMin) return false;
    }
    return true;
  });
  decksVisibleCount.textContent = filtered.length === decks.length ? decks.length : `${filtered.length} / ${decks.length}`;

  if (!filtered.length) {
    decksList.innerHTML = `<p class="micro">Aucun deck pour les formats cochés.</p>`;
  } else {
    for (const d of filtered) {
      const id = d.publicId || d.id;
      if (!id) continue;
      const label = document.createElement("label");
      label.className = "deck";
      const fmt = (d.format || "—").toString();
      const updated = (d.lastUpdatedAtUtc || "").slice(0, 10);
      label.innerHTML = `
        <input type="checkbox" value="${id}" data-name="${escapeAttr(d.name || "(sans nom)")}" ${checkedDeckIds.has(id) ? "checked" : ""} />
        <div class="deck-info">
          <div class="deck-name">${escapeHtml(d.name || "(sans nom)")}</div>
          <div class="deck-meta">${escapeHtml(fmt)}${updated ? " • maj " + updated : ""}</div>
        </div>
      `;
      const cb = label.querySelector("input");
      cb.addEventListener("change", () => {
        if (cb.checked) checkedDeckIds.add(id); else checkedDeckIds.delete(id);
      });
      decksList.appendChild(label);
    }
  }
  extractListBtn.disabled = false;
  extractImagesBtn.disabled = false;
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

function cardImage(c) {
  if (c.image_uris && c.image_uris.normal) return c.image_uris.normal;
  if (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris && c.card_faces[0].image_uris.normal) {
    return c.card_faces[0].image_uris.normal;
  }
  return null;
}

// Lit les cartes d'un board Moxfield (mainboard, sideboard, etc.) → array {name, quantity, scryfall_id}
function cardsFromBoard(deck, boardName) {
  const board = (deck.boards || {})[boardName];
  if (!board || !board.cards) return [];
  const out = [];
  for (const entry of Object.values(board.cards)) {
    const c = entry && entry.card;
    if (!c) continue;
    out.push({ name: c.name, quantity: entry.quantity || 1, scryfall_id: c.scryfall_id });
  }
  return out;
}

function selectedBoards() {
  return [...boardsChoice.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
}
// Renvoie la liste des decks cochés (depuis l'état persistant, pas seulement le DOM visible)
// pour que la sélection survive aux re-rendus du filtre par format.
function selectedDeckCheckboxes() {
  return [...checkedDeckIds].map((id) => {
    const d = allDecks.find((x) => (x.publicId || x.id) === id);
    return { value: id, dataset: { name: (d && d.name) || "(sans nom)" } };
  });
}

// Rendu : grille d'illustrations
function renderImages(cards, title) {
  resultTitle.firstChild.textContent = title + " ";
  resultCount.textContent = cards.length;
  resultBody.innerHTML = "";
  if (!cards.length) {
    resultBody.innerHTML = `<p class="micro">Rien à afficher.</p>`;
    return;
  }
  cards.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const grid = document.createElement("div");
  grid.className = "tokens";
  for (const c of cards) {
    const el = document.createElement("div");
    el.className = "token";
    const img = cardImage(c);
    const name = escapeHtml(c.name || "(carte)");
    const sub = escapeHtml((c.type_line || "").toString());
    el.innerHTML = `
      ${img
        ? `<img class="token-img" src="${img}" alt="${name}" loading="lazy" />`
        : `<div class="token-img placeholder">pas d'image</div>`}
      <div class="token-body">
        <div class="token-name">${name}</div>
        ${sub ? `<div class="token-sub">${sub}</div>` : ""}
      </div>
    `;
    grid.appendChild(el);
  }
  resultBody.appendChild(grid);
}

// Rendu : liste plain text au format MTGA/Moxfield "QTY NOM", groupée par board, triée alpha.
function renderNameList(sections) {
  // sections : { boardName: Map<name, qty> } dans l'ordre BOARD_ORDER puis tokens
  const lines = [];
  let totalLines = 0;
  let totalCards = 0;
  const order = [...BOARD_ORDER, "tokens"];
  for (const b of order) {
    const m = sections[b];
    if (!m || !m.size) continue;
    const entries = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const boardTotal = entries.reduce((s, [, q]) => s + q, 0);
    if (lines.length) lines.push("");
    lines.push(`== ${BOARD_LABELS[b] || b} (${entries.length} cartes, ${boardTotal} ex.) ==`);
    for (const [name, qty] of entries) lines.push(`${qty} ${name}`);
    totalLines += entries.length;
    totalCards += boardTotal;
  }
  resultTitle.firstChild.textContent = "Liste ";
  resultCount.textContent = `${totalLines} (${totalCards} ex.)`;
  resultBody.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "namelist";
  pre.textContent = lines.length ? lines.join("\n") : "(vide)";
  resultBody.appendChild(pre);
}

// ---------- événements UI ----------
loadBtn.addEventListener("click", async () => {
  const username = usernameEl.value.trim();
  if (!username) { setStatus("Saisis un username Moxfield.", "error"); return; }
  localStorage.setItem("moxtokens.username", username);
  loadBtn.disabled = true;
  decksSection.hidden = true;
  resultSection.hidden = true;
  // reset entre deux chargements
  checkedDeckIds.clear();
  activeFormats = null;
  try {
    busy(`Chargement des decks de <strong>${escapeHtml(username)}</strong>…`);
    allDecks = await loadAllDecks(username);
    setStatus(`${allDecks.length} deck${allDecks.length > 1 ? "s" : ""} public${allDecks.length > 1 ? "s" : ""} trouvé${allDecks.length > 1 ? "s" : ""}.`, "success");
    renderFormatFilter(allDecks);
    renderDecks(allDecks);
    decksSection.hidden = false;
  } catch (e) {
    setStatus(`Erreur : ${escapeHtml(e.message)}`, "error");
  } finally {
    loadBtn.disabled = false;
  }
});

// Le filtre date re-rend la liste à chaque changement
dateFilter.addEventListener("change", () => renderDecks(allDecks));
dateFilterClear.addEventListener("click", () => { dateFilter.value = ""; renderDecks(allDecks); });

// "Tout cocher / décocher" agit sur les decks actuellement VISIBLES (filtre respecté)
$("selectAll").addEventListener("click", () => {
  decksList.querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.checked = true;
    checkedDeckIds.add(c.value);
  });
});
$("selectNone").addEventListener("click", () => {
  decksList.querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.checked = false;
    checkedDeckIds.delete(c.value);
  });
});

// Charge tous les decks sélectionnés (avec progress feedback) → array de deck JSON Moxfield
async function loadSelectedDecks(deckCheckboxes) {
  const decks = [];
  let i = 0;
  for (const cb of deckCheckboxes) {
    i++;
    busy(`Deck ${i}/${deckCheckboxes.length} : <em>${escapeHtml(cb.dataset.name || "")}</em>`);
    try {
      decks.push(await loadDeck(cb.value));
    } catch (e) {
      console.warn("deck failed", cb.value, e);
    }
  }
  return decks;
}

// Pour les boards Moxfield directs : collecte les noms uniques par board sur tous les decks.
// Pour "tokens" : lance le pipeline Scryfall (lecture des cartes des boards Moxfield cochés,
// extraction all_parts, fetch des tokens) et renvoie les noms.
// Renvoie { boardName: Map<name, totalQuantity> } pour les boards Moxfield,
// et pour "tokens" une Map<name, 1> (1 exemplaire de chaque token type).
async function collectByBoard(decks, boards) {
  const sections = {};
  const moxBoards = boards.filter((b) => b !== "tokens");
  for (const b of moxBoards) {
    const m = new Map();
    for (const d of decks) {
      for (const c of cardsFromBoard(d, b)) {
        if (!c.name) continue;
        m.set(c.name, (m.get(c.name) || 0) + c.quantity);
      }
    }
    sections[b] = m;
  }
  if (boards.includes("tokens")) {
    const tokens = await fetchTokens(decks, moxBoards.length ? moxBoards : ["mainboard", "commanders", "sideboard"]);
    const m = new Map();
    for (const t of tokens) if (t.name) m.set(t.name, 1);
    sections.tokens = m;
  }
  return sections;
}

// Pipeline Scryfall : depuis les cartes des boards donnés, trouve et fetche les tokens créés.
async function fetchTokens(decks, sourceBoards) {
  const cardIds = new Set();
  for (const d of decks) {
    for (const b of sourceBoards) {
      for (const c of cardsFromBoard(d, b)) {
        if (c.scryfall_id) cardIds.add(c.scryfall_id);
      }
    }
  }
  if (!cardIds.size) return [];
  busy(`Scryfall : lecture de ${cardIds.size} cartes…`);
  const cards = await scryfallCollection([...cardIds], (done, total) =>
    busy(`Scryfall : ${done}/${total} cartes lues…`));
  const tokenIds = tokenIdsFromCards(cards);
  if (!tokenIds.length) return [];
  busy(`Scryfall : récupération de ${tokenIds.length} tokens…`);
  return scryfallCollection(tokenIds, (done, total) =>
    busy(`Scryfall : ${done}/${total} tokens lus…`));
}

async function runExtract(mode) {
  const decksSel = selectedDeckCheckboxes();
  const boards = selectedBoards();
  if (!decksSel.length) { setStatus("Coche au moins un deck.", "error"); return; }
  if (!boards.length) { setStatus("Coche au moins un type de carte à inclure.", "error"); return; }

  extractListBtn.disabled = true;
  extractImagesBtn.disabled = true;
  resultSection.hidden = true;

  try {
    const decks = await loadSelectedDecks(decksSel);

    if (mode === "list") {
      const sections = await collectByBoard(decks, boards);
      renderNameList(sections);
    } else {
      // mode "images" : on rassemble toutes les cartes/tokens en un seul flux pour la grille
      const moxBoards = boards.filter((b) => b !== "tokens");
      const wantedIds = new Set();
      for (const b of moxBoards) {
        for (const d of decks) {
          for (const c of cardsFromBoard(d, b)) {
            if (c.scryfall_id) wantedIds.add(c.scryfall_id);
          }
        }
      }
      const allCards = [];
      if (wantedIds.size) {
        busy(`Scryfall : lecture de ${wantedIds.size} cartes pour images…`);
        const fetched = await scryfallCollection([...wantedIds], (done, total) =>
          busy(`Scryfall : ${done}/${total} cartes lues…`));
        allCards.push(...fetched);
      }
      if (boards.includes("tokens")) {
        const tokens = await fetchTokens(decks, moxBoards.length ? moxBoards : ["mainboard", "commanders", "sideboard"]);
        allCards.push(...tokens);
      }
      // dédupe par scryfall id
      const byId = new Map();
      for (const c of allCards) if (c.id && !byId.has(c.id)) byId.set(c.id, c);
      renderImages([...byId.values()], "Illustrations");
    }

    setStatus(`Extraction terminée sur ${decksSel.length} deck${decksSel.length > 1 ? "s" : ""}.`, "success");
    resultSection.hidden = false;
  } catch (e) {
    setStatus(`Erreur : ${escapeHtml(e.message)}`, "error");
  } finally {
    extractListBtn.disabled = false;
    extractImagesBtn.disabled = false;
  }
}

extractListBtn.addEventListener("click", () => runExtract("list"));
extractImagesBtn.addEventListener("click", () => runExtract("images"));

$("copyNames").addEventListener("click", async () => {
  // Si on est en mode liste, copier le <pre> texte brut. Sinon, extraire les noms de la grille.
  const pre = resultBody.querySelector("pre.namelist");
  const text = pre
    ? pre.textContent
    : [...resultBody.querySelectorAll(".token-name")].map((n) => n.textContent).join("\n");
  if (!text) { setStatus("Rien à copier.", "error"); return; }
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copié dans le presse-papier.", "success");
  } catch {
    setStatus("Impossible de copier (autorisation refusée).", "error");
  }
});
