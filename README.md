# Galactic AI Advisor — Imperial Intelligence Bureau

An Electron desktop app that acts as an AI strategic advisor for your Stellaris campaigns, powered by GPT-4o. It parses your `.sav` save files using the [jomini](https://github.com/nickbabcock/jomini) PDX parser, extracts rich empire data, and feeds it to the advisor as live context.

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- An [OpenAI API key](https://platform.openai.com/api-keys)

### Install & Run
```bash
npm install
npm start
```

### API Key
The app will use `OPENAI_API_KEY` from a `.env` file in the project root if present:
```
OPENAI_API_KEY=sk-...
```
If no `.env` key is found, enter it manually in the sidebar on first launch.

## Features

### Auto Save Monitoring
The app watches your Stellaris save games folder by default:
```
C:\Users\<YourName>\Documents\Paradox Interactive\Stellaris\save games\
```
It loads the most recently modified `.sav` on startup and reloads automatically whenever a new save is detected. Use **Change Folder** in the sidebar to point it elsewhere.

### Rich Save Parsing
Powered by jomini (a Rust/WASM PDX format parser). Extracts:
- **Empire overview** — name, date, fleet count, colony count, monthly income (energy, minerals, food, alloys, consumer goods, influence, unity, research)
- **Active wars** — war names with attacker/defender identification
- **Diplomacy** — per-empire opinion scores, AI attitude, active agreements (alliance, NAP, research agreement, migration, commercial), rival/vassal/overlord/federation flags, truce expiry, at-war status
- **Star systems** — all systems with star class, colonization status, and owner name
- **Colonies** — stability, designation, pop count, size, free housing, districts, buildings, resource output
- **Pop factions** — support percentage, happiness, ethics alignment

### Immersive Advisor
The advisor gives both strategic analysis and in-universe narrative:
- Galactic news dispatches and holonet headlines
- Life-on-the-ground flavor for your colonies
- Political pulse from faction moods and happiness
- Economic bulletins framed as market news
- Diplomatic gossip drawn from attitude and opinion scores
- War correspondent field reports

### Conversation Memory
Full chat history is sent on every turn — the advisor retains context across the conversation.

### Manual Context
If you'd rather not load a save, describe your situation in plain text in the **Manual** tab.

## UI

| Panel | Contents |
|---|---|
| **Auto** tab | Live folder monitor, current save name, empire stats |
| **File** tab | One-off save file picker |
| **Manual** tab | Free-text empire description |
| **Diplomacy** | Table of known empires with attitude badges, opinion, and agreement icons |
| **Star Systems** | Player-owned (blue), foreign-owned, and unclaimed systems |
| **Colonies** | Per-planet cards with stability bar, districts, buildings, resource output |
| **Pop Factions** | Support and happiness bars per faction |

## Extending

**Add a parsed field** — add a regex/jomini extraction in `parseAndExtract()` or one of the `extract*()` helpers in `src/main/main.js`, then reference it in `buildSystemPrompt()`.

**Tune the advisor** — edit `buildSystemPrompt()` in `main.js`.

**Change the model** — find `model: 'gpt-4o'` in the `chat` IPC handler in `main.js`.

**Add a new IPC channel:**
1. Add `ipcMain.handle('your-channel', ...)` in `main.js`
2. Expose it in `preload.js` via `contextBridge`
3. Call `window.advisor.yourChannel(...)` from `index.html`

## Architecture

```
stellaris-advisor/
├── src/main/
│   ├── main.js       # Electron main process — all Node.js/parsing/API logic
│   └── preload.js    # contextBridge IPC bridge
├── public/
│   └── index.html    # Renderer — single-file vanilla JS/CSS UI
├── .env              # Optional: OPENAI_API_KEY=sk-...  (gitignored)
└── package.json
```

All Node.js APIs (file I/O, OpenAI, zip parsing, jomini) live exclusively in `main.js`. The renderer communicates only through `window.advisor.*` IPC calls.
