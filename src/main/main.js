const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const OpenAI = require('openai');
const { Jomini } = require('jomini');

let mainWindow;
let openaiClient = null;
let apiKeyFromEnv = false;
let jominiParser = null;

// Auto-save monitoring state
let currentAutoSave = null;
let saveWatcher = null;
let watchedFolder = null;
let saveDebounceTimer = null;

// ─── Load API Key from .env ───────────────────────────────────────────────────
function loadEnvApiKey() {
  const envPath = path.join(__dirname, '../../.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^OPENAI_API_KEY=(.+)$/);
      if (match) {
        const key = match[1].trim();
        if (key) { openaiClient = new OpenAI({ apiKey: key }); apiKeyFromEnv = true; return; }
      }
    }
  } catch (e) { /* no .env — user sets key manually */ }
}

loadEnvApiKey();

// ─── Jomini Lazy Init ─────────────────────────────────────────────────────────
async function getParser() {
  if (!jominiParser) jominiParser = await Jomini.initialize();
  return jominiParser;
}

// ─── Save Folder Scanner ──────────────────────────────────────────────────────
function findLatestSav(folder) {
  let latest = null;
  let latestMtime = 0;
  function scan(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); }
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sav')) {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > latestMtime) { latestMtime = mtime; latest = { filePath: full, mtime }; }
        }
      }
    } catch (e) { /* skip unreadable */ }
  }
  scan(folder);
  return latest;
}

async function loadLatestSave(folder) {
  const found = findLatestSav(folder);
  if (!found) return { success: false, error: 'No .sav files found in folder.' };
  try {
    const zip = new AdmZip(found.filePath);
    const gamestateRaw = zip.readAsText('gamestate');
    const metaRaw = zip.readAsText('meta');
    const extracted = await parseAndExtract(gamestateRaw, metaRaw, path.basename(found.filePath));
    return { success: true, fileName: path.basename(found.filePath), filePath: found.filePath, updatedAt: found.mtime, ...extracted };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function startWatching(folder) {
  if (saveWatcher) { saveWatcher.close(); saveWatcher = null; }
  if (!fs.existsSync(folder)) return false;
  watchedFolder = folder;
  currentAutoSave = await loadLatestSave(folder);
  saveWatcher = fs.watch(folder, { recursive: true }, (eventType, filename) => {
    if (!filename || !filename.toLowerCase().endsWith('.sav')) return;
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
      const newSave = await loadLatestSave(folder);
      if (newSave?.success) {
        currentAutoSave = newSave;
        if (mainWindow) mainWindow.webContents.send('auto-save-updated', newSave);
      }
    }, 2000);
  });
  return true;
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#2563eb', height: 32 },
    backgroundColor: '#f0f4fc',
    icon: path.join(__dirname, '../../public/icon.png')
  });
  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  const defaultFolder = path.join(app.getPath('documents'), 'Paradox Interactive', 'Stellaris', 'save games');
  await startWatching(defaultFolder);
});

