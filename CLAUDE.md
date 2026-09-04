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
either side of the wire.

| File | What it owns |
| --- | --- |
| `server.js` | Everything with a route, a schedule or a file on disk: accounts, providers, ESPN schedules, poster rendering, the Stremio resources, the background warmers. |
| `networks.js` | Which national network is carrying a game, and which of the account's saved links stand behind that network. |
| `autopick.js` | Re-choosing a network's channels from the newest published sweep - the rules deciding which channels *are* a network, then the quality ladder over those. |
| `m3u.js` | M3U/EPG parsing and the shared background playlist cache. |
| `streamcheck.js` | Reads published stream sweeps from streamcheck.pro (a Metabase public dashboard) - alive/dead, codec, resolution, bitrate. |
| `quality.js` | Turns one of those readings into a band, a score and a badge line. Measures nothing itself. |
| `posters.js` | Matchup poster art drawn from team colours and marks. |
| `wrestling.js` | Wrestling schedules, scraped from the promotions, because nothing publishes them. |
| `public/*.html` | `index.html` the account dashboard, `watch.html` the watch portal, `admin.html` the operator page. Tailwind from CDN, Font Awesome from CDN, vanilla JS inline at the bottom of each file. |

`networks.js`, `autopick.js`, `posters.js` and `quality.js` are pure
logic over plain data with no Express and no filesystem, deliberately, so
a rule can be run against a real provider table offline. That is the
testing story here: there is no test suite, no linter and no CI. A change
to one of those modules is checked by exercising it with `node -e` against
real data; a change to a route is checked by running the app.

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
`SPORTIO_DATA_DIR`, `STREAMCHECK_REFRESH_TIME`, `STREAMCHECK_REFRESH_TZ`.
The app starts without an encryption key on purpose, so the first-run
setup can generate one - registration and login stay blocked until it is
real and persistent.

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
- **Nothing slow on a visitor's request.** Playlists, EPGs, league
  schedules and provider catalogs are warmed on timers and read from
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
