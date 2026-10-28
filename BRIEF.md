# Crate — build brief

Hand this file to Claude Code as the first thing it reads. It explains what the
project is, what already exists, what to build next, and the two rules that
matter most: **nothing gets silently skipped**, and **we behave like a polite
client so we don't get rate limited or blocked.**

---

## 1. What this is

A desktop app for one person on one machine. You paste a link — a single track,
an album, a playlist, a SoundCloud set — and you get MP3s on disk with correct
tags: real song title, real artist, real album, track number, year, and the
actual release cover art.

The thing that makes this different from every other YouTube-to-MP3 tool: the
metadata does **not** come from the video. A YouTube upload called
`Rick Wade - Shinjuku Strut [HQ VINYL RIP]` with a channel avatar as its
thumbnail should end up on disk as a file tagged with the correct title, the
correct artist, the correct album, and the correct sleeve. The video title and
thumbnail are treated as a *search hint* and then thrown away.

### The split that makes this work

| Job | Source | Why |
|---|---|---|
| The audio | YouTube / SoundCloud, via `yt-dlp` | This is where the audio actually is |
| The metadata + cover art | Spotify Web API | Clean, structured, correct release data |

**Spotify is never an audio source.** Its streams are DRM-protected; we don't
touch that. When a Spotify link is pasted, we read the track list and metadata
from the official API, then find the audio elsewhere. This is also the
*highest-quality* path, because we have perfect metadata before we start.

Downloading from YouTube runs against its terms of service. That is the user's
call to make about their own personal use; it is noted here so nobody is
surprised by it later.

---

## 2. Current state of the repo

```
crate/
├── package.json
├── BRIEF.md              ← this file
├── README.md
├── electron/
│   ├── main.js           ← window, settings store, manifest, engine
│   └── preload.js        ← contextBridge IPC surface
└── renderer/
    ├── index.html        ← titlebar, link bar, queue list, settings panel
    ├── styles.css        ← full design system, no framework
    └── app.js            ← queue rendering, live updates, settings binding
```

Vanilla JS renderer, no build step. `npm install && npm start`.

### Already real — do not rewrite these

- **The whole interface.** Link bar, dense queue rows, per-row live status and
  progress, five-tab settings panel, status strip. Design system is in
  `styles.css` with tokens at the top; follow the existing conventions.
- **Settings persistence** — `settings.json` in `app.getPath('userData')`.
- **The manifest** — `queue.json`, same folder. Atomic writes via write-to-temp
  then rename.
- **Concurrency, retry with backoff, resume-on-launch** — the control flow
  exists and is driven by the settings values.
- **The IPC contract** in `preload.js`. Keep the channel names and event shapes;
  the renderer is built against them.

### Stubbed — this is the work

Two functions in `electron/main.js`, both clearly marked:

- `expandLink(url)` — currently returns fake rows
- `engine.run(row)` — currently walks a row through the pipeline stages on
  timers and fails ~12% of the time on purpose

Everything around them is already what the real thing will use.

---

## 3. Architecture

```
  paste link
      │
      ▼
  expandLink()  ──────► N manifest rows, each with status: pending
      │                 WRITTEN TO DISK BEFORE ANY DOWNLOAD STARTS
      ▼
  engine queue (respects concurrency limit + rate limiter)
      │
      ▼
  engine.run(row) for each track:
      │
      ├─ 1. resolve   find the audio URL if we only have artist+title
      ├─ 2. download  yt-dlp → temp file
      ├─ 3. convert   ffmpeg → mp3 at chosen bitrate
      ├─ 4. match     Spotify search → scored candidate → release
      ├─ 5. art       fetch cover at chosen size
      ├─ 6. tag       node-id3 writes ID3v2 + embedded art
      └─ 7. place     move into the library folder structure
      │
      ▼
  status: done  (or failed, with the row kept and retryable)
      │
      ▼
  reconciliation: compare manifest count vs done count, report gaps loudly
```

### Dependencies to add

| Package | Role |
|---|---|
| `yt-dlp` | Audio download. Ship the **standalone binary** — no Python install needed. |
| `ffmpeg-static` | Bundles an ffmpeg binary as an npm dep. |
| `node-id3` | Writes ID3v2 tags and embeds cover art. Pure JS. |

Spotify needs no SDK — it's plain `fetch` against the Web API.

---

## 4. Rule one: nothing gets silently skipped

This is the single most important behaviour in the app. The user's complaint
about existing tools is that a 200-track playlist finishes and quietly delivers
187 files with no indication which 13 are missing.

### 4.1 Expand first, download second

`expandLink()` must produce the **complete** track list and write it to
`queue.json` before a single byte of audio is fetched. The manifest is the
contract: if a row exists, that track is owed to the user.

