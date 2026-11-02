# Skitter — Windows release checklist (about 15 minutes)

Run on a real Windows 10/11 PC before the first public release, and again whenever the context helper, installer or updater changes. The automated pipeline covers indexing, search, the trip and the card; this covers what only a real desktop can.

Before you start: open `%APPDATA%\Skitter\gofer.log` in Notepad. Most checks say what line to look for.

## Install
- [ ] Run `Skitter-Setup-x.y.z.exe`. It installs without an admin prompt and Skitter appears on the shelf at the right edge.
- [ ] On a signed build, the publisher shown in the SmartScreen / UAC dialog is your name, not "Unknown publisher". (A "Windows protected your PC" warning can still appear on early releases while reputation builds.)
- [ ] Start menu and desktop shortcuts exist and show his icon.
- [ ] Settings › Apps lists Skitter with version and publisher.

## Context helper (the part CI can't test)
- [ ] Log shows `context helper ready (event-driven)`. If it says `falling back to polling`, copy the lines after it into an issue.
- [ ] Right-click Skitter: the menu says `Context: live`.
- [ ] Open a Word document from your Documents folder. Log shows `[fg] WINWORD | <name> → <full path>` (the arrow means he resolved the file).
- [ ] Same for a PDF in Edge or Acrobat, and a `.md` or `.txt` in Notepad or VS Code.
- [ ] Type a few sentences in Word, wait 20 seconds, then click Skitter and ask for something related. The card's reason may say "Close to what you're working on".
- [ ] Click into a password box (e.g. a website login) and wait 20 seconds. Skitter never sets out because of it, and nothing from it appears in `proposals.jsonl`.

## Unassigned trips
- [ ] Work in one document for a minute with "Go looking on his own" ticked. Either he goes and brings something related, or the log says `auto: stayed put (best … < bar …)`. Both are correct; a wrong pick is fine but note it.
- [ ] He doesn't go again within 4 minutes.
- [ ] He never brings back the document you have open.

## The card
- [ ] Click the card: the file opens in its usual app.
- [ ] Right-click the card: Explorer opens with the file selected.
- [ ] Click Skitter while the card is up: he goes back and returns a different file.
- [ ] Ignore the card: it fades after about 14 seconds.
- [ ] Clicks anywhere else on the screen pass through to your apps (including over the empty area near the shelf).

## Screens, start-up, updates
- [ ] With two monitors: right-click › "Move Skitter to the screen with the mouse" moves him.
- [ ] Change display scaling (125% / 150%): he stays on the edge, crisp, and clickable.
- [ ] Sign out and back in: Skitter starts by himself. Untick "Start with Windows", sign out and in: he doesn't.
- [ ] Updates: install version N, publish N+1, wait a few minutes (or restart Skitter). The menu shows "Restart to update to N+1"; clicking it relaunches on N+1.

## Files
- [ ] If your Documents folder is in OneDrive, the log's `folders:` line shows the OneDrive path, and he finds a file from it.
- [ ] Ask for an image or video by words in its name. He brings it.
- [ ] With OneDrive Files On-Demand, online-only files are found by name and are NOT downloaded (their cloud icon stays a cloud).
- [ ] Right-click › "He missed a file" on a file outside your folders offers to add the folder; after adding, he finds it.
- [ ] Save a new document into Documents with a distinctive word in it. Within a few seconds he can fetch it by that word.
- [ ] Delete it. He no longer brings it back.
- [ ] Right-click › menu shows meaning search progress reaching 100% on a normal Documents folder within an hour or so.

## Uninstall
- [ ] Settings › Apps › Skitter › Uninstall removes the program, the shortcuts and the start-up entry. `%APPDATA%\Skitter` remains (by design, per the privacy policy).
