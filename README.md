# Crate

Paste a link — a track, an album, a playlist, a SoundCloud set — and get MP3s
on disk with correct tags: real title, real artist, real album, track number,
year, genre, and the actual release cover art.

The audio comes from YouTube or SoundCloud via `yt-dlp`. The metadata and
artwork come from the Spotify Web API. A messy upload title like
`Rick Wade - Shinjuku Strut [HQ VINYL RIP]` is treated as a search hint and
then thrown away, so what lands on disk is tagged from the real release.

**Spotify is never an audio source.** Its streams are DRM-protected and Crate
does not touch them — it reads metadata from the official API and finds the
audio elsewhere.

---

## What it does

- **Nothing gets silently skipped.** The full track list is written to a
  manifest before a single byte is downloaded, counts are checked against the
  source's own total, and unavailable tracks become visible failed rows with
  reasons — never quiet omissions. When a batch finishes you get a count:
  *"39 of 42 downloaded, 3 failed"*.
- **Library-aware.** Before downloading, every track is checked against your
  library *by tags rather than filename*, so a track another tool saved as
  `Artist - Title.mp3` is recognised as the same recording Crate would name
  `Title - Artist.mp3`. Remixes and edits count as separate tracks.
- **Watched playlists.** Capture a playlist once, then check it for new tracks
  and download them whenever you choose. Each playlist has its own folder.
  Nothing runs on a timer.
- **Proper tagging.** ID3v2 with title, artist, album artist, album, track and
  disc numbers, year, ISRC, embedded JPEG cover art, and the Spotify track ID
  for exact future re-tagging. Optional genre tagging via MusicBrainz, and
  optional ReplayGain loudness tags (tags only — audio is never altered).
- **Polite by design.** Per-host rate limiting, `Retry-After` honoured exactly,
  exponential backoff with jitter, and a circuit breaker that pauses a host
  that starts throttling and resumes by itself. Rate limiting never fails a
  track.
- **Resumable.** Close it mid-batch and it picks up where it left off.

There is deliberately **no** proxy rotation, user-agent spoofing, CAPTCHA
solving, DRM circumvention, or signed-in-session cookie use.

---

## Installing

**You need [Node.js](https://nodejs.org) 18 or newer.** Nothing else — the
audio tools are fetched for you.

**1. Get the code.** Either download the ZIP from the green *Code* button on
this page and unzip it, or clone it:

```bash
git clone https://github.com/Yaboiama/crate.git
cd crate
```

**2. Install.**

```bash
npm install
```

As well as the npm packages, this fetches the two binaries Crate needs:

- **yt-dlp** — the standalone build from the official yt-dlp GitHub releases,
  into `bin/`. No Python required. Crate checks its version at launch and
  keeps it up to date; a stale yt-dlp fails every download with a confusing
  `403`, and that is by far the most common cause of things breaking.
- **ffmpeg** — via the `ffmpeg-static` npm package.

If the yt-dlp download fails (a firewall, say), use *Settings › Tools ›
Download yt-dlp* inside the app, or point `ytdlpPath` at a copy you already
have.

**3. Run it.**

```bash
npm start
```

**4. Set your library folder** in *Settings › Library*, and add Spotify
credentials in *Settings › Metadata* — see below.

### Making a desktop shortcut (Windows)

Point a shortcut at `node_modules\electron\dist\electron.exe` with the
argument `.` and set *Start in* to the project folder.

---

## Spotify credentials

Matching needs a free Spotify app: create one at the
[Spotify developer dashboard](https://developer.spotify.com/dashboard), tick
**Web API**, and paste the client ID and secret into *Settings › Metadata*.
Crate uses the client-credentials flow — no login required for matching.

Without credentials, downloads still work, but tracks are tagged from their
upload titles and shown desaturated to mark them as unmatched.

### Read this before you file a bug about playlists

**How many tracks Crate can read from a Spotify playlist link depends entirely
on how old your Spotify app registration is.** This is not something the app
can work around.

| Your Spotify app | `/v1/playlists/{id}/tracks` | Playlist link reads |
|---|---|---|
| Registered **recently** | `403 Forbidden` | **first 100 tracks only** |
| Registered **a while ago** (older registrations are not restricted) | `200 OK` | **the whole playlist, any size** |

Spotify refuses the playlist-tracks endpoint to developer apps registered
under its current policy — including for playlists you own yourself, and with
a signed-in user token. Extended Quota Mode lifts the restriction but requires
a registered business entity with 250,000+ monthly active users, so a personal
app cannot qualify. Older app registrations were not affected and still work.

Tested directly: two freshly created apps both returned `403` on every
playlist, while an older registration returned `200` and paged a 1,364-track
playlist in about six seconds.

**So:**

- If you have credentials from a Spotify app you registered **some time ago**,
  use those and playlist links of any size just work.
- If you only have a **new** app, Crate falls back automatically and reads the
  first 100 tracks, and tells you when it had to. For longer playlists, open
  the playlist in Spotify, click a track, press **Ctrl+A** then **Ctrl+C**, and
  paste the copied links into Crate instead — that route has no limit.

Crate tries each route in order (official API → `spotdl` if installed →
Spotify's public embed), so it uses the best access available to you without
any configuration.

Credentials are stored in plain text in your user-data folder. That is
acceptable for a local single-user app, but they are never logged, never put
in error messages, and never committed here.

---

## Notes

- **Downloading from YouTube runs against its terms of service.** That is your
  call to make about your own personal use; it is stated here so nobody is
  surprised.
- Matching runs *before* downloading, so "skip existing" can check the real
  destination before any network work — re-running a playlist costs almost
  nothing.
- The manifest (`queue.json` in your user-data folder) is the contract: every
  track in a pasted playlist gets a row before any download starts, and rows
  are only ever removed by you.
- `scripts/fix-cover-art.js` repairs MP3s whose embedded artwork is mislabelled
  (WebP declared as JPEG), which some players — Traktor among them — reject as
  "unsupported cover art file type". It rewrites only the image, preserving
  the audio and every other tag byte-for-byte, and runs as a dry run unless
  you pass `--write`.

## Licence

MIT — see [LICENSE](LICENSE).
