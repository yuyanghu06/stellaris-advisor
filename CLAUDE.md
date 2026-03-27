# CLAUDE.md — Stellaris Advisor

## Project Overview
An Electron desktop app for Windows that acts as an AI strategic advisor for Stellaris campaigns. It parses `.sav` save files or accepts manual empire descriptions, then feeds that context to GPT-4o via the OpenAI API to provide military, diplomatic, economic, and political advice in an immersive advisor persona.

## Architecture

```
stellaris-advisor/
├── src/main/
│   ├── main.js          # Electron main process — all Node.js logic lives here
│   └── preload.js       # Secure IPC bridge (contextBridge) between main and renderer
├── public/
│   └── index.html       # Entire renderer: UI + vanilla JS, self-contained single file
├── package.json
└── README.md
```

**Key design decision:** The renderer (`index.html`) is a single self-contained HTML/CSS/JS file with no bundler or framework. All Node.js APIs (file system, OpenAI, zip parsing) live exclusively in `main.js`. Communication between the two happens only through IPC via `window.advisor.*`.

## IPC API (preload.js bridge)

```js
window.advisor.setApiKey(key)    // validates key against OpenAI, stores client in main
window.advisor.openSaveFile()    // opens file dialog, unzips .sav, parses gamestate
window.advisor.chat({ messages, gameContext })  // sends chat history + context to GPT-4o
```

All handlers are in `ipcMain.handle(...)` in `main.js`. Never add Node.js logic to `index.html`.

## Save File Parsing

Stellaris `.sav` files are ZIP archives containing two plain-text files: `gamestate` and `meta`. The parser in `parseGamestate()` uses regex against the raw PDX script format.

Currently extracted fields:
- `date` — in-game date
- `playerName` — player empire name
- `wars[]` — active war names, attacker/defender country IDs
- `empires[]` — up to 15 known empire names
- `resources` — energy, minerals, alloys, consumer_goods, influence, unity
- `fleetCount`, `planetCount`, `techCount` — regex match counts

**Save file location on Windows:**
```
C:\Users\<Name>\Documents\Paradox Interactive\Stellaris\save games\
```

**Extending the parser:** Add new regex patterns inside `parseGamestate()` in `main.js`. Common targets to add: federation status, tradition count, ascension perks, ethics/civics, subject/overlord relations, crisis progress.

## LLM Integration

- Model: `gpt-4o` (change in the `chat` IPC handler in `main.js`)
- Temperature: `0.7`, max tokens: `1024`
- System prompt is built by `buildSystemPrompt(gameContext)` — modify this to tune advisor tone, add domain knowledge, or inject more parsed fields
- Full conversation history (`msgs[]`) is sent on every turn — no summarization yet

## Running the App

```bash
npm install
npm start
```

Requires Node.js v18+. No build step needed.

## Styling & UI

- Pure CSS with CSS custom properties (all colors in `:root` vars at top of `index.html`)
- Fonts: Cinzel (headers/titles), Rajdhani (body), Share Tech Mono (data/code)
- **Light, clean, futuristic sci-fi aesthetic** — white/off-white base with electric blue and cyan accents
- Background has a subtle CSS dot-grid pattern (`background-image` repeating linear-gradient) for a holographic/HUD feel
- Depth via `box-shadow` layers (`--shadow-sm`, `--shadow-md`) and `--glow-blue` focus rings instead of dark backgrounds
- Theme vars:
  - Backgrounds: `--bg-void` (#f0f4fc), `--bg-deep` (#ffffff), `--bg-panel` (#f7f9ff), `--bg-card` (#ffffff)
  - Borders: `--border` (#dde6f5), `--border-glow` (#3b82f6)
  - Accents: `--accent-blue` (#2563eb), `--accent-cyan` (#0ea5e9), `--accent-gold` (#d97706), `--accent-red` (#ef4444), `--accent-green` (#10b981)
  - Text: `--text-primary` (#0f172a), `--text-secondary` (#334155), `--text-muted` (#94a3b8)
- Titlebar overlay: white (`#ffffff`) background, blue (`#2563eb`) symbols
- No external UI framework — all components are hand-rolled HTML/CSS

## Common Tasks

**Change the GPT model:**
In `main.js` → `ipcMain.handle('chat', ...)` → change `model: 'gpt-4o'`

**Tune advisor personality:**
In `main.js` → `buildSystemPrompt()` → edit the system prompt string

**Add a new parsed field:**
In `main.js` → `parseGamestate()` → add a regex, write to `result.yourField`
Then reference it in `buildSystemPrompt()` to inject into the LLM context

**Add a new UI panel:**
All UI is in `public/index.html`. Add HTML to the sidebar or chat area, wire up with vanilla JS at the bottom of the file.

**Add a new IPC channel:**
1. Add `ipcMain.handle('your-channel', ...)` in `main.js`
2. Expose it via `contextBridge.exposeInMainWorld` in `preload.js`
3. Call `window.advisor.yourChannel(...)` from `index.html`

## Security Notes
- `nodeIntegration: false` and `contextIsolation: true` are set — do not change these
- The API key is stored only in memory as the `openaiClient` instance in `main.js`, never written to disk
- All sensitive operations (file I/O, API calls) are gated in the main process only

## Known Limitations
- Save parser uses regex, not a full PDX grammar parser — complex nested blocks may mismatch
- Resources are grabbed from the first match in the file, which may not always be the player's country block
- No conversation summarization — very long sessions will hit the GPT-4o context window limit
- API key is not persisted between sessions (re-enter on each launch)