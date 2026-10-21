# FloraScan 

Clickable prototype for the **Smart Ground-Truthing and Digital Biodiversity System**
(COS30049 Computing Technology Innovation Project — NeuonAI / Sarawak Forestry Corporation,
framed around Niah National Park).

It runs the whole chain end to end: a ranger registers a plant in the field, a botanist
verifies it, the record is published with a QR tag, and a visitor scans that tag and reads
the page. Administrators manage accounts and roles, and every change is recorded against
the person who made it.

Everything is stored in **MySQL**, in the schema defined by
[`plant_registry_schema.sql`](plant_registry_schema.sql) — 24 tables and one view. There is
no in-memory mode and no demo fallback: if the database is not reachable the server refuses
to start and says why, because a prototype quietly serving empty data that is never saved
would be worse than one that stops.

---

## Run it

You need **Node 20.12 or newer** and a **MySQL** server. XAMPP is what the team uses, so
that is what these instructions assume.

### 1. Start MySQL

Open the **XAMPP Control Panel** and press **Start** next to **MySQL**. Start **Apache**
too if you want phpMyAdmin — the app itself does not need it.

### 2. Set up the project

```bash
npm install
cp .env.example .env     # already points at mysql://root@127.0.0.1:3306/plant_registry
npm run db:setup
npm run dev
```

That is the whole setup. `db:setup` does four things in order:

1. connects to your MySQL server and **creates the `plant_registry` database** if it is not
   already there
2. applies [`plant_registry_schema.sql`](plant_registry_schema.sql)
3. applies [`Server/schema-extensions.sql`](Server/schema-extensions.sql), which adds the
   columns and the photo-blob table the prototype needs on top of the schema proper
4. loads the demo dataset — **5,856 rows**: staff, species, specimens, submissions, tags,
   scans and audit history

Run it again and it leaves your data alone. Add `-- --reset` to rebuild from scratch:

```bash
npm run db:setup -- --reset
```

### 3. Have a look at the data

The database shows up in **phpMyAdmin** at `http://localhost/phpmyadmin` as
`plant_registry`. Anything you change there appears in the app on the next request, and
anything you do in the app is visible there — it is one database, not a copy.

### If something goes wrong

| Message | What it means |
| --- | --- |
| `No database configured` | There is no `.env`, or it has no `DATABASE_URL`. Copy `.env.example`. |
| `Could not reach the database` | MySQL is not running. Start it in the XAMPP panel. |
| `Unknown database 'plant_registry'` | You have not run `npm run db:setup` yet. |
| `Access denied for user 'root'` | Your MySQL root account has a password. Put it in `.env`: `mysql://root:yourpassword@127.0.0.1:3306/plant_registry`. |

`.env` is **gitignored**. Never commit it, and never paste it into a chat or an issue.

### Photographs

A fresh clone has no local photograph cache — `Server/data/photos/` is about 28 MB and
gitignored — so images are fetched from iNaturalist instead, using the `remote_url` each
record carries. They still appear, but you need to be online. `npm run import:species`
rebuilds the cache locally; it takes about ten minutes and is safe to re-run.

Photographs **uploaded through the app** are different: they go into the database as bytes,
in `plant_photo_data`, and are served back from `/api/photos/upload/:id`. They work offline
and survive a reseed only if you reseed without `--reset`.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server over HTTPS (the default) |
| `npm run http` | Same, over plain HTTP — the camera and install will not work |
| `npm run db:setup` | Create the database and schema, then load the demo data |
| `npm run db:setup -- --reset` | The same, but rebuild from scratch |
| `npm run db:seed` | Reload the demo data only, leaving the schema alone |
| `npm test` | Both test suites — reseeds the database first |
| `npm run test:api` | API checks only, no browser needed |
| `npm run test:ui` | Browser checks only |
| `npm run port` | Assign a new random port |
| `npm run import:species` | Rebuild the species dataset from GBIF, iNaturalist and Wikipedia |
| `npm run import:tints` | Sample an average colour per photo, used as the loading placeholder |
| `npm run build` / `npm run preview` | Production build, and serve it |

---

## How the team works on this

The repository is split by **layer**, and so are the branches. Each one owns a folder, and
nobody edits a folder that is not theirs — which is what keeps two people from ever
touching the same file.

