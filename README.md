# Skitter

A little yellow robot who lives on the right edge of your screen and fetches the file you were about to go looking for.

## Using him

| Do this | He does this |
|---|---|
| Click him, type, press Enter | Runs down the edge, climbs into the folder, comes back with a file (about 5–6 s) |
| Click the card | Opens the file |
| Right-click the card | Shows it in Explorer |
| Click him while the card is up | "Not that one": goes back for the next best |
| Ignore the card / press Esc | Soft no; the card fades after 14 s |
| Drag him up or down | Moves his shelf to your eyeline |
| He didn't find it | Right-click › "He missed a file", pick the file: he says why, fixes what he can, and learns |
| Right-click him, or the tray icon | Settings: folders, unassigned trips, meaning search, pace, screen, start with Windows, stats |

**Unassigned trips.** When you stay on one document for 20 s, he works out which file it is, reads it and the text around your cursor, and searches. He only goes if the match clears a bar that adjusts itself so that at least 60% of unassigned trips are ones you keep. At most one every 4 minutes.

**What he reads.** Documents, Desktop and Downloads by default (Windows' real locations, including OneDrive). Text of Office, PDF, text and code files; everything else (images, video, project files) by name, and "deck", "spreadsheet", "picture", "video" etc. match those file types. Online-only OneDrive files are indexed by name without downloading them.

**Privacy.** Everything runs on your computer; the meaning-search model ships inside the app. The only network traffic is the update check against GitHub Releases (direct-download installs only). Password fields are never read. Full policy: `docs/privacy.html`.

## How it works

```
main process ── overlay window (canvas creature, preview card)
     │       ── context: winhelper.ps1 (window events + UI Automation text), clipboard, Windows Recent
     │
     └── engine process (utilityProcess)
            SQLite (node:sqlite, FTS5)   docs, keyword index, text chunks, int8 vectors, opens, proposals
            folder watcher               live add / change / delete
            embedder                     all-MiniLM-L6-v2 on ONNX Runtime (WebAssembly), newest files first
            search                       keywords ∪ meaning ∪ opened-together → learned ranker
            ranker                       logistic regression on 11 features, trained from what you keep,
                                         plus a precision-targeted bar for unassigned trips
```

Data lives in `%APPDATA%\Skitter`: `gofer.db`, `settings.json`, `proposals.jsonl` (a readable log of every fetch), `gofer.log`, `models/`.

## Developing

```
npm install
npm start                                   # run the app
node tools/test-engine.js <fixtures> <model> # engine checks
node tools/test-findability.js              # files he used to miss (names, types, sizes, folders)
node tools/eval.js --db "%APPDATA%\Skitter\gofer.db"            # replay your own history
node tools/eval.js --roots <dir> --cases tools/cases/fixtures.json
node tools/fetch-model.js                   # pinned, verified model into ./model
node tools/build-win.js                     # installer + zip on Windows; zip elsewhere
node tools/smoke.js --dev                   # launch, fetch, check (or pass a Skitter.exe path)
makensis -DSRC=release/win-unpacked -DVERSION=0.2.0 -DOUTFILE=dist/Skitter-Setup-0.2.0.exe -DICON=buildres/icon.ico tools/installer.nsi
```

Run `tools/eval.js` before shipping any ranking change; ship only if top-1 doesn't drop.

## Releasing

See **RELEASING.md**. Pushing a version tag makes the GitHub Actions pipeline (`.github/workflows/release.yml`) test, build, sign, smoke-test and publish Skitter, and build the Microsoft Store package. The model is pinned by `model.lock.json` and verified on every build. Run `docs/test-checklist.md` on a real PC before the first public release. The privacy policy is `docs/privacy.html`, served by GitHub Pages.
