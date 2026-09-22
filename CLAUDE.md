# Sportio Live

Live sports, served from the viewer's own IPTV subscription. Two front
ends over one server: a Stremio/Nuvio addon (manifest, catalogs, meta,
streams under `/user/:uuid/...`) and a browser watch portal at `/watch`.
The schedule comes from ESPN's public APIs; the playable link for a game
comes from the account's own provider, matched to the network ESPN says
is carrying it.

The repository is public. The accounts are not - see Secrets below.

## Layout

Node 24, Express 4, five dependencies, no build step and no framework on
either side of the wire. The image also carries ffmpeg, for ffprobe.

| File | What it owns |
| --- | --- |
| `server.js` | Everything with a route, a schedule or a file on disk: accounts, providers, ESPN schedules, poster rendering, the Stremio resources, the background warmers. |
| `networks.js` | Which national network is carrying a game, and which of the account's saved links stand behind that network. |
| `autopick.js` | Re-choosing a network's channels from the newest published sweep - the rules deciding which channels *are* a network, then the quality ladder over those. |
| `m3u.js` | M3U playlist parsing and the shared background playlist cache. |
| `streamcheck.js` | Reads published stream sweeps from streamcheck.pro (a Metabase public dashboard) - alive/dead, codec, resolution, bitrate. |
| `quality.js` | Turns one of those readings into a band, a score and a badge line. Measures nothing itself. |
| `bundles.js` | Resellers that carry other services under one login and renumber every channel (Flix-Streams: Strong + Trex). Nothing published describes a provider marked as one, so testing is the only reading its channels have and auto-pick leaves it alone. |
| `probe.js` | Measures one stream with ffprobe - resolution, frame rate, scan, bitrate counted off the wire. For any provider's channels, when somebody asks, as many at once per login as that provider is set to allow (`testsAtOnce` on the provider, capped for a reseller by the `maxTestsAtOnce` its service sells in `bundles.js`). Where a published sweep covers the same channel, the later of the two readings is the one used. Judges nothing; `quality.js` does that. |
| `posters.js` | Matchup poster art drawn from team colours and marks. |
| `wrestling.js` | Wrestling schedules, scraped from the promotions, because nothing publishes them. |
| `bkfc.js` | Bare Knuckle FC's schedule, scraped for the same reason - ESPN carries no bare knuckle. Merged into the MMA section. |
| `public/*.html` | `index.html` the account dashboard, `watch.html` the watch portal, `admin.html` the operator page. Tailwind from CDN, Font Awesome from CDN, vanilla JS inline at the bottom of each file. |

`networks.js`, `autopick.js`, `bundles.js`, `posters.js` and `quality.js` are pure
logic over plain data with no Express and no filesystem, deliberately, so
a rule can be run against a provider table offline. That is the testing
story here: there is no test suite, no linter and no CI. A change to one
of those modules is checked by exercising it with `node -e`; a change to
a route is checked by running the app. Both happen against a table or an
account made for the purpose, never against the live instance - see
below for what that looks like and what it cannot reach.

## Running it

```bash
docker compose up -d --build
```

Serves on `http://localhost:2323`. `HOST_PORT` in `.env` moves the host
side only - the container always listens on 2323, so nothing inside the
image has to stay in step. `docker compose --profile tailscale up -d`
adds a Tailscale sidecar that terminates TLS and proxies in.

`npm start` runs it directly for a quick loop, and needs `npm install`
first - `node_modules/` is gitignored and normally exists only inside the
image.