| Branch | Owns | Who works there |
| --- | --- | --- |
| `main` | the integration branch — everything merges here | NY only |
| `frontend` | `FloraScan-Web-App/` — screens, components, styles, the client API wrapper | the web app people |
| `backend` | `Server/` — the API, the data layer, auth, QR, certificates | the server people |
| `database` | `plant_registry_schema.sql`, `scripts/` — schema, migrations, the seeder | whoever owns the data model |

This works here because the layers really are independent: nothing in
`FloraScan-Web-App/` imports anything from `Server/` or the other way round. They talk
over HTTP and nothing else, so two branches changing a screen and an endpoint at the same
time do not collide at the file level at all.

`main` must always run. Anything a teammate can clone and `npm run dev` straight into is
worth protecting, so work never lands on it directly.

### The loop

Your layer branch is long-lived — you do not delete it after a merge, you keep working on
it.

```bash
git checkout frontend        # your layer, once
git pull

#  ... work, inside your own folder ...
npm test                     # both suites, against your own database

git add -A
git commit -m "Sort the species picker by scientific name"
git push
```

Then open a pull request into `main` on GitHub. NY does the connectivity check — that the
layers still agree with each other and both suites pass — and merges it.

**Then pull `main` back into your branch:**

```bash
git checkout frontend
git merge main
```

Do this every time something lands on `main`, not once a week. A layer branch that has not
seen `main` for ten days is where merge pain comes from; one that merges daily never has
any.

### The shared files

Seven files at the root belong to no layer, and they are the only place two branches can
genuinely conflict:

```
package.json  package-lock.json  vite.config.js
README.md  .env.example  .gitignore  tests/
```

**Changes to these go through NY**, on `main`, rather than being made on a layer branch.
If you need a new dependency, say so rather than editing `package.json` on your branch and
hoping — two branches each adding a package produce a `package-lock.json` conflict that is
miserable to resolve by hand.

`tests/` is shared on purpose. Both suites test the whole stack end to end, so they belong
to nobody in particular; add to them freely on your branch, but expect NY to be the one who
resolves it if two branches add checks in the same place.

### When a change spans two layers

A new feature usually needs both halves — an endpoint in `Server/` and a screen in
`FloraScan-Web-App/` that calls it. That does not fit in one layer branch, so do it in
this order:

1. **Backend first.** Add the endpoint on `backend`, with its API checks, and get it
   merged into `main`.
2. **Then the frontend.** `git merge main` into `frontend` so the endpoint is actually
   there, and build the screen against it.

Two merges rather than one, and the API gets settled before anything is built on top of it
— which is the right order anyway.

If the two halves genuinely cannot be separated, make one short-lived branch off `main`
for that feature alone, merge it, and tell the layer owners to pull.

### Rules worth keeping

- **Stay in your folder.** This is the whole reason the split works. A frontend branch that
  edits `Server/` has given up the guarantee.
- **Run `npm test` before you push.** Both suites, against your own database. A red suite
  on `main` blocks everybody.
- **Merge `main` into your branch often**, and never merge one layer branch into another.
  Everything meets on `main`.
- **Never commit `.env`**, your database password, or anything under `.certs/`. All three
  are gitignored; keep it that way.
- **Connectivity checks and merges to `main` are NY's**, so that one person is always
  looking at whether the layers still fit together.

---

## Running it on your phone

The terminal prints two addresses and a QR code:

```
This computer    https://localhost:44xxx
Phone / tablet   https://192.168.0.133:44xxx   (same Wi-Fi or hotspot)
```

A **random port** is chosen on first run and saved to `proto.config.json`, so the URL and
the printed QR keep working between restarts. `npm run port` picks a new one.

Scan the QR code in the terminal, or open `/connect` in the browser for a bigger one plus
the alternative network addresses. Your phone must be on the same Wi-Fi or hotspot.

The layout follows the screen size: a website on a laptop, an app shell with a bottom tab
bar on a phone. You can force either from the role switcher, so the Android layout can be
demonstrated on a projector.

### Why HTTPS, and the certificate warning

The server runs over **HTTPS by default**, with a certificate signed by a small local
certificate authority generated on first start (kept in `.certs/`, which is gitignored).
This is not optional polish: a phone browser refuses the camera, GPS and the
add-to-home-screen prompt on a plain `http://192.168.x.x` address, and those are most of
what this prototype is for.

Every browser warns once about the local certificate. Accept it and it is remembered:

