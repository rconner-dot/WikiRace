# WikiRace Local

A self-hosted WikiRace game. Start on one Wikipedia article and reach another using only the links on each page.

Everything runs on your computer. The browser talks only to this local server, and the server makes outbound requests only to Wikipedia (`<lang>.wikipedia.org`, plus `upload.wikimedia.org` for images). Game logic, timing, rules, scoring, history and multiplayer all run inside the app. Articles are cached on disk, so a page you've already visited never has to be fetched again.

## Quick start

Requires **Node.js 18.17 or newer**. There are no dependencies to install.

```bash
npm start            # http://localhost:3000
npm run lan          # also let others on your Wi-Fi / LAN join multiplayer rooms
node server.js --port 8080
```

## Features

**Game modes**
- **Random** at three difficulties:
  - *Easy*: famous start and target.
  - *Medium*: random substantial start, famous target.
  - *Hard*: fully random.
- **Daily challenge**: the same pair for everyone each day, so you can compare scores with friends. It also tracks your daily win streak.
- **Custom**: pick any start and target, with autocomplete. Leave either one blank to have it chosen randomly.
- **Checkpoints**: optionally require the route to pass through a given article (for example "via Philosophy").
- You can reroll the start or target on its own, or swap them.

**Rules (all enforced by the server, so they can't be bypassed from the browser)**
- Time limit and click limit.
- Back button on or off, and whether going back costs a click.
- Ban year, date and "List of…" pages.
- A custom list of banned pages (for example the classic "No United States" rule).
- Presets: Classic, Speedrun (3 minutes), Six degrees (6 clicks), No USA, Purist, Hardcore.
- Only links that are actually on the current page count. Red links, files, categories and external links are disabled.
- Redirects are resolved, so reaching "The Moon" counts as reaching "Moon".
- Any Wikipedia language: `en`, `simple`, `de`, `fr`, `ja`…

**Display & assists**
- Show or hide images, infoboxes, navboxes, "See also" sections and references.
- Dim text that isn't a playable link.
- Target summary and your path in the sidebar, plus an optional highlight when the target link is on the page.
- Light, dark, sepia or system theme, with adjustable text size and article width.
- Keyboard shortcuts: `Alt+←`/`Backspace` goes back, `t` shows the target, `,` opens settings, `Esc` closes dialogs.

**Multiplayer (LAN)**
- Create a room and share its 4-letter code or link. Everyone races the same pair at the same moment, after a synced countdown.
- The host picks the pages and rules, and ranks by fastest finish or fewest clicks.
- A live sidebar shows each racer's clicks and, optionally, what page they're on. Standings appear at the end, and the host can start the next round straight away.

**History & stats**
- Every race is saved locally in `data/history.json`, with its full path.
- Stats: win rate, average clicks, fewest clicks, fastest win and daily streak.
- Filter, replay a pair, export to JSON, or clear.

## Configuration

| Option | Default | |
| --- | --- | --- |
| `--port` / `PORT` | `3000` | Port to listen on |
| `--host` / `HOST` | `127.0.0.1` | Interface to bind (`--lan` is shorthand for `0.0.0.0`) |
| `DATA_DIR` | `./data` | Where history and the article cache live |
| `--no-disk-cache` | off | Keep cached articles in memory only |
| `WIKI_URL` | `https://{lang}.wikipedia.org` | MediaWiki base URL. Point it at a mirror or the test mock |

Cached articles expire after 7 days. You can clear the cache from Settings.

## Development

```bash
npm test                                   # API + referee + multiplayer tests against a mock wiki
PORT=8081 node test/mock-wiki.js &         # offline fake Wikipedia with a tiny article graph
WIKI_URL=http://127.0.0.1:8081 npm start
```

Layout:
- `server.js`: HTTP server and routes.
- `lib/wiki.js`: the only module that makes network requests. It fetches from Wikipedia and handles caching.
- `lib/game.js`: the referee.
- `lib/rooms.js`: multiplayer over Server-Sent Events.
- `lib/picker.js`: page selection and the daily seed.
- `public/`: the browser app. `rules.js` is shared with the server.

## Privacy & safety

- The page is served with a strict Content-Security-Policy (`connect-src 'self'`, `img-src 'self'`), so the browser itself can't reach any other site.
- Article HTML is loaded into an inert document and sanitised before display: scripts, iframes, forms and event handlers are removed, and links are rewritten.
- The image proxy only fetches over HTTPS from Wikimedia hosts.
- By default the server listens on localhost only.
