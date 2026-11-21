# GMS Lighting Bridge (ProPresenter + OBS)

A small program that runs on the ProPresenter computer (and/or the OBS computer).
It watches for slide-group and scene changes and passes them to the GMS Lighting Dashboard,
so the lights can follow along. The phones and tablets running the dashboard need no changes.

```
ProPresenter / OBS  →  Bridge (this folder)  →  Supabase Realtime  →  Dashboard  →  Bluetooth lights
```

## One-time setup

1. **Install Node.js (LTS)** from https://nodejs.org on that computer.
2. **Copy this `bridge` folder** onto that computer.
3. **ProPresenter (Windows):** go to *ProPresenter → Settings → Network*, tick **Enable Network**, and note the **Port** shown.
4. **OBS (Mac or Windows):** go to *Tools → WebSocket Server Settings*, tick **Enable WebSocket server**, and note the port (usually 4455) and password.
5. **Start the bridge once:** double-click `start-windows.bat` (Windows) or `start-mac.command` (Mac). It creates `config.json` and closes.
6. **Open `config.json`** and fill in:
   - `"passcode"`: the team passcode (the same one you type into the dashboard)
   - `propresenter.port`: the port from step 3. Set `"enabled": false` if this computer has no ProPresenter.
   - `obs.url` / `obs.password`: from step 4. Set `"enabled": false` if this computer has no OBS.

   If OBS runs on a different computer, either run a second copy of the bridge there with only OBS enabled, or point `obs.url` at that computer's IP (e.g. `ws://192.168.1.50:4455`).

## Each service

Double-click the start file and leave the window open. You'll see lines like:

```
ProPresenter  Way Maker  ›  Chorus  [slide 7]
OBS scene  ›  Sermon
```

In the dashboard, **Settings (⚙) → ProPresenter & OBS** shows "Bridge online".

## How the lights follow

**ProPresenter.** The presentation name is matched to a song name in the selected service (e.g. "Way Maker"). The slide **group** name is matched to a cue name (e.g. "Chorus", "Verse 2", "Bridge").
- Several slides in the same group only trigger once.
- Repeated groups move forward through the song. The 2nd "Chorus" in ProPresenter goes to the next Chorus cue, and the last one goes to "Final Chorus".
- If there's no exact name match, the same section type is used (e.g. ProPresenter "Chorus 2" → a "Chorus" cue).
- The **Follow ProPresenter** button on the Show screen turns following on or off at any time.

**OBS.** In Settings, map each OBS scene to a lighting scene, House lights, Blackout, or nothing.

## Troubleshooting

- **"Wrong passcode in config.json":** the passcode must match the dashboard's.
- **"ProPresenter not reachable":** check that Network is enabled in ProPresenter and the port matches.
- **"OBS refused the password":** check `obs.password`.
- **Lights don't follow:** make sure **Follow ProPresenter** is on, a service with the song is selected, and the song name matches the ProPresenter presentation name.