| Browser | What to tap |
| --- | --- |
| Chrome / Android | **Advanced** → **Proceed to 192.168.x.x (unsafe)** |
| Safari / iOS | **Show Details** → **visit this website** → **Visit Website** |
| Edge | **Advanced** → **Continue to** |

The warning is expected: the certificate is generated locally, because there is no public
domain to certify. Nothing leaves your network. If you need plain HTTP for some reason,
`npm run http` serves it, but the camera will not work.

**Trusting it on an iPhone (needed for the home-screen icon).** Accepting the warning covers
the page, but iOS fetches the home-screen icon separately, refuses the untrusted certificate,
and puts a plain letter "F" on the home screen instead. Trust the local CA once and the icon,
camera and offline mode all work with no warning. Open **`/connect`** on the phone in Safari
and follow **Trust this server on your phone**:

1. **Download certificate** → **Allow**
2. **Settings** → **Profile Downloaded** → **Install**
3. **Settings** → **General** → **About** → **Certificate Trust Settings** → switch on **FloraScan local CA**
4. Delete the old home-screen icon and add it again

The CA is name-constrained to `localhost` and private network addresses, so a phone that
trusts it will never accept it for a public website. The server certificate is reissued
automatically when the laptop's address changes, and the phone keeps trusting it. Remove the
profile when you are done (**General** → **VPN & Device Management**), and never share
`.certs/ca-key.pem`. Deleting `.certs/` makes a new CA, which phones must trust again.

### Add it to your home screen

Open the site on your phone and a bar offers to add FloraScan to the home screen. The two
platforms genuinely differ, and the app detects which one you are on:

| | How it installs |
| --- | --- |
| **Android** (Chrome) | **One tap.** Chrome fires its own install prompt and the bar installs it directly. This needs HTTPS and a registered service worker, which is why the server defaults to HTTPS. Over plain HTTP the button never appears and you have to use the browser menu instead. |
| **iPhone / iPad** | **Always manual.** iOS has no install API on any browser, and only Safari can add to the home screen: **Share** → **Add to Home Screen**. There is no one-tap route to offer. |

The **Open on phone** screen shows both sets of instructions side by side, which is useful
when you are demonstrating on one device and talking about the other.

Either way the result is the same: a home-screen icon that opens full screen with no browser
bars, and pages already visited still open with no signal.

**If the icon comes out blank on an iPhone**, it is almost always one of two things: the
icon had an alpha channel (iOS fills transparency with black rather than compositing it),
or the `apple-touch-icon` link carried no `sizes` attribute. Both are handled here — opaque
PNGs at 152, 167 and 180, declared with explicit sizes, plus `/apple-touch-icon.png` and
`/apple-touch-icon-precomposed.png` at the site root for iOS to probe. iOS caches these
hard, so delete the old shortcut before adding it again.

---

## The demo role switcher

A floating control, bottom right, present on every screen:

- jumps straight into the public visitor or any staff account, no password
- **Ctrl/Cmd + K** opens it; **0** is the visitor, **1–9** are the listed accounts
- also carries the theme and website/phone layout toggles
- shows the deactivated account as unselectable, which is the same check the API applies

This is scaffolding for the demo. It calls `POST /api/auth/switch`, which is clearly marked
prototype-only and comes out before anything ships. The normal login form at `/login` works
too — every demo account uses the password `demo1234`, stored bcrypt-hashed like any other.

### Accounts

| Role | Who | Can |
| --- | --- | --- |
| Administrator | Neng Yi Chieng | Accounts, roles, activity log, audit trail, settings |
| Botanist | Dr Sue Han Lee, Hans Jia Syn Yee | Publish, verify, edit, archive, species list, visitor reports |
| Ranger | Edmund Guo Qian Yu, Lim Yon, Edward Ngie Jie Ling, Darren Chong Yue Yang | Register plants, track own submissions, print tags |
| Administrator | Jiaqi Hu | Deactivated, to demonstrate the check |

Roles are **permission sets**, not hard-coded names. The API checks codes such as
`plant.approve`, so a superuser can be added later as one more role holding every
permission — no new tables, no fourth dashboard.

---

## The welcome screen

A first-time visitor gets a one-screen introduction before the register. What it offers
next depends on the device: a desktop visitor gets **Start exploring**, while a phone
visitor is offered the home-screen install first, because that is what makes it usable on
a trail. It is shown once per browser.

Scanning a tag never shows it — somebody standing in front of a plant wants that plant,
not an introduction. Replay it any time from the role switcher (**Intro**).

