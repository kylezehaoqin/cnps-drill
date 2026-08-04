# Determination Drill — CNPS 500

Sight-ID trainer for the CNPS **Field Botanist** certification. All 500 taxa from the
Board of Certification's *Common and Characteristic Plants of California* list, drilled
from photographs with typed answers scored the way the Board scores them: one point
genus, one point specific epithet.

Node 18+. No dependencies.

---

## Deploy

### Docker (simplest)

```bash
git clone <your-repo> /opt/cnps-drill && cd /opt/cnps-drill
docker compose up -d --build
docker compose exec drill node scripts/warm.js     # fills the photo cache, ~25 min
```

Serves on `127.0.0.1:8080`. Put nginx in front — `nginx.conf.example` has a working vhost
with TLS and optional basic auth.

### Bare metal

```bash
sudo useradd -r -s /usr/sbin/nologin drill
sudo git clone <your-repo> /opt/cnps-drill
sudo chown -R drill:drill /opt/cnps-drill
sudo cp /opt/cnps-drill/cnps-drill.service /etc/systemd/system/
sudo systemctl enable --now cnps-drill
sudo -u drill node /opt/cnps-drill/scripts/warm.js
```

### Warm the cache before anything else

The app draws photographs from iNaturalist, downloads them once, and serves them from
`data/photos/` thereafter. **Run the warmer before handing the URL over.** Outbound calls
are throttled to roughly one per second to stay inside iNaturalist's rate limits, so a
full run over 500 taxa takes 20–30 minutes and lands around 400–700 MB.

```bash
node scripts/warm.js              # everything not yet cached
node scripts/warm.js --retry      # re-attempt taxa that came back empty
node scripts/warm.js --limit 60   # first 60 cold taxa, for a quick trial
```

A taxon that comes back with no photos is negative-cached for six hours so the running
server does not hammer iNaturalist on every card. `--retry` ignores that cache, so if a
warm run half-failed on a flaky connection you can re-run it immediately rather than
waiting the six hours out.

Watch the progress lines. If everything reports `no photos`, the box has no outbound
network or DNS — stop and fix that rather than letting it grind through all 500.

Coverage on genus-only entries (`Carex spp.`, `Salix spp.`) is thinner than on named
species — expect a handful with no plate. Those still drill from the name.

Once warm, set `OFFLINE=1` and the server never makes an outbound call again.

---

## Using it

**Drill** is the main loop. A photograph appears, you type the determination, and it
scores genus and epithet separately before revealing the determination slip. Grade
Again / Hard / Good / Easy — `1`–`4`, or Enter to accept the suggested grade.

**Exam** runs 100 taxa photo-only with no feedback until the end, scored against the 75%
pass mark. Every miss is pushed back to the front of the drill queue. This is the honest
readiness signal; the drill tally is not.

**Setup** changes apply immediately — no reload, no lost place. Worth knowing:

- **Interval ladder.** Default is *Cram*: a card comes back at 1 min, 6 min, 20 min, 1 h,
  4 h, 12 h, 1 day, 2 days. Ordinary spaced repetition schedules in days and weeks, which
  is useless when the exam is Friday. Switch to *Long term* after the exam.
- **Exam date** turns on the countdown and the per-day target.
- **Family filter.** The list is lopsided — Asteraceae is 72 taxa, Poaceae 37,
  Fabaceae 24. Those three are over a quarter of everything. Grinding them one family at
  a time works better than shuffling all 500.
- **Strict spelling** demands an exact match. Off by default: a misspelling that still
  identifies the taxon takes the point and comes back amber.
- **Profile** is the save key. Progress writes to the browser instantly and mirrors to
  the server under that name, so a phone and a laptop on the same profile stay in sync.
  A different name is a separate deck.

**Progress** ranks families worst-first and lists leeches (3+ lapses). Leeches want a
photo session, not another flip.

---

## Storage

Progress is written to `localStorage` synchronously on every answer, then mirrored to
`data/states/<profile>.json` on a short debounce. Either can fail without taking the
other down; the status line under the drill card says which happened. On load, whichever
copy has more total reps wins.

There is no authentication. Anyone who can reach the URL can read and overwrite any
profile. For a public VPS, turn on basic auth in the nginx config.

Back up by copying `data/states/`, or use **Export JSON** in Setup.

---

## Layout

```
server.js              http, state API, iNaturalist photo proxy + disk cache
scripts/warm.js        bulk prefetch
public/                index.html, app.js, styles.css
data/taxa.json         the 500 taxa
data/photos/<id>/      cached plates + meta.json (attribution, licence)
data/states/           saved progress per profile
```

Environment: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR`, `PHOTOS_PER_TAXON` (6),
`OFFLINE` (set to `1` to disable outbound fetching).

---

## Credits and licensing

Taxon list: CNPS Board of Certification, *500 Common and Characteristic Plants of
California*, revised 9 Oct 2019 with minor edits 17 Mar 2020. Nomenclature follows the
Flora of North America Editorial Committee (1993+) and *The Jepson Manual* (2012).

Photographs are fetched from iNaturalist filtered to CC0 / CC-BY / CC-BY-NC / CC-BY-SA /
CC-BY-NC-SA only. Photographer attribution and licence are stored alongside each image
and displayed under the plate on reveal. Keep it that way — the licences require it, and
none of them permit redistributing the cache as a dataset.

**One caveat on the taxon list.** CNPS marks genus-level-only taxa in red on the source
PDF, and colour does not survive text extraction. Every `spp.` entry is flagged, which
catches 60 of them, but check the Excel version on the CNPS study guide page against the
Browse tab in case a red-marked entry is not an `spp.`
