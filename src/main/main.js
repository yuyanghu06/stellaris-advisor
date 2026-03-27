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

/** Strip species/portrait prefix from character keys like "HUMAN1_CHR_Firstname" → "Firstname" */
function stripChrKey(key) {
  const chrIdx = key.indexOf('_CHR_');
  if (chrIdx !== -1) return key.slice(chrIdx + 5).replace(/_/g, ' ');
  return null;
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
  const chrStripped = stripChrKey(key);
  if (chrStripped) {
    // If this key also has variables (e.g. %LEADER_2% format with _CHR_ parts), resolve those
    if (nameObj.variables?.length) {
      const parts = nameObj.variables
        .map(v => v?.value ? resolveLeaf(v.value) : null)
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    return chrStripped;
  }
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
  const chrStripped = stripChrKey(key);
  if (chrStripped) {
    if (nameObj.variables?.length) {
      const parts = nameObj.variables
        .map(v => v?.value ? resolveLeaf(v.value) : null)
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    return chrStripped;
  }
  if (nameObj.variables?.length) {
    const parts = nameObj.variables
      .map(v => v?.value ? resolveLeaf(v.value) : null)
      .filter(Boolean);
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

  const parsed       = extractParsed(gs, playerCountryId, pc, nameMap);
  const diplomacy    = extractDiplomacy(gs, playerCountryId, pc, countries, nameMap, parsed._warParticipants);
  const systems      = extractSystems(gs, playerCountryId, nameMap);
  const colonies     = extractColonies(gs, playerCountryId);
  const factions     = extractFactions(gs, playerCountryId);
  const leaders      = extractLeaders(gs, playerCountryId, pc, nameMap);
  const situations   = extractSituations(gs, playerCountryId);
  const situationLog = extractSituationLog(gs, playerCountryId, pc);
  const eventChains  = extractEventChains(gs, playerCountryId, pc);
  const timeline     = extractTimeline(gs, playerCountryId, pc, nameMap);

  // Clean internal fields before returning
  delete parsed._warParticipants;

  // meta
  let meta = { date: parsed.date, saveName: fileName || 'Unknown' };
  try {
    const m = parser.parseText(Buffer.from(metaRaw));
    meta = { date: fmtDate(m.date) || parsed.date, saveName: resolveName(m.name) || fileName || 'Unknown' };
  } catch (e) { /* meta parse optional */ }

  return { parsed, meta, diplomacy, systems, colonies, factions, leaders, situations, situationLog, eventChains, timeline };
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
    const playerInvolved = attackers.includes(playerCountryId) || defenders.includes(playerCountryId);
    if (playerInvolved) wars.push({ name, attacker: attackers[0] || '?', defender: defenders[0] || '?' });
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

/** Resolve a ship name, stripping empire-specific prefix patterns like "ship_prefix_humans1" */
function resolveShipName(nameObj) {
  if (!nameObj) return null;
  if (typeof nameObj === 'string') return nameObj || null;
  // Ship names often have format: {key: "SPEC_SHIP_Scout", variables: [{value: {key:"ship_prefix_humans1"}}]}
  // We want just the meaningful part — try variables that aren't prefix/suffix boilerplate
  if (nameObj.variables?.length) {
    const parts = nameObj.variables
      .map(v => {
        if (!v?.value) return null;
        const k = v.value.key || '';
        if (k.startsWith('ship_prefix_') || k.startsWith('ship_suffix_')) return null;
        return resolveLeaf(v.value);
      })
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return resolveName(nameObj);
}

function extractLeaders(gs, playerCountryId, pc, nameMap) {
  const allLeaders = gs.leaders ?? {};
  const allShips   = gs.ships   ?? {};
  const allFleets  = gs.fleet   ?? {};
  const planets    = gs.planets?.planet ?? {};

  // Build set of player-owned fleet IDs
  const playerFleetIds = new Set();
  for (const ref of toArr(pc.fleets_manager?.owned_fleets)) {
    playerFleetIds.add(String(ref?.fleet ?? ref));
  }

  // leaderId → ship assignment (science ships etc.)
  const shipLeaderMap = {};
  for (const [sid, ship] of Object.entries(allShips)) {
    if (!ship?.leader) continue;
    if (!playerFleetIds.has(String(ship.fleet ?? ''))) continue;
    shipLeaderMap[String(ship.leader)] = {
      shipId: sid,
      shipName: resolveShipName(ship.name) || `Ship ${sid}`
    };
  }

  // leaderId → fleet assignment (admirals)
  const fleetLeaderMap = {};
  for (const fid of playerFleetIds) {
    const fleet = allFleets[fid];
    if (!fleet?.leader) continue;
    const shipCount = toArr(fleet.ships).length;
    fleetLeaderMap[String(fleet.leader)] = {
      fleetId: fid,
      fleetName: resolveName(fleet.name) || `Fleet ${fid}`,
      shipCount
    };
  }

  // leaderId → planet assignment (governors)
  const govPlanetMap = {};
  for (const [pid, p] of Object.entries(planets)) {
    if (!p?.governor || String(p.owner) !== playerCountryId) continue;
    govPlanetMap[String(p.governor)] = {
      planetId: pid,
      planetName: resolveName(p.name) || `Planet ${pid}`
    };
  }

  const rulerId = pc?.ruler != null ? String(pc.ruler) : null;

  const leaders = [];
  for (const [lid, l] of Object.entries(allLeaders)) {
    if (!l || String(l.country) !== playerCountryId) continue;

    // Stellaris 3.x+ stores leader names under name.full_names (a name object with _CHR_ keys)
    const name = resolveName(l.name?.full_names) || resolveName(l.name) || `Leader ${lid}`;
    const cls    = (l.class || 'unknown').toLowerCase();
    const skill  = (l.level ?? l.skill ?? 0) + (l.bonus_skill_level ?? 0);
    const age    = Math.round(l.age || 0);
    const traits = toArr(l.traits)
      .map(t => String(t)
        .replace(/^(gpm_|paragon_)?leader_trait_/, '')
        .replace(/^trait_(ruler|governor|admiral|scientist|general|official|commander)_/, '')
        .replace(/^trait_/, '')
        .replace(/_/g, ' ')
        .trim()
      )
      .filter(Boolean);

    let assignment = null;
    if (shipLeaderMap[lid])  assignment = { type: 'ship',   ...shipLeaderMap[lid] };
    else if (fleetLeaderMap[lid]) assignment = { type: 'fleet', ...fleetLeaderMap[lid] };
    else if (govPlanetMap[lid])   assignment = { type: 'planet', ...govPlanetMap[lid] };

    leaders.push({ id: lid, name, class: cls, skill, age, traits, assignment, isRuler: lid === rulerId });
  }

  const classOrder = { ruler: 0, admiral: 1, commander: 1, scientist: 2, governor: 3, official: 3, manager: 3, general: 4, envoy: 5 };
  leaders.sort((a, b) => {
    if (a.isRuler !== b.isRuler) return a.isRuler ? -1 : 1;
    const ca = classOrder[a.class] ?? 9, cb = classOrder[b.class] ?? 9;
    if (ca !== cb) return ca - cb;
    return b.skill - a.skill;
  });

  return leaders.slice(0, 50);
}

// ─── Timeline Extractor ───────────────────────────────────────────────────────

const TIMELINE_DEFS = {
  // Exploration
  timeline_first_colony:               { label: 'First Colony',             cat: 'explore' },
  timeline_new_colony:                 { label: 'New Colony',               cat: 'explore' },
  timeline_first_gateway:              { label: 'First Gateway',            cat: 'explore' },
  timeline_first_wormhole:             { label: 'First Wormhole',           cat: 'explore' },
  timeline_first_astral_rift:          { label: 'First Astral Rift',        cat: 'explore' },
  timeline_first_arc_site:             { label: 'First Arc Site',           cat: 'explore' },
  timeline_encountered_leviathan:      { label: 'Leviathan Encountered',    cat: 'explore' },
  // War
  timeline_first_war_declared:         { label: 'First War Declared vs',    cat: 'war' },
  timeline_war_declared_attacker:      { label: 'War Declared vs',          cat: 'war' },
  timeline_war_declared_defender:      { label: 'War Declared by',          cat: 'war' },
  timeline_first_war_won:              { label: 'First War Won vs',         cat: 'war' },
  timeline_war_won:                    { label: 'War Won vs',               cat: 'war' },
  timeline_destroyed_leviathan:        { label: 'Leviathan Destroyed',      cat: 'war' },
  // Military
  timeline_first_100k_fleet:           { label: '100k Fleet Power',         cat: 'military' },
  timeline_first_big_ship:             { label: 'First Titan/Colossus',     cat: 'military' },
  // Diplomacy
  timeline_first_vassal:               { label: 'First Vassal',             cat: 'diplo' },
  timeline_new_vassal:                 { label: 'New Vassal',               cat: 'diplo' },
  timeline_first_trade_deal:           { label: 'Trade Deal with',          cat: 'diplo' },
  timeline_meet_fallen_empire_discover:   { label: 'Fallen Empire Contact', cat: 'diplo' },
  timeline_meet_fallen_empire_discovered: { label: 'Fallen Empire Contact', cat: 'diplo' },
  timeline_galactic_community:         { label: 'Galactic Community Founded', cat: 'diplo' },
  timeline_galactic_community_resolution: { label: 'Resolution Passed',     cat: 'diplo' },
  timeline_galactic_market:            { label: 'Galactic Market Founded',  cat: 'diplo' },
  timeline_first_espionage_action:     { label: 'First Espionage Op',       cat: 'diplo' },
  // Science
  timeline_first_rare_tech:            { label: 'First Rare Tech',          cat: 'science' },
  timeline_first_repeatable_tech:      { label: 'Repeatables Unlocked',     cat: 'science' },
  timeline_first_relic:                { label: 'First Relic',              cat: 'science' },
  timeline_first_precursor_discovered: { label: 'Precursor Discovered',     cat: 'science' },
  // Empire
  timeline_first_ascension_perk:       { label: 'First Ascension Perk',     cat: 'empire' },
  timeline_elections:                  { label: 'Elections Held',           cat: 'empire' },
  timeline_change_of_capital:          { label: 'Capital Changed to',       cat: 'empire' },
  timeline_first_city_planet:          { label: 'First Ecumenopolis',       cat: 'empire' },
  timeline_first_terraform:            { label: 'First Terraform',          cat: 'empire' },
  timeline_council_max_expansion:      { label: 'Council Fully Expanded',   cat: 'empire' },
  timeline_first_leader_destiny_trait: { label: 'Destiny Leader',           cat: 'empire' },
  // Species
  timeline_first_intelligent_life:     { label: 'Intelligent Life Found',   cat: 'species' },
  timeline_first_robot:                { label: 'First Synthetic Built',    cat: 'species' },
  timeline_first_species_uplifted:     { label: 'Species Uplifted',         cat: 'species' },
  timeline_first_species_modification: { label: 'Species Modified',         cat: 'species' },
  // Galactic events
  timeline_great_khan:                 { label: 'Great Khan Rises',         cat: 'galactic' },
  timeline_voidworm_plague:            { label: 'Voidworm Plague',          cat: 'galactic' },
  timeline_kaleidoscope:               { label: 'Kaleidoscope Event',       cat: 'galactic' },
};

function extractTimeline(gs, playerCountryId, pc, nameMap) {
  const events    = pc.timeline_events ?? [];
  const planets   = gs.planets?.planet    ?? {};
  const galObjs   = gs.galactic_object    ?? {};
  const SKIP_DEFS = new Set(['timeline_event_year', 'timeline_origin_default']);

  function fmtTlDate(raw) {
    try {
      const d = new Date(raw);
      return d.getFullYear() + '.' +
        String(d.getMonth() + 1).padStart(2, '0') + '.' +
        String(d.getDate()).padStart(2, '0');
    } catch { return '?'; }
  }

  // Resolve the secondary subject ID from data[]
  function resolveSubject(def, data) {
    if (!data || !data.length) return null;
    // For defender events data[0] is the attacker, not the player
    const subjectId = String(def === 'timeline_war_declared_defender' ? data[0] : (data[1] ?? data[0]));
    if (nameMap[subjectId])                       return nameMap[subjectId];
    if (planets[subjectId]?.name)                 return resolveName(planets[subjectId].name);
    if (galObjs[subjectId]?.name)                 return resolveName(galObjs[subjectId].name);
    return null;
  }

  const result = [];
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || SKIP_DEFS.has(e.definition)) continue;
    const def  = TIMELINE_DEFS[e.definition];
    if (!def) continue;                           // skip unknown/uninteresting defs
    const date    = fmtTlDate(e.date);
    const subject = resolveSubject(e.definition, e.data);
    const label   = subject ? `${def.label} ${subject}` : def.label;
    result.push({ date, label, cat: def.cat });
  }
  return result;
}

// ─── Situation Log Extractors ─────────────────────────────────────────────────

/**
 * Extract event chains and special projects from pc.events.
 * Returns { active, completed, specialProjects }.
 *   active[]           — chains currently in progress
 *   completed[]        — chain names that have been finished
 *   specialProjects[]  — ongoing or pending special projects (anomaly outcomes, etc.)
 */
function extractEventChains(gs, playerCountryId, pc) {
  const ev = pc.events ?? {};

  // ── Active event chains ──────────────────────────────────────────────────────
  const active = [];
  for (const entry of toArr(ev.event_chain)) {
    if (!entry || typeof entry !== 'object') continue;
    const chainKey = String(entry.event_chain ?? '').replace(/_/g, ' ').trim();
    if (!chainKey) continue;
    // counter is an object like { mem_stars_surveyed: 3 } — flatten to readable string
    let counter = null;
    if (entry.counter && typeof entry.counter === 'object') {
      const parts = Object.entries(entry.counter)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
      if (parts.length) counter = parts.join(', ');
    }
    active.push({ chainKey, counter });
  }

  // ── Completed event chains ───────────────────────────────────────────────────
  const completed = toArr(ev.completed_event_chain)
    .filter(c => typeof c === 'string' && c.trim())
    .map(c => String(c).replace(/_/g, ' ').trim());

  // ── Special projects ─────────────────────────────────────────────────────────
  // Stored in pc.events.special_project as array of { id, special_project, status, ... }
  const specialProjects = [];
  for (const sp of toArr(ev.special_project)) {
    if (!sp || typeof sp !== 'object') continue;
    const name   = String(sp.special_project ?? `project_${sp.id ?? '?'}`)
      .replace(/_/g, ' ').trim();
    const status = sp.status ?? null;   // "completed" | "in_progress" | undefined
    specialProjects.push({ id: sp.id ?? null, name, status });
  }

  return { active, completed, specialProjects };
}

/**
 * Extract active mechanical Situations (progress-bar driven events like
 * Synthetic Evolution, AI Rebellion, crisis paths, etc.)
 * Save structure: gs.situations.situations = { id: { country, type, progress, ... } }
 */
function extractSituations(gs, playerCountryId) {
  // Situations are nested: gs.situations.situations
  const allSituations = gs.situations?.situations ?? {};
  const result = [];

  for (const [sid, sit] of Object.entries(allSituations)) {
    if (!sit || typeof sit !== 'object') continue;
    const owner = sit.country != null ? String(sit.country) : sit.owner != null ? String(sit.owner) : null;
    if (owner !== playerCountryId) continue;

    const type            = String(sit.type ?? sit.key ?? `situation_${sid}`).replace(/_/g, ' ');
    const progress        = typeof sit.progress          === 'number' ? Math.round(sit.progress) : null;
    const monthlyProgress = typeof sit.last_month_progress === 'number'
      ? Math.round(sit.last_month_progress * 10) / 10
      : typeof sit.monthly_progress === 'number' ? Math.round(sit.monthly_progress * 10) / 10 : null;
    const stage    = sit.current_stage != null ? String(sit.current_stage).replace(/_/g, ' ') : null;
    const approach = sit.approach      != null ? String(sit.approach).replace(/_/g, ' ')      : null;
    const outcome  = sit.outcome       != null ? String(sit.outcome).replace(/_/g, ' ')       : null;

    result.push({ id: sid, type, progress, monthlyProgress, stage, approach, outcome });
  }

  return result;
}

/**
 * Extract situation-log contents:
 *   - Archaeological sites   (gs.archaeological_sites.sites)
 *   - First contacts         (gs.first_contacts.contacts)
 *   - Astral rifts           (gs.astral_rifts.rifts)
 * All containers are nested one level deep in the save file.
 */
function extractSituationLog(gs, playerCountryId, pc) {
  const nameMap = buildNameMap(gs.country ?? {});

  // ── Archaeological Sites ─────────────────────────────────────────────────────
  // gs.archaeological_sites.sites = { id: { type, index, clues, days_left, locked, last_excavator_country, ... } }
  const archaeologicalSites = [];
  const allSites = gs.archaeological_sites?.sites ?? {};
  for (const [aid, site] of Object.entries(allSites)) {
    if (!site || typeof site !== 'object') continue;
    if (String(site.last_excavator_country) !== playerCountryId) continue;

    const type      = String(site.type ?? `site_${aid}`).replace(/^site_/, '').replace(/_/g, ' ');
    const chapter   = site.index ?? 0;
    const clues     = site.clues ?? 0;
    const daysLeft  = site.days_left ?? null;
    const locked    = !!site.locked;

    archaeologicalSites.push({ id: aid, name: type, chapter, clues, daysLeft, locked });
  }

  // ── First Contacts ───────────────────────────────────────────────────────────
  // gs.first_contacts.contacts = { id: { owner, country, stage, status, clues, days_left, ... } }
  const firstContacts = [];
  const allContacts = gs.first_contacts?.contacts ?? {};
  for (const [fcid, fc] of Object.entries(allContacts)) {
    if (!fc || typeof fc !== 'object') continue;
    if (String(fc.owner) !== playerCountryId) continue;

    const targetId   = fc.country != null ? String(fc.country) : null;
    const targetName = targetId ? (nameMap[targetId] || `Country ${targetId}`) : 'Unknown';
    const stage      = fc.stage != null ? String(fc.stage).replace(/_/g, ' ') : null;
    const status     = fc.status ?? null;
    const clues      = fc.clues ?? null;
    const daysLeft   = fc.days_left ?? null;

    firstContacts.push({ id: fcid, target: targetName, stage, status, clues, daysLeft });
  }

  // ── Astral Rifts ─────────────────────────────────────────────────────────────
  // gs.astral_rifts.rifts = { id: { owner, type, clues, days_left, difficulty, status, ... } }
  const astralRifts = [];
  const allRifts = gs.astral_rifts?.rifts ?? {};
  for (const [rid, rift] of Object.entries(allRifts)) {
    if (!rift || typeof rift !== 'object') continue;
    if (String(rift.owner) !== playerCountryId) continue;

    const type     = rift.type != null ? String(rift.type).replace(/_/g, ' ') : `Astral Rift ${rid}`;
    const clues    = rift.clues ?? 0;
    const daysLeft = rift.days_left ?? null;
    const diff     = rift.difficulty ?? null;
    const status   = rift.status ?? null;
    const active   = rift.explorer_fleet != null && rift.explorer_fleet !== 4294967295;

    astralRifts.push({ id: rid, type, clues, daysLeft, difficulty: diff, status, active });
  }

  return { archaeologicalSites, firstContacts, astralRifts };
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
    const empireName = gameContext.empireNameOverride || p.playerName;

    context = `\nCURRENT GAME STATE:
- Date: ${p.date}
- Empire: ${empireName}
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

    const lea = gameContext.leaders || [];
    if (lea.length) {
      context += '\nLEADERS:\n';
      for (const l of lea) {
        const stars  = '★'.repeat(Math.min(10, l.skill)) + '☆'.repeat(Math.max(0, Math.min(10, 10 - l.skill)));
        const role   = l.isRuler ? 'Ruler' : (l.class.charAt(0).toUpperCase() + l.class.slice(1));
        let assign   = '';
        if (l.assignment?.type === 'fleet')  assign = ` — commanding "${l.assignment.fleetName}" (${l.assignment.shipCount} ships)`;
        else if (l.assignment?.type === 'ship')   assign = ` — aboard "${l.assignment.shipName}"`;
        else if (l.assignment?.type === 'planet') assign = ` — governing ${l.assignment.planetName}`;
        const traitStr = l.traits.length ? ` [${l.traits.slice(0, 3).join(', ')}]` : '';
        context += `  [${role}] ${l.name} ${stars}${assign}${traitStr}\n`;
      }
    }

    const ec = gameContext.eventChains || {};
    if (ec.active?.length) {
      context += '\nACTIVE EVENT CHAINS:\n';
      for (const c of ec.active) {
        const ctr = c.counter ? ` [${c.counter}]` : '';
        context += `  ${c.chainKey}${ctr}\n`;
      }
    }
    if (ec.specialProjects?.length) {
      const pending = ec.specialProjects.filter(p => p.status !== 'completed');
      if (pending.length) {
        context += '\nSPECIAL PROJECTS:\n';
        for (const p of pending) {
          const status = p.status ? ` (${p.status})` : ' (pending)';
          context += `  ${p.name}${status}\n`;
        }
      }
    }
    if (ec.completed?.length) {
      context += `\nCOMPLETED EVENT CHAINS: ${ec.completed.slice(0, 15).join(', ')}\n`;
    }

    const sits = gameContext.situations || [];
    if (sits.length) {
      context += '\nACTIVE SITUATIONS:\n';
      for (const s of sits) {
        const prog  = s.progress != null ? ` ${s.progress}%` : '';
        const rate  = s.monthlyProgress != null ? ` (+${s.monthlyProgress}/mo)` : '';
        const stage = s.stage    ? ` [${s.stage}]`    : '';
        const appr  = s.approach ? ` approach: ${s.approach}` : '';
        const out   = s.outcome  ? ` → outcome: ${s.outcome}` : '';
        context += `  ${s.type}:${prog}${rate}${stage}${appr}${out}\n`;
      }
    }

    const sl = gameContext.situationLog;
    if (sl) {
      if (sl.archaeologicalSites?.length) {
        context += '\nARCHAEOLOGICAL SITES (player-excavated):\n';
        for (const a of sl.archaeologicalSites) {
          const chap   = ` ch.${a.chapter}`;
          const clues  = a.clues ? ` ${a.clues} clues` : '';
          const days   = a.daysLeft != null ? ` (~${a.daysLeft}d)` : '';
          const locked = a.locked ? ' [locked]' : '';
          context += `  ${a.name}:${chap}${clues}${days}${locked}\n`;
        }
      }

      if (sl.firstContacts?.length) {
        context += '\nFIRST CONTACTS:\n';
        for (const fc of sl.firstContacts.slice(0, 20)) {
          const stage  = fc.stage  ? ` [${fc.stage}]`        : '';
          const status = fc.status ? ` (${fc.status})`       : '';
          const clues  = fc.clues  != null ? ` ${fc.clues} clues` : '';
          context += `  ${fc.target}:${stage}${status}${clues}\n`;
        }
      }

      if (sl.astralRifts?.length) {
        context += '\nASTRAL RIFTS:\n';
        for (const r of sl.astralRifts) {
          const active = r.active  ? ' [ACTIVE]'                 : '';
          const clues  = r.clues   ? ` ${r.clues} clues`         : '';
          const diff   = r.difficulty != null ? ` diff ${r.difficulty}` : '';
          const status = r.status  ? ` (${r.status})`            : '';
          context += `  ${r.type}${active}${status}${clues}${diff}\n`;
        }
      }
    }

    const tl = gameContext.timeline || [];
    if (tl.length) {
      context += '\nEMPIRE TIMELINE (chronological):\n';
      for (const e of tl) {
        context += `  [${e.date}] (${e.cat}) ${e.label}\n`;
      }
    }

  }

  const manualBlocks = gameContext?.manualBlocks?.length ? gameContext.manualBlocks
    : (gameContext?.manual && gameContext?.parsed ? [{ text: gameContext.manual }] : []);
  if (manualBlocks.length) {
    context += '\nADDITIONAL CONTEXT (player-provided):\n';
    for (const b of manualBlocks) context += b.text + '\n';
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