---

## What to try

1. **The QR journey.** Sign in as a botanist → open any published record → **QR tag** tab →
   download or print it. Scan it with your phone, or open `/scan` and pick a tag from the list.
2. **The verification workflow.** Switch to a ranger → **Register a plant** → submit it.
   Switch to a botanist → **Review queue** → approve it, or return it with a note. Switch
   back to the ranger → **My submissions** shows what happened.
3. **Species not listed.** Register a plant without choosing a species. It always goes to a
   botanist, whatever the approval setting says, and Approve stays disabled until the
   botanist confirms a species.
4. **The approval switch.** Admin → **System settings** → turn `require_approval` off, then
   register as a ranger again. The entry publishes immediately.
5. **Archiving.** Archive a published record, then scan its tag: "no longer on display".
   Restore it and the same printed tag works again.
6. **Access control.** As a ranger, open `/staff/users` directly. The screen explains which
   permission is missing — and the API refuses the request regardless.
7. **The audit trail.** Admin → **Audit trail**. Every change carries actor, field, old
   value, new value and timestamp. **Activity log** has sign-ins, failed attempts and
   refused requests.
8. **Protected locations.** Open a critically endangered plant as a visitor: the location is
   withheld. Switch to a botanist and the real coordinates appear. Searching the trail name
   does not reveal it either.
9. **Printing tags.** Botanist or ranger → **Print QR tags** → select all → print. Three tags
   per row on A4, ready to cut out.
10. **Upload a photograph.** Register a plant with a photo from your phone's camera. It is
    stored in the database and served back, so it survives a restart.

---

## What a printed tag points at

A QR tag is printed once and then screwed to a post, so the address it carries has to be
one that still works. The server decides it, never the browser that asked for the code —
a botanist printing from a laptop is on `localhost`, and a tag encoding `localhost` sends
every phone that scans it to its own device.

Order of preference:

1. the `public_base_url` setting, which the park points at its real domain
2. this machine's network address, which is what makes the demo work on a phone

**Set `public_base_url` in Admin → System settings before printing tags for real.**
Tags printed now encode a `192.168.x.x` address that only works on this Wi-Fi.

### Scanning a tag

Three ways, all working out of the box now that the server runs over HTTPS:

1. **The in-app scanner.** Scan screen → **Start camera**. Needs the certificate accepted
   first (see above).
2. **Upload a photo.** Scan screen → **Upload a photo** reads the code out of a picture
   already in your gallery. Handy when the light is poor, or you photographed the tag earlier.
3. **Your phone's own camera app.** The tags encode ordinary URLs, so this always works and
   needs nothing installed. This is the real design — the in-app scanner is a shortcut.

On iOS, Safari sometimes still refuses the camera for an untrusted certificate even after
you accept the warning. Trusting the local CA (see above) avoids it; otherwise use options 2 or 3.

---

## How it is put together

```
plant_registry_schema.sql   The design of record: 24 tables, one view, the enums,
                            the CHECK constraints, the roles and permissions
Server/
  index.js          Express + Vite on one port, HTTPS by default, startup QR code
  api.js            The whole REST API: auth, permissions, plants, review, QR, admin
  sql.js            The only module that talks to MySQL: pool, transactions, conversions
  db.js             Data access on top of sql.js, plus the reference cache
  passwords.js      bcrypt hashing and verification
  schema-extensions.sql   Additions the prototype needs on top of the schema proper
  seed.js           Demo content: staff, species, specimens, submissions, audit history
  seed-store.js     The fixture arrays the generator reads - never touched at runtime
  seed-species.js   20 hand-written Bornean species with full botanical detail
  species-data.js   Loads the imported dataset, falling back to the hand-written list
  data/species.json Generated by the importer: 80 species, photos, coordinates
  images.js         Procedural SVG illustrations, used where no photograph exists
  certs.js          The local certificate authority and server certificate
  port.js, net.js   Random-port assignment and LAN address detection
FloraScan-Web-App/
  index.html
  src/
    App.jsx         Routes and permission guards
    components/     Shell (web + phone), role switcher, motion helpers, shared UI
    screens/        Public site, then staff/ for the dashboards
    lib/            API client, session store, formatting, icons
    styles/         theme.css, app.css, motion.css
  public/           manifest.webmanifest, sw.js, icons - the installable web app
.github/
  CODEOWNERS                Who reviews the shared files
  pull_request_template.md  The connectivity-check questions every PR answers
scripts/
  db-setup.mjs        Create the database and schema, then seed it
  seed-mysql.mjs      Load the demo dataset into MySQL
  test-db.mjs         Reseed before a test run, and refuse a remote database
  import-species.mjs  Pull species, photographs and coordinates from the open databases
  photo-tints.mjs     Sample an average colour per cached photograph
  build-icons.mjs     Generate the app icons
tests/
  api.test.mjs      306 API checks: access control, publication control, validation,
                    audit, withheld locations, photo upload and serving, the web app
                    manifest, printed-tag addressing, archiving a record under review
  ui.test.mjs       279 browser checks: every route under every role, form input,
                    QR-from-gallery, hidden locations, pagination, reduced motion,
                    the welcome screen, image loading, dialog overlays, and layout
                    under long text
```