### 4.2 Playlist expansion must not truncate

This is where tools quietly lose tracks. Three specific traps:

**YouTube / SoundCloud** — use `yt-dlp --flat-playlist -J <url>`. The JSON
includes both `entries` and `playlist_count`. **Compare them.** If
`entries.length !== playlist_count`, do not proceed silently — retry the
expansion, and if it still mismatches, surface an explicit warning naming the
gap. Never treat a short list as success.

**Spotify** — the playlist tracks endpoint pages at 100 items. Follow `next`
until it is null. Compare the total collected against `total` from the first
response. Same rule: mismatch is an error, not a shrug.

**Unavailable entries** — playlists contain deleted, private and
region-blocked items. These get a manifest row with status `failed` and a
plain-language reason, *not* omission. The user should be able to see "3 tracks
in this playlist are no longer available" rather than wonder where they went.

### 4.3 Row states

```
pending  → not started, or waiting for its next attempt
working  → in flight right now
done     → file exists on disk, verified non-zero, tags written
failed   → gave up after exhausting retries; error message retained
skipped  → user chose "skip existing" and the file was already there
```

A row is only `done` after the finished file has been stat'd on disk and found
to be non-zero. Never mark done off the back of a process exit code alone.

### 4.4 Persistence rules

- Write the manifest on **every** state change, debounced ~250ms.
- Always write to `queue.json.tmp` then `rename()`. A crash mid-write must
  never corrupt the manifest.
- On launch, any row left in `working` (i.e. the app died mid-download) gets
  reset to `pending` and requeued. This already exists — keep it.
- Rows are never auto-deleted. Only the user clears them.

### 4.5 Reconciliation report

When a batch drains — no rows left `pending` or `working` — run a reconciliation
pass and surface the result in the status bar:

- All rows `done` → "42 of 42 downloaded"
- Anything else → "39 of 42 downloaded, 3 failed" with the **Retry failed**
  button made prominent

The user should never have to count files in a folder to find out what happened.

### 4.6 Per-track isolation

Run one `yt-dlp` invocation per track, not one per playlist. A single track that
hangs or 404s must not be able to take down the batch. Each invocation gets its
own timeout (`trackTimeoutSec`), and a timeout kills that process and marks that
row only.

---

## 5. Rule two: be a polite client

The user's worry is "don't get me banned". The honest answer is that there is no
trick for this — the thing that gets you rate limited is **making a lot of
requests quickly**, and the fix is to make fewer requests, more slowly, and back
off properly when told to.

Personal-scale use with sane pacing rarely trips anything. Aggressive parallelism
is what causes trouble.

### 5.1 Pacing

- **Default concurrency: 2.** The settings slider goes to 8, but the default
  should be 2 and the hint should say plainly that going higher usually makes a
  large playlist *slower* overall because of throttling.
- **Global rate limiter, per host.** A token bucket keyed by hostname, so
  metadata lookups and downloads share one budget. Cap at roughly 1 request per
  second per host for API calls.
- Pass `yt-dlp` a gap between its own requests:
  `--sleep-requests 1 --sleep-interval 2 --max-sleep-interval 6`. The randomised
  interval also spreads load rather than arriving in a rhythmic burst.
- **Bandwidth cap option.** Add a setting wired to `yt-dlp --limit-rate`.
  Default it to off, but offer 1M/2M/5M. Not saturating the connection is both
  polite and less conspicuous.

### 5.2 Backoff

- **Honour `Retry-After` exactly** when a 429 comes back. Never retry sooner
  than the server asked. This matters more than anything else in this section.
- Otherwise exponential backoff with **full jitter**:
  `delay = random(0, min(cap, base * 2^attempt))`, base 2s, cap 5 minutes.
  Jitter matters — synchronised retries are what turn one failure into a
  thundering herd.
- Distinguish error classes and treat them differently:

| Error | Treatment |
|---|---|
| 429, 503 | Back off hard, respect `Retry-After`, trip the circuit breaker |
| Network timeout, socket reset | Normal retry ladder |
| 404, "video unavailable", private, region-locked | **Do not retry.** Mark failed immediately with a clear reason — retrying cannot fix it and only adds load |
| Extractor error from `yt-dlp` | Do not retry. Prompt the user to update yt-dlp |

### 5.3 Circuit breaker

After 3 consecutive rate-limit responses from a host, pause **all** work against
that host for a cooling-off period (start at 5 minutes, double up to 30). Show
it in the status bar in plain language: *"YouTube is rate limiting. Paused for 5
minutes, then continuing automatically."*

The queue is not cancelled and rows are not failed — work resumes by itself. The
user's playlist still completes, just later. This is the single most effective
thing in the app for staying out of trouble, because it stops a bad situation
escalating while the user is away from the machine.

