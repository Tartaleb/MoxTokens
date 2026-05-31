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

// ---------- 2. extraire les tokens d'un deck ----------
async function loadDeck(publicId) {
  return proxyFetch(`/v3/decks/all/${encodeURIComponent(publicId)}`);
}

// Un token Moxfield/Scryfall a souvent : id (scryfall_id), name, type_line, image_uris.normal,
// card_faces[].image_uris.normal (pour double-face), oracle_id.
// On dédupe par "key" = oracle_id ou name + type_line.
function extractTokensFromDeck(deck) {
  const found = [];

  // Cas v3 : un board "tokens" listant déjà les tokens du deck
  const boards = deck.boards || {};
  const tokensBoard = boards.tokens;
  if (tokensBoard && tokensBoard.cards) {
    for (const entry of Object.values(tokensBoard.cards)) {
      if (entry && entry.card) found.push(entry.card);
    }
  }

  // Cas fallback : pour chaque carte de chaque board, lire card.tokens[]
  for (const [boardName, board] of Object.entries(boards)) {
    if (boardName === "tokens" || !board || !board.cards) continue;
    for (const entry of Object.values(board.cards)) {
      const card = entry && entry.card;
      if (!card) continue;
      if (Array.isArray(card.tokens)) {
        for (const t of card.tokens) found.push(t);
      }
    }
  }

  return found;
}

function tokenKey(t) {
  return t.oracle_id || t.scryfall_id || t.id || `${t.name}|${t.type_line || ""}`;
}

function tokenImage(t) {
  // Moxfield embarque souvent image_normal direct, ou image_uris.normal façon Scryfall
  if (t.image_normal) return t.image_normal;
  if (t.image_uris && t.image_uris.normal) return t.image_uris.normal;
  if (t.card_faces && t.card_faces[0] && t.card_faces[0].image_uris && t.card_faces[0].image_uris.normal) {
    return t.card_faces[0].image_uris.normal;
  }
  // Construire URL depuis Scryfall id
  const sid = t.scryfall_id || t.id;
  if (sid && /^[0-9a-f-]{36}$/i.test(sid)) {
    return `https://api.scryfall.com/cards/${sid}?format=image&version=normal`;
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
    busy(`Extraction des tokens de ${selected.length} deck${selected.length > 1 ? "s" : ""}…`);
    const all = [];
    let i = 0;
    for (const cb of selected) {
      i++;
      busy(`Deck ${i}/${selected.length} : <em>${escapeHtml(cb.dataset.name || "")}</em>`);
      try {
        const deck = await loadDeck(cb.value);
        all.push(...extractTokensFromDeck(deck));
      } catch (e) {
        console.warn("deck failed", cb.value, e);
      }
    }
    // dédupe
    const map = new Map();
    for (const t of all) {
      const k = tokenKey(t);
      if (!map.has(k)) map.set(k, t);
    }
    const uniq = [...map.values()];
    renderTokens(uniq);
    setStatus(`${uniq.length} token${uniq.length > 1 ? "s uniques extraits" : " unique extrait"} depuis ${selected.length} deck${selected.length > 1 ? "s" : ""}.`, "success");
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