**One Node process, one port.** Vite runs in middleware mode inside Express, so the API and
the app share a single origin — which is what makes the phone hand-off a single URL. Vite's
hot-reload websocket is attached to the same server, so it inherits the TLS rather than
opening a second plain-ws port the HTTPS page would refuse to talk to.

**Everything is real SQL.** `Server/sql.js` is the only module that speaks to MySQL, and
every query is parameterised — no value is ever concatenated into a statement. What stays in
memory is reference data only: roles, permissions, role_permissions and settings, because
the API checks a permission code on every request and reads settings nearly as often. Those
few dozen rows are loaded at boot and reloaded whenever they are written, so the cache
cannot go stale behind an administrator's back.

List pages load their context in batches rather than per row — seven queries for a page of
plants, whatever its length, instead of one per plant per relation.

### A note on the stack

The proposal specifies React Native (Expo) with React Native Web for the real build. This
prototype is plain React with Vite, because for a clickable demo it is faster to stand up
and looks better. The screens, the API contract, the data model and the permission design
all carry over unchanged; only the component library differs.

---

## Tests

```bash
npm test             # both suites
npm run test:api     # no browser needed
npm run test:ui      # drives headless Chrome or Edge
```

Start the server first (`npm run dev`), then run these in a second terminal. Both suites
detect whether the server is on HTTPS or HTTP and follow it.

**They reseed your database before running.** The suites register, approve and archive real
records to exercise the workflow, so they need a known starting state; `pretest` reloads the
demo data first. They also **refuse to run against a database that is not on this machine**,
because that litter is not something to leave in a database anyone else is using.

`test:api` covers the quality targets named in the proposal: access control as negative
tests across the three roles and anonymous visitors, publication control (nothing
unapproved reachable from a public URL), input validation mirroring the schema's CHECK
constraints, the full verification workflow, and audit completeness.

`test:ui` drives a real browser: it renders every route under every role and fails on any
console error, uploads a generated QR photograph to prove the gallery scanner decodes it,
checks that a critically endangered plant's location stays hidden from a visitor but not
from a botanist, and confirms motion collapses under `prefers-reduced-motion`. It also
exercises the forms — empty submits, out-of-range numbers, script tags, SQL-looking
strings, unicode and emoji — checking the interface says something useful each time. It
also checks for horizontal overflow at 360, 390 and 414 px, which is how the narrow-screen
bugs in the tag and account pickers were found.

The UI tests find Chrome or Edge automatically; set `CHROME_PATH` if yours is elsewhere.

### Three faults worth knowing about, because all three are easy to reintroduce

- A grid track written as `1fr` keeps an implicit `min-width: auto`, so a single unbroken
  string — a pasted URL in a ranger's field note — widens the track and drags the whole
  page sideways. The review queue overflowed by nearly 6,000 px this way. Value lists and
  free-text insets now use `minmax(0, 1fr)` with `overflow-wrap: anywhere`, and the UI
  suite registers a record with a 900-character unbroken note to keep it that way.
- A `position: fixed` overlay is contained by any ancestor carrying a transform or
  `will-change: transform` — which every page wrapper does, for the enter animation. A
  dialog rendered in place was clipped to the page element instead of covering the
  viewport. `Modal` portals into `document.body`, and the suite checks the backdrop really
  does fill the viewport, which asserting `.modal` exists never did.
- The demo role switcher is fixed to the bottom-right, so it sits over whatever the
  document ends with. The footer reserves room for it, and the suite scrolls to the
  bottom and checks no footer link is left underneath.

---