### 5.4 Cache aggressively

Every request you don't repeat is free politeness.

- Cache the Spotify bearer token until its actual expiry (~1 hour). Don't
  request a fresh one per track.
- Cache Spotify search responses to disk keyed by a normalised query string.
  Re-running the same playlist should hit almost entirely cache.
- Use the **batch** endpoints: `/v1/tracks?ids=` takes up to 50 IDs,
  `/v1/albums?ids=` up to 20. One request instead of fifty.
- Cache cover art by album ID. A 12-track album needs one image download, not
  twelve.
- Honour `skipExisting` before doing any network work at all — check the
  destination path first.

### 5.5 Keep yt-dlp current

Extractors break regularly when sites change. A stale binary produces confusing
failures that look like blocking but aren't. Add a startup check for the
installed version, and surface a plain "update available" prompt rather than
letting the user debug a broken extractor.

### 5.6 Explicitly out of scope

Do **not** build any of the following, and don't suggest them:

- Proxy or IP rotation
- Rotating user-agents or fingerprints to look like different clients
- CAPTCHA solving or bot-detection bypass
- Anything that circumvents Spotify's DRM

These are attempts to evade enforcement rather than avoid triggering it, and
they're outside what this project does. Politeness and patience are the whole
strategy.

On `--cookies-from-browser`: it exists, and it unlocks age-gated content by
using the signed-in session. Leave it out. Attaching a real account to bulk
downloading concentrates all the risk on that account, which is the opposite of
what the user asked for. If a specific track is age-gated, failing that one row
with a clear reason is the better outcome.

---

## 6. The metadata matcher

The heart of the product. Getting this right is what makes the app worth using.

### 6.1 Parse the source title

YouTube titles are messy. Normalise before searching:

- Strip bracketed noise: `[HD]`, `(Official Video)`, `(Official Audio)`,
  `[Free Download]`, `[HQ]`, `[VINYL RIP]`, `(Lyrics)`, `(Visualizer)`, and
  channel tags like `[Label Name]`
- Split on the first ` - ` / ` – ` / ` — ` into artist and title
- **Preserve mix and version info** — `(Extended Mix)`, `(Kolter Remix)`,
  `(Club Dub)`, `(Radio Edit)`. These are not noise; they identify a distinct
  release. The user's library is full of remixes and edits, and matching a remix
  to the original is a *wrong* answer, not a near-miss.
- Normalise `feat.` / `ft.` / `featuring` to one form
- Fold case and strip diacritics for comparison only, never for output

### 6.2 Search

Try in order, stopping at the first result that clears the threshold:

1. `q=track:"{title}" artist:"{artist}"` — the field-scoped query
2. `q="{artist} {title}"` — freeform
3. `q="{title}"` alone, then filter candidates by artist similarity

### 6.3 Score the candidates

Weighted, producing 0–1, compared against `matchThreshold` (default 0.72):

| Signal | Weight | Notes |
|---|---|---|
| Title similarity | 0.45 | Token-set ratio. Penalise hard if remix/version markers differ. |
| Artist similarity | 0.30 | Check against all listed artists, not just the first |
| Duration delta | 0.25 | ≤3s apart scores full; degrade linearly to 0 at 20s apart |

Duration is the strongest signal available for catching a plausible-looking
wrong match, because it's independent of how anyone spelled anything. Weight it
properly.

### 6.4 Choose the right release

Once a track matches, the *album* choice still matters for the cover art. Given
several albums containing the same recording:

- Prefer `album_type: "album"` or `"single"` over `"compilation"`
- Prefer the **earliest** release date — this avoids tagging everything with a
  "Greatest Hits" or "Best Of 2019" sleeve
- Prefer a release available in the user's market

Getting this wrong is the difference between the original sleeve and a generic
compilation cover, which is precisely what the user is trying to escape.

### 6.5 When nothing clears the threshold

Honour the `noMatchBehaviour` setting:

- `source` — tag from the parsed video title, use the source thumbnail, and mark
  the row so the user can see it wasn't properly matched
- `blank` — save the audio with empty tags
- `skip` — mark the row failed and leave it in the queue for manual attention

Whichever path, the row's `tagged` flag stays `false`, so the interface shows the
artwork desaturated rather than pretending it's a confirmed match.

---

## 7. Tagging

Write ID3v2.4 via `node-id3`:

| Frame | Content |
|---|---|
| `TIT2` | Title |
| `TPE1` | Artist |
| `TPE2` | Album artist |
| `TALB` | Album |
| `TRCK` | `track/total` |
| `TPOS` | `disc/total` where present |
| `TDRC` | Year |
| `TCON` | Genre, where Spotify gives one |
| `APIC` | Cover art, JPEG, front cover type 3 |
| `TSRC` | ISRC — worth storing, it's the definitive recording identifier |

