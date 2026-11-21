# GMS Lighting Dashboard

A web app for controlling the GMS LED lights (MELK-OA10 controllers, normally used with LotusLamp X) over Bluetooth. You can build setlists with song cues for each service, and everything saves online so the whole team sees the same presets.

- **Works on:** Chrome on Android, Windows, Mac and ChromeOS (Edge works too). It installs to the home screen or desktop like a normal app.
- **Doesn't work on:** iPhone/iPad, or Firefox/Safari anywhere. These browsers don't support Web Bluetooth.

---

## 1. Set up the database (Supabase, about 5 minutes)

1. Create a project at https://supabase.com.
2. Go to **SQL Editor → New query**, paste everything from `supabase/schema.sql`, and click **Run**.
3. Go to **Authentication → Users → Add user** and create an account for each person on the lighting team (email + password). Turn off public sign-ups under **Authentication → Sign In / Providers** so only people you add can get in.
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
5. Paste them into `config.js`:

```js
window.GMS_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "eyJ...",
};
```

The anon key is safe to ship in the app. Row Level Security only lets signed-in team members read or write.

## 2. Hosting (Vercel)

Hosted on Vercel from this repo. Every push to `main` redeploys automatically.
It's a static site with no build step (Framework preset: **Other**, no build command, output directory = root).
`vercel.json` sets the Bluetooth/microphone permissions and stops the service worker from being cached.
HTTPS is automatic, and Web Bluetooth requires it.

## 3. Install on Android

1. Open the site in **Chrome**.
2. Tap **⋮ → Add to Home screen / Install app**.
3. Open it from the home screen. It runs full-screen like a native app.
4. Turn on Bluetooth and Location. Android needs Location for Bluetooth scanning.

On a laptop, open it in Chrome and click the install icon in the address bar.

## 4. Using it

1. **Close LotusLamp X** on every phone. A controller only accepts one connection at a time.
2. Tap **+ Connect** and choose `MELK-OA10 …`. Repeat for each light.
3. Tap lights to select them. Controls apply to the selected lights.
4. **Show tab:** pick the service at the top, add songs, and set up cues. During the service, tap **Next cue**. Tap ✎ on a cue (or long-press it) to edit it.

| Key | Action |
|---|---|
| Space / → | Next cue |
| ← | Previous cue |
| 1–9 | Jump to cue |
| B | Blackout |
| T | Tap tempo |
| F (hold) | Flash white |
| S (hold) | Strobe |
| A | Follow audio on/off |

## What's saved where

| Data | Where |
|---|---|
| Services, songs, cues | Supabase `services` table, one row per service. Syncs live between devices. |
| Scenes, pattern names, favourites, light names | Supabase `library` table, shared by all services |
| Everything above | Also cached on the device, so it keeps working if the Wi-Fi drops and syncs again once you're back online |

**Settings (⚙)** has sign in/out, sync now, and an export/import backup option.

## About the patterns

- The 13 patterns marked ● are confirmed for MELK-OA10.
- The other 220 come from a sibling model (MELK-OA21) that uses the same command format. They'll most likely work, but their names are generic.
- Use the **Pattern lab** to step through codes on the real strip. Give each one the name it has in LotusLamp X (for example "W-R-W Flow"), and set its preview style and colours so the on-screen preview matches. Everyone on the team sees these names.

## Files

```
index.html             app shell
styles.css             monochrome, touch-first UI
app.js                 Bluetooth protocol, show engine, sync
config.js              your Supabase URL + key
manifest.webmanifest   installable app metadata
sw.js                  offline cache
vercel.json            hosting headers
supabase/schema.sql    database tables + security rules
icons/                 app icons
```

Protocol reference: the open-source elkbledom project (Home Assistant integration).