## Where the data comes from

`npm run import:species` builds `Server/data/species.json` from three open sources:

| Source | Used for | Licence |
| --- | --- | --- |
| [GBIF](https://www.gbif.org) | Which plants are actually recorded in Sarawak, accepted taxonomy, IUCN Red List category, vernacular names (including Malay), and real georeferenced occurrences | CC BY-NC 4.0 / CC0 per dataset |
| [iNaturalist](https://www.inaturalist.org) | Photographs | Creative Commons, per photo; the photographer and licence are shown on every image |
| [Wikipedia](https://en.wikipedia.org) | Species descriptions | CC BY-SA 4.0 |

The importer only keeps photographs under a Creative Commons licence, stores the credit
string and licence code alongside each one, and never alters the image. Every plant page
shows the photographer under the photograph.

Specimen records themselves — the Plant IDs, the trail locations, the rangers who
registered them — are invented for the demo. The **species** are real; the **specimens**
are not. Real GBIF occurrence coordinates are kept on the species record as evidence of
where the species has been found, not passed off as the location of a demo specimen.

Conservation categories come from the Red List where an assessment exists, and each one
records whether it is a real assessment or a project estimate. Many Bornean trees have
never been assessed, so plenty show as **NE** — that is the real picture, not a gap.

### Protected locations

Publishing an exact coordinate for a critically endangered plant tells collectors where to
go. The API withholds the coordinates, the finding notes and the site name from anyone who
is not signed in as staff, and the protection cannot be worked around through the search
box or the location filter. The `protect_locations` setting controls how far up the Red
List the rule reaches (`off`, `VU`, `EN`, `CR`); it ships set to `CR`.

The rule is applied **server-side**, in the query that builds the response. A hidden field
is never sent to a browser that is not entitled to it, so there is nothing to find in the
network tab.

### How photographs load

Every image sits on its own average colour while it decodes, so a photo resolves out of a
related green rather than out of a grey box. `npm run import:tints` samples those colours
once from the cached files into `Server/data/photo-tints.json`; without it the placeholder
falls back to a tint derived from the filename. Slots reserve their aspect ratio so nothing
jumps as pictures arrive, the first row of each grid is fetched eagerly while the rest stay
lazy, and an image already sitting in cache is detected on mount rather than waiting for a
load event that has already been and gone.

Where no Creative Commons photograph exists for a species, the page falls back to a
generated SVG drawn deterministically from the species name and the shot angle (habit, leaf,
bark, flower, fruit, habitat), clearly marked *Illustrative placeholder*. The angles are
chosen per species, so the conifer never gets a flower and Rafflesia never gets a leaf — a
botanist looking at the demo would notice.

---

## What is not built

**IoT plant monitoring** is a designed-but-empty screen (`/staff/iot`) that says *Coming soon*
and lists what will go there. The sensor kit has not arrived. The `sensor_devices`,
`sensor_readings` and `sensor_alerts` tables and the device-key check are already in the
schema, so the dashboard can be added without disturbing anything else.

Also deferred, in line with the proposal: saved drafts, a separate "changes requested"
state, self-service password reset, the superuser role, a map view of specimens, and
offline field data capture (the service worker caches pages already visited, but a ranger
cannot yet register a plant with no signal and sync it later).

**Hosting is on hold.** The code does not care where MySQL is — `DATABASE_URL`, or
`DB_HOST`/`DB_USER`/`DB_PASSWORD`, is the whole of it, and a provider that needs TLS
verification takes its CA certificate from `MYSQL_SSL_CA_CERT` or a path in `MYSQL_SSL_CA`.
No certificate is kept in this repository. Until a deployment target is settled, everyone
develops and tests against their own machine.

---

## Troubleshooting

**The server will not start.** See the table under *Run it* — it is almost always MySQL not
running, or `db:setup` not run yet.

**The phone cannot reach it.** Almost always Windows Firewall blocking Node on the private
network — allow it when prompted, or check `/connect` for an alternative address. Adapters
marked *virtual* there belong to WSL, Docker or a VM and are not reachable from a phone.

**The port is taken.** `npm run port` assigns a new random one.

**The camera will not open on the phone.** Expected over plain HTTP — see above.

**The tests fail in a way they did not yesterday.** Reseed and try again:
`npm run db:setup -- --reset`. If they fail with *"refusing to run against a remote
database"*, your `.env` is pointing somewhere that is not this machine.