app.on('window-all-closed', () => {
  if (saveWatcher) saveWatcher.close();
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('check-api-key', async () => ({ connected: openaiClient !== null, fromEnv: apiKeyFromEnv }));

ipcMain.handle('set-api-key', async (_, apiKey) => {
  try {
    openaiClient = new OpenAI({ apiKey });
    await openaiClient.models.list();
    return { success: true };
  } catch (err) { openaiClient = null; return { success: false, error: err.message }; }
});

ipcMain.handle('get-auto-save', async () => ({ save: currentAutoSave, folder: watchedFolder }));

ipcMain.handle('select-save-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Select Stellaris Save Games Folder', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const folder = result.filePaths[0];
  try {
    const ok = await startWatching(folder);
    if (!ok) return { success: false, error: 'Folder not found or inaccessible.' };
    return { success: true, save: currentAutoSave, folder: watchedFolder };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('open-save-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Stellaris Save File',
    filters: [{ name: 'Stellaris Save', extensions: ['sav'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  try {
    const filePath = result.filePaths[0];
    const zip = new AdmZip(filePath);
    const gamestateRaw = zip.readAsText('gamestate');
    const metaRaw = zip.readAsText('meta');
    const extracted = await parseAndExtract(gamestateRaw, metaRaw, path.basename(filePath));
    return { success: true, fileName: path.basename(filePath), ...extracted };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('chat', async (_, { messages, gameContext }) => {
  if (!openaiClient) return { error: 'No API key set.' };
  try {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: buildSystemPrompt(gameContext) }, ...messages],
      temperature: 0.7,
      max_tokens: 1024
    });
    return { reply: response.choices[0].message.content };
  } catch (err) { return { error: err.message }; }
});

// ─── PDX Parsing via Jomini ───────────────────────────────────────────────────

/** Format a JS Date (or date string) from jomini back to Stellaris "YYYY.MM.DD" */
function fmtDate(d) {
  if (!d) return 'Unknown';
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }
  return String(d).replace('T00:00:00.000Z', '').replace(/-/g, '.');
}

/** Resolve a PDX name object {key, literal, variables} to a human string. */
function resolveName(nameObj) {
  if (!nameObj) return null;
  if (typeof nameObj === 'string') return nameObj || null;
  const key = nameObj.key;
  if (!key) return null;
  if (nameObj.literal) return key;
  if (key.startsWith('NAME_')) return key.slice(5).replace(/_/g, ' ');
  if (key.startsWith('SPEC_')) return key.slice(5).replace(/_pl$/, '').replace(/_/g, ' ');
  if (key.startsWith('PRESCRIPTED_species_name_')) return key.slice(25).replace(/_/g, ' ');
  if (key.startsWith('PRESCRIPTED_')) return key.slice(12).replace(/_/g, ' ');
  // For format keys (e.g. %ADJ%, war_vs_adjectives) try to build from variables
  if (nameObj.variables?.length) {
    const parts = nameObj.variables
      .map(v => v?.value ? resolveLeaf(v.value) : null)
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (key.startsWith('%')) return null;
  return key.replace(/_/g, ' ');
}

/** Leaf resolver — two levels deep to handle compound names like "Committee of Scientific Scholars" */
function resolveLeaf(nameObj) {
  if (!nameObj) return null;
  if (typeof nameObj === 'string') return nameObj || null;
  const key = nameObj.key;
  if (!key) return null;
  if (nameObj.literal) return key;
  if (key.startsWith('NAME_')) return key.slice(5).replace(/_/g, ' ');
  if (key.startsWith('SPEC_')) return key.slice(5).replace(/_pl$/, '').replace(/_/g, ' ');
  if (key.startsWith('PRESCRIPTED_')) return key.slice(12).replace(/_/g, ' ');
  if (nameObj.variables?.length) {
    const parts = nameObj.variables
      .map(v => v?.value ? resolveLeaf(v.value) : null)
      .filter(Boolean);
    // If key is a plain word (not a format placeholder), prepend it
    const prefix = (!key.startsWith('%') && !key.includes('_')) ? key : null;
    return [prefix, ...parts].filter(Boolean).join(' ');
  }
  if (key.startsWith('%')) return null;
  return key.replace(/_/g, ' ');
}

/** Safely coerce a value to an array. */
function toArr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Build a countryId → name map from the countries block. */
function buildNameMap(countries) {
  const map = {};
  for (const [id, c] of Object.entries(countries ?? {})) {
    if (!c || typeof c !== 'object') continue;
    const n = resolveName(c.name);
    if (n) map[id] = n;
  }
  return map;
}

/**
 * Main entry point: parse a gamestate string with Jomini, extract all data.
 * Returns { parsed, meta, diplomacy, systems, colonies, factions }
 */
async function parseAndExtract(gamestateRaw, metaRaw, fileName) {
  const parser = await getParser();

  const gs = parser.parseText(Buffer.from(gamestateRaw));

  // Player country id
  const playerCountryId = String(gs.player?.[0]?.country ?? 1);
  const pc = gs.country?.[playerCountryId] ?? {};
  const countries = gs.country ?? {};
  const nameMap = buildNameMap(countries);

  const parsed    = extractParsed(gs, playerCountryId, pc, nameMap);
  const diplomacy = extractDiplomacy(gs, playerCountryId, pc, countries, nameMap, parsed._warParticipants);
  const systems   = extractSystems(gs, playerCountryId, nameMap);
  const colonies  = extractColonies(gs, playerCountryId);
  const factions  = extractFactions(gs, playerCountryId);

  // Clean internal fields before returning
  delete parsed._warParticipants;

  // meta
  let meta = { date: parsed.date, saveName: fileName || 'Unknown' };
  try {
    const m = parser.parseText(Buffer.from(metaRaw));
    meta = { date: fmtDate(m.date) || parsed.date, saveName: resolveName(m.name) || fileName || 'Unknown' };
  } catch (e) { /* meta parse optional */ }

  return { parsed, meta, diplomacy, systems, colonies, factions };
}

// ─── Extraction Helpers ───────────────────────────────────────────────────────

function extractParsed(gs, playerCountryId, pc, nameMap) {
  const date = fmtDate(gs.date);
  const playerName = nameMap[playerCountryId] || 'Unknown Empire';

  // Resources: sum all categories in last_month.balance for monthly net income
  const resources = {};
  const bal = pc.budget?.last_month?.balance ?? {};
  const totals = {};
  for (const vals of Object.values(bal)) {
    if (vals && typeof vals === 'object') {
      for (const [res, val] of Object.entries(vals)) {
        totals[res] = (totals[res] || 0) + (typeof val === 'number' ? val : 0);
      }
    }
  }
  for (const k of ['energy','minerals','food','alloys','consumer_goods','influence','unity','physics_research','society_research','engineering_research']) {
    if (totals[k] !== undefined) resources[k] = Math.round(totals[k]);
  }

  // Wars
  const warParticipants = {}; // cid -> Set of war names
  const wars = [];
  for (const [wid, w] of Object.entries(gs.war ?? {})) {
    if (!w || typeof w !== 'object' || !w.name) continue;
    const name = resolveName(w.name) || `War ${wid}`;
    const attackers = toArr(w.attackers).map(a => String(a.country)).filter(Boolean);
    const defenders = toArr(w.defenders).map(d => String(d.country)).filter(Boolean);
    wars.push({ name, attacker: attackers[0] || '?', defender: defenders[0] || '?' });
    for (const cid of [...attackers, ...defenders]) {
      if (!warParticipants[cid]) warParticipants[cid] = new Set();
      warParticipants[cid].add(name);
    }
  }

  // Fleet count: owned_fleets entries that are not stations
  const ownedFleetRefs = toArr(pc.fleets_manager?.owned_fleets);
  let fleetCount = 0;
  for (const ref of ownedFleetRefs) {
    const fid = ref?.fleet ?? ref;
    const f = gs.fleet?.[String(fid)];
    // station fleets have station=true or are orbital stations
    if (f && !toArr(f.station).some(Boolean)) fleetCount++;
  }

  // Planet count from owned_planets list
  const planetCount = toArr(pc.owned_planets).length;

  // Empires list
  const empires = Object.values(nameMap).slice(0, 30);

  return { date, playerName, playerCountryId, resources, wars, empires, fleetCount, planetCount, _warParticipants: warParticipants };
}

function extractDiplomacy(gs, playerCountryId, pc, countries, nameMap, warParticipants) {
  const relations = toArr(pc.relations_manager?.relation);
  if (!relations.length) return [];

  // Build attitude map: cid -> attitude that country has toward player
  const attitudeMap = {};
  for (const [cid, c] of Object.entries(countries)) {
    if (!c?.ai) continue;
    const att = toArr(c.ai.attitude).find(a => String(a.country) === playerCountryId);
    if (att?.attitude) attitudeMap[cid] = att.attitude;
  }

  const subjectIds = new Set(toArr(pc.subjects).map(String));
  const overlordId = pc.overlord != null ? String(pc.overlord) : null;

  const diplomacy = [];
  for (const rel of relations) {
    const cid = String(rel.country);
    if (cid === playerCountryId) continue;
    const name = nameMap[cid];
    if (!name) continue;

    const opinion = Math.round(rel.relation_current ?? 0);
    const attitude = attitudeMap[cid] || 'unknown';

    const hasAlliance   = !!(rel.alliance || rel.defensive_pact);
    const hasNAP        = !!rel.non_aggression_pledge;
    const hasRA         = !!rel.research_agreement;
    const hasMigration  = !!rel.migration_access;
    const hasCommercial = !!(rel.commercial_pact || rel.embassy);
    const isRival       = !!(rel.is_rival || rel.rival);
    const isVassal      = subjectIds.has(cid);
    const isOverlord    = overlordId === cid;
    const inFederation  = !!(rel.in_federation_with || rel.federation);
    const truceExpiry   = rel.truce ? fmtDate(rel.truce) : null;

    const playerWars = warParticipants?.[playerCountryId] ?? new Set();
    const theirWars  = warParticipants?.[cid] ?? new Set();
    const sharedWar  = [...playerWars].find(w => theirWars.has(w));
    const atWar = !!sharedWar;

    diplomacy.push({ countryId: cid, name, opinion, attitude,
      hasAlliance, hasNAP, hasRA, hasMigration, hasCommercial,
      isRival, isVassal, isOverlord, inFederation,
      truceExpiry, atWar, warName: sharedWar || null });
  }

  diplomacy.sort((a, b) => {
    if (a.atWar !== b.atWar) return a.atWar ? -1 : 1;
    if (a.hasAlliance !== b.hasAlliance) return a.hasAlliance ? -1 : 1;
    return b.opinion - a.opinion;
  });

  return diplomacy.slice(0, 50);
}

function extractSystems(gs, playerCountryId, nameMap) {
  const planets = gs.planets?.planet ?? {};
  const allSystems = gs.galactic_object ?? {};

  // Build planet→owner map
  const planetOwner = {};
  for (const [pid, p] of Object.entries(planets)) {
    if (p?.owner != null) planetOwner[pid] = String(p.owner);
  }

  const systems = [];
  for (const [sid, sys] of Object.entries(allSystems)) {
    if (!sys || typeof sys !== 'object') continue;
    const name = resolveName(sys.name) || `System ${sid}`;
    const starClass = (sys.star_class || 'unknown').replace('sc_', '');
    const colonyIds = toArr(sys.colonies);
    const isColonized = colonyIds.length > 0;
    let ownerCountryId = null;
    if (isColonized) ownerCountryId = planetOwner[String(colonyIds[0])] ?? null;
    const isPlayerOwned = ownerCountryId === playerCountryId;
    const ownerName = ownerCountryId ? (nameMap[ownerCountryId] || null) : null;
    systems.push({ id: sid, name, starClass, isColonized, isPlayerOwned, ownerCountryId, ownerName });
    if (systems.length >= 2000) break;
  }
  return systems;
}

function extractColonies(gs, playerCountryId) {
  const planets     = gs.planets?.planet ?? {};
  const allDistricts = gs.districts ?? {};
  const allBuildings = gs.buildings ?? {};

  const colonies = [];
  for (const [pid, p] of Object.entries(planets)) {
    if (!p || String(p.owner) !== playerCountryId) continue;
    if (!(p.num_sapient_pops > 0) && !toArr(p.pop_groups).length) continue;

    const name        = resolveName(p.name) || `Planet ${pid}`;
    const planetClass = (p.planet_class || 'unknown').replace(/^pc_/, '');
    const size        = p.planet_size || 0;
    const stability   = Math.round(p.stability ?? 0);
    const amenities   = Math.round(p.free_amenities ?? p.amenities ?? 0);
    const freeHousing = Math.round(p.free_housing ?? 0);
    const designation = (p.final_designation || p.designation || '').replace(/^col_/, '').replace(/_/g, ' ');
    const popCount    = p.num_sapient_pops ?? toArr(p.pop_groups).length;

    // Districts: resolve id array → count per type
    const districtCounts = {};
    for (const did of toArr(p.districts)) {
      const d = allDistricts[String(did)];
      if (d?.type) districtCounts[d.type] = (districtCounts[d.type] || 0) + 1;
    }

    // Buildings: values in buildings_cache object are building ids
    const buildings = [];
    for (const bid of Object.values(p.buildings_cache ?? {})) {
      if (typeof bid !== 'number') continue;
      const b = allBuildings[String(bid)];
      if (b?.type) buildings.push(b.type.replace(/^building_/, ''));
    }

    // Resource output from produces block
    const prod = p.produces ?? {};
    const resources = {};
    for (const k of ['energy','minerals','food','alloys','consumer_goods','physics_research','society_research','engineering_research']) {
      if (prod[k] > 0) resources[k] = Math.round(prod[k] * 10) / 10;
    }

    colonies.push({ id: pid, name, planetClass, size, stability, amenities, freeHousing,
      designation, popCount, districtCounts, buildings: buildings.slice(0, 12), resources });
  }

  colonies.sort((a, b) => b.popCount - a.popCount);
  return colonies.slice(0, 30);
}

function extractFactions(gs, playerCountryId) {
  const pf = gs.pop_factions ?? {};
  const factions = [];
  for (const [fid, f] of Object.entries(pf)) {
    if (!f || String(f.country) !== playerCountryId) continue;
    const name = resolveName(f.name);
    if (!name) continue;
    factions.push({
      id: fid,
      name,
      type: f.type || 'unknown',
      support:   Math.round((f.support_percent ?? 0) * 1000) / 10,  // 0–1 → 0–100 with 1dp
      happiness: Math.round((f.faction_approval  ?? 0) * 100),
      ethics:    (f.type || '').replace(/^ethic_/, '').replace(/_/g, ' ')
    });
  }
  factions.sort((a, b) => b.support - a.support);
  return factions;
}

// ─── System Prompt Builder ────────────────────────────────────────────────────
function buildSystemPrompt(gameContext) {
  let context = '';

  if (gameContext?.parsed) {
    const p   = gameContext.parsed;
    const res = p.resources || {};
    const dip = gameContext.diplomacy || [];
    const col = gameContext.colonies  || [];
    const fac = gameContext.factions  || [];
    const sys = gameContext.systems   || [];

    context = `\nCURRENT GAME STATE:
- Date: ${p.date}
- Empire: ${p.playerName}
- Wars: ${p.wars?.length ? p.wars.map(w => w.name).join(', ') : 'None'}
- Fleets: ${p.fleetCount}  Colonies: ${p.planetCount}
- Monthly Income: Energy ${res.energy ?? '?'}, Minerals ${res.minerals ?? '?'}, Food ${res.food ?? '?'}, Alloys ${res.alloys ?? '?'}, CG ${res.consumer_goods ?? '?'}, Influence ${res.influence ?? '?'}, Unity ${res.unity ?? '?'}
`;

    if (dip.length) {
      context += '\nDIPLOMACY:\n';
      for (const d of dip.slice(0, 20)) {
        const ag = [d.hasAlliance?'Alliance':null, d.hasNAP?'NAP':null, d.hasRA?'RA':null,
                    d.hasMigration?'Mig':null, d.hasCommercial?'Com':null,
                    d.isVassal?'Vassal':null, d.isOverlord?'Overlord':null,
                    d.inFederation?'Fed':null].filter(Boolean).join('+');
        const opn = d.opinion >= 0 ? `+${d.opinion}` : String(d.opinion);
        const war = d.atWar ? ' [AT WAR]' : '';
        const riv = d.isRival ? ' [RIVAL]' : '';
        context += `  ${d.name}: ${d.attitude}, opinion ${opn}${ag?' ['+ag+']':''}${war}${riv}\n`;
      }
    }

    if (col.length) {
      context += '\nCOLONIES:\n';
      for (const c of col.slice(0, 15)) {
        const distStr = Object.entries(c.districtCounts || {})
          .map(([t, n]) => `${t.replace('district_','').slice(0,4)}×${n}`).join(' ');
        const resStr = Object.entries(c.resources || {})
          .filter(([,v]) => v > 0).map(([k,v]) => `${k.slice(0,3)}:${v}`).join(' ');
        context += `  ${c.name} (${c.planetClass} sz${c.size}): ${c.popCount} pops, stab ${c.stability}%, ${c.designation||'general'}${distStr?' ['+distStr+']':''}${resStr?' {'+resStr+'}':''}\n`;
      }
    }

    if (fac.length) {
      context += '\nFACTIONS:\n';
      for (const f of fac) {
        context += `  ${f.name} (${f.ethics}): ${f.support}% support, ${f.happiness}% happy\n`;
      }
    }

    const playerSys = sys.filter(s => s.isPlayerOwned);
    if (playerSys.length) {
      context += `\nPLAYER SYSTEMS (${playerSys.length} colonized):\n`;
      for (const s of playerSys.slice(0, 20)) {
        context += `  ${s.name} (${s.starClass})\n`;
      }
    }

  } else if (gameContext?.manual) {
    context = `\nCURRENT GAME STATE (player-provided):\n${gameContext.manual}\n`;
  }

  return `You are the Galactic AI Advisor to a galactic empire in the 4X strategy game Stellaris. You operate as both a strategic counselor and an in-universe intelligence bureau — part military tactician, part economist, part diplomat, part imperial correspondent.

Your role is to:
- Analyze the player's current situation and give sharp, actionable advice
- Comment on military strategy, fleet composition, war status, and threat assessment
- Advise on economy: resource balance, alloy production, energy credits, consumer goods
- Analyze diplomacy: federation politics, rivalry management, vassal potential, alliances
- Note political and internal empire state: stability, factions, traditions, ethics
- Speak with gravitas and authority as a trusted advisor
- Be direct. No fluff. Prioritize the most critical issues first.
- If something looks dangerous or suboptimal, say so bluntly.

ROLEPLAY NARRATIVE LAYER:
When asked about the state of the empire, current events, or when giving a full briefing, weave in immersive in-universe color commentary drawn directly from the game data. This includes:
- Galactic news headlines and holonet dispatches appropriate to the current wars, diplomacy, and faction mood (e.g. "BREAKING: ${context.match?.(/Empire: (.+)/)?.[1] ?? 'Imperial'} Fleet Repels Border Incursion Near Outer Colonies")
- Life on the ground: what daily existence feels like for citizens given colony stability, faction happiness, resource conditions, and designation (a mining world feels different from a thriving city planet)
- Political pulse: faction unrest or harmony, what political factions are demanding, protest movements or celebrations tied to their happiness levels
- Economic dispatches: shortages or surpluses framed as market news, trade route updates, rationing or abundance
- Diplomatic gossip: tensions, overtures, back-channel rumors about rival empires or allies based on attitude and opinion scores
- War correspondents: frontline reports, morale dispatches, strategic assessments framed as field intelligence
Keep the tone immersive but grounded in the actual data — do not invent facts not supported by the game state. Use the empire name, planet names, faction names, and war names from the data when narrating.
${context}
If asked a general question without game state, answer based on expert Stellaris knowledge.
Never hallucinate. Say you don't know if unsure. Be concise. Ask for more info if needed.`;
}