Also write the Spotify track ID into a `TXXX` user frame. It makes any future
re-tagging pass exact rather than a fresh guess.

Then place the file using `folderTemplate` and `fileTemplate` from settings.
Sanitise path segments for the platform — strip `/ \ : * ? " < > |`, trim
trailing dots and spaces (Windows), and cap total path length.

---

## 8. Build order

Do these in sequence. Each is independently testable and leaves the app working.

**Phase 1 — real link expansion.** Replace `expandLink()`. Playlists appear in
the list in full with correct counts and no audio downloaded yet. Ship the
truncation checks from §4.2. This is the completeness guarantee, and it should
land first because everything else depends on the manifest being trustworthy.

**Phase 2 — the matcher.** Spotify auth, search, scoring, release selection,
caching. Testable with no downloading at all: paste a link, watch rows resolve
from video titles to real release info. This is the fiddliest part; get it right
while it's isolated.

**Phase 3 — download and convert.** `yt-dlp` per track, structured progress via
`--progress-template` emitting JSON lines, `ffmpeg` conversion, per-track
timeout. Wire real progress to the existing row progress line.

**Phase 4 — tagging and placement.** `node-id3`, cover art fetch and embed,
folder/filename templates, path sanitisation.

**Phase 5 — the polite-client layer.** Rate limiter, circuit breaker, error
classification, `Retry-After` handling, reconciliation report. Some of this
naturally lands earlier; this phase is where it gets properly consolidated and
tested.

**Phase 6 — packaging.** `electron-builder`, bundle the yt-dlp and ffmpeg
binaries, code-sign if the user wants it.

---

## 9. Acceptance criteria

The build is done when all of these hold:

1. A 100+ track playlist produces exactly 100+ manifest rows before any download
   begins, and the count matches the source's own reported total.
2. Killing the app mid-batch and reopening it resumes every unfinished track,
   with nothing lost and nothing duplicated.
3. Pulling the network cable mid-batch results in rows going to `pending` with a
   retry scheduled — not `failed`, and not silently vanishing.
4. When a batch finishes, the status bar states the completed count against the
   total. If they differ, the failures are individually visible with reasons.
5. A YouTube video titled with junk (`ARTIST - TITLE [HQ] (Official Video)`)
   produces a file tagged with the correct clean title, artist, album, year and
   the **release** cover art — not the video thumbnail.
6. A remix matches the remix, not the original.
7. Re-running the same playlist with `skipExisting` on completes almost
   instantly and makes near-zero network requests.
8. A simulated 429 causes a visible cooling-off period and automatic resumption,
   with no rows failed as a result.
9. Nothing in the codebase attempts to disguise the client or bypass any
   protection mechanism.

---

## 10. Settings reference

All already present in the UI and persisted; wire them to real behaviour.

**Library** — `outputDir`, `folderTemplate`, `fileTemplate`, `skipExisting`

**Audio** — `bitrate` (320/256/192/V0), `normalise` (ReplayGain tags only, don't
touch the audio)

**Metadata** — `spotifyClientId`, `spotifyClientSecret`, `matchThreshold`,
`embedArt`, `artSize`, `noMatchBehaviour`, `writeM3u`

**Reliability** — `concurrency` (default 2), `retries`, `retryBackoffMs`,
`trackTimeoutSec`, `resumeOnLaunch`

**Tools** — `ytdlpPath`, `ffmpegPath` (empty means use the bundled binaries)

Add during phase 5: `limitRate` for the bandwidth cap.

### Spotify credentials

Get them from the Spotify developer dashboard: create an app, tick Web API, copy
the client ID and secret. A free account is fine. Use the **client credentials**
flow — no user login, and it covers search, tracks, albums and public playlists.
It cannot read the user's *private* playlists; that needs the authorisation code
flow, which is a later addition if wanted.

Credentials are stored in plain text in the user-data folder. Acceptable for a
local single-user app, but don't log them, don't put them in error messages, and
don't include them in any crash report.

---

## 11. Conventions

- Vanilla JS in the renderer. No framework, no build step. Keep it that way
  unless there's a real reason.
- CSS tokens live at the top of `styles.css`. Use them; don't introduce new
  hex values inline.
- Amber (`--amber`) means *work in progress only*. Don't spend it on decoration
   — its usefulness comes from being rare.
- Keep `contextIsolation: true` and `nodeIntegration: false`. All main-process
  access goes through `preload.js`.
- User-facing strings: sentence case, plain verbs, no apologies. An error says
  what happened and what to do about it. Say "Couldn't reach YouTube, retrying
  in 30 seconds", not "An error occurred".