Environment: `ENCRYPTION_KEY` (64 hex chars, AES-256-GCM, encrypts saved
provider credentials), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PORT`, `HOST`,
`SPORTIO_DATA_DIR`, `STREAMCHECK_REFRESH_TIME`, `STREAMCHECK_REFRESH_TZ`,
`PROBE_SAMPLE_SECONDS` (seconds of stream a test reads, overriding a
reseller's `testSeconds`; unset, 10 for Flix-Streams and 20 otherwise),
`FFPROBE_PATH`.
The app starts without an encryption key on purpose, so the first-run
setup can generate one - registration and login stay blocked until it is
real and persistent.

## This checkout is not the running instance

The instance people actually use runs somewhere else. What is here is
source: no container, no `data/`, no `.env`, and `docker` is often not
even on PATH. The commands above are how the server is run where it
lives, not a description of this machine.

So a change is never checked against the live instance, an account on
it, or a real provider. Do not fetch a real playlist URL, do not open a
real stream, do not call a route on the deployed host, and do not reason
about what the running app is holding as though it could be looked at.
Where a symptom can only be explained by live state - a stale cache, a
provider's own answer, how many channels the last refresh pulled - say
which log line or screen would settle it and ask, rather than guessing
in a confident voice.

A check here looks like one of these instead:

- **The pure modules** - `networks.js`, `autopick.js`, `bundles.js`,
  `posters.js`, `quality.js` - run under `node -e` against a table
  written to mirror the real naming conventions. This is the strongest
  signal available locally and most rule changes are fully checkable
  this way.
- **A route** is checked by booting a throwaway instance and driving it
  with `curl`: `npm start` with `SPORTIO_DATA_DIR` pointed at a scratch
  directory, a freshly generated `ENCRYPTION_KEY`, a spare `PORT`, and a
  small local HTTP server serving a hand-written M3U. Register an
  account against that and nothing real is touched. Note that a new
  `ENCRYPTION_KEY` makes the previous scratch run's stored credentials
  unreadable, which reads as a provider that lost its playlist.
- **The dashboard's inline JS** is checked by slicing a block out of
  `public/index.html` and running it under `new Function` with stubs for
  what it touches. That catches a runtime error and wrong output; it
  does not catch anything about how the page looks or whether a button
  is wired up, so say plainly that the UI went unclicked.

Two things simply cannot be confirmed from here, and the honest move is
to name them rather than imply otherwise. ffprobe is not installed, so
every channel test comes back "ffprobe is not installed on the server" -
enough to exercise storing, hiding and the badge path, never a real
measurement; the image carries ffmpeg and that is where a reading gets
confirmed. And there is no published streamcheck table in a scratch
account, so auto-pick reports `no-published-data` and its ranking has to
be exercised through `autopick.js` directly.

## Secrets

Never commit anything under `data/` (registered accounts, credentials
encrypted at rest but still user data), `.env`, or a playlist URL - a
provider's username and password ride in the path of those. All are in
`.gitignore`; do not add a file that routes around it, and do not paste a
real playlist URL, stream URL or account uuid into code, a comment or a
commit message.

## How this codebase is written

The comments carry the reasoning, not the mechanics. A comment here says
why the code took this shape, what it used to do, and what went wrong
with that - usually with the measurement that settled it ("549 channels
matched a bare search for fox, about a third of them the network wanted";
"keying by tvg-id silently discarded 2,048 distinct stream URLs"). Match
that. Do not narrate what the next line does, and do not leave a change
uncommented when the reason for it is not visible in the code.

Other habits worth keeping:

- **Tables, not branching.** Networks, sports, endpoints, themes and
  auto-pick rules are arrays and objects. Adding a network should be an
  edit to `NETWORKS` and nothing else.
- **Third-party sources fail soft.** ESPN, streamcheck.pro and the
  wrestling sites are all somebody else's interface and can change
  without notice. A failure keeps what is already held and lets the app
  carry on; it does not take a page down.
- **Nothing slow on a visitor's request.** Playlists, league schedules
  and provider catalogs are warmed on timers and read from
  cache. If a change puts a fetch back on the request path, warm it
  instead.
- **Migrate on read.** Stored accounts are folded into the current shape
  by `migrateAccountProviders` when they are read, not by a migration
  pass. An account nobody touches keeps working; one that is saved gets
  rewritten for free. Legacy fields are deleted once the new shape holds
  the same data, so a password is never stored in two places.
- **Scope every stream id to its provider.** Ids are assigned per service
  and collide across them. A reading looked up in the wrong published
  table is not a miss - it confidently describes somebody else's channel.
- **Log counts, not identities.** The warmers and schedulers report
  totals. Where an account has to be named, `accountTag` logs the first
  eight characters of the uuid and never the whole of it.

## Commits

History is linear on `main` - no merge commits, no PRs, one commit per
finished change.

Subject: imperative, sentence case, no trailing period, no prefix or
scope tag, and it says what changed in the app's own terms - "Let one
account carry several IPTV providers", "Keep the auto-pick list where the
reader left it". Not "fix: providers array".

Body: prose in paragraphs, wrapped near 76 characters. Lead with the
problem as it was experienced, then what the change does about it, then
anything measured. Bullet lists are not the style here.

End every commit with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Pushing

**After making any change with Claude Code, commit it and push it to the
branch that is currently checked out.** Do not leave finished work
sitting in the working tree, and do not ask first - `git push origin
HEAD` to whichever branch is checked out, `main` or `dev`. Push to the
checked-out branch and no other; if the change belongs somewhere else,
switch branch first and say so.

Two things this does not license: committing files that are not part of
the change (the working tree may hold somebody else's work in progress -
stage by path, never `git add -A`), and pushing something known to be
broken. If a change cannot be verified, say so in the response rather
than holding the commit back.
