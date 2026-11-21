# FloraScan

A working prototype of the **Smart Ground-Truthing and Digital Biodiversity System**
(COS30049 Computing Technology Innovation Project, for NeuonAI / Sarawak Forestry
Corporation, set in Niah National Park).

What it does:

- A **botanist** registers a plant found in the field.
- A **reviewer** checks the record, then approves it or sends it back.
- An approved record is published with a **QR tag** that can be printed.
- A **visitor** scans the tag and reads the plant's page.
- An **administrator** manages staff accounts, roles and settings.
- Every change is logged with who made it and when.

The interface is available in **English, Bahasa Melayu and 中文**.

All data lives in **MySQL**. If the server cannot reach the database, it stops and tells
you why. There is no offline or in-memory mode.

---

## Getting started

### What you need

- **Node.js 22.12 or newer** (older versions cannot run the browser tests)
- **MySQL** or **MariaDB**. The team uses **XAMPP**, so these steps assume that.

### 1. Start MySQL

Open the **XAMPP Control Panel** and click **Start** next to **MySQL**. Start **Apache**
as well if you want to use phpMyAdmin. The app itself does not need Apache.

### 2. Install and run

```bash
npm install
cp .env.example .env
npm run db:setup
npm run dev
```

The default `.env` connects to `mysql://root@127.0.0.1:3306/plant_registry`, which matches
a fresh XAMPP install.

`npm run db:setup` does this:

1. Creates the `plant_registry` database if it does not exist.
2. Runs [`plant_registry_schema.sql`](plant_registry_schema.sql), the main schema
   (23 tables and 1 view).
3. Runs [`Server/schema-extensions.sql`](Server/schema-extensions.sql), which adds a few
   extra columns, settings, the Reviewer role, and the table that stores uploaded photos.
4. Loads the demo data: staff, species, plants, submissions, QR tags, scans and audit history.

If the database already has plants in it, step 4 is skipped so your data is kept.
To wipe everything and start again:

```bash
npm run db:setup -- --reset
```

### 3. Look at the data

Open phpMyAdmin at `http://localhost/phpmyadmin` and pick `plant_registry`. The app and
phpMyAdmin use the same database, so a change in one shows up in the other straight away.

### Common errors

| Message | Fix |
| --- | --- |
| `No database configured` | You have no `.env` file, or it has no `DATABASE_URL`. Copy `.env.example` to `.env`. |
| `Could not reach the database` | MySQL is not running. Start it in XAMPP. |
| `Unknown database 'plant_registry'` | Run `npm run db:setup`. |
| `Access denied for user 'root'` | Your MySQL root user has a password. Add it to `.env`: `mysql://root:yourpassword@127.0.0.1:3306/plant_registry` |

**Never commit `.env`** or paste it anywhere public. It is already in `.gitignore`.

### Photos

- **Species photos** come from iNaturalist. A fresh clone does not have them saved locally
  (`Server/data/photos/` is about 28 MB and is gitignored), so they load from the internet.
  Run `npm run import:species` to download them locally. It takes about 10 minutes and is
  safe to run again.
- **Photos uploaded in the app** are saved in the database (`plant_photo_data` table) and
  work offline. Running `db:setup -- --reset` deletes them.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` (or `npm start`) | Start the app over HTTPS |
| `npm run http` | Start over plain HTTP. The camera and "add to home screen" will not work. |
| `npm run db:setup` | Create the database and tables, and load demo data if empty |
| `npm run db:setup -- --reset` | Delete everything and rebuild from scratch |
| `npm run db:reset` | Same as above |
| `npm run db:seed` | Reload only the demo data (tables stay as they are) |
| `npm test` | Run all three test suites. **This reseeds your database first.** |
| `npm run test:i18n` | Check translations only. No server needed. |
| `npm run test:api` | Check the API only. No browser needed. |
| `npm run test:ui` | Check the screens in a real browser only |
| `npm run port` | Pick a new random port |
| `npm run import:species` | Rebuild the species list from GBIF, iNaturalist and Wikipedia |
| `npm run import:tints` | Work out a background colour for each photo (shown while it loads) |
| `npm run build`, then `npm run preview` | Make a production build and serve it |

---

## How the team works

### Branches

The code is split into layers. Each layer has its own branch and its own folder.
**Only work inside your own folder.** That way two people never edit the same file.

| Branch | Folder | Who |
| --- | --- | --- |
| `main` | Everything. All work is merged here. | NY only |
| `frontend` | `FloraScan-Web-App/` (screens, components, styles, API client) | Web app team |
| `backend` | `Server/` (API, database code, login, QR, certificates) | Server team |
| `database` | `plant_registry_schema.sql`, `scripts/` (schema, seed data) | Data model owner |

The frontend and backend never import each other's code. They only talk over HTTP, so a
screen change and an API change can happen at the same time without conflicts.

`main` must always work. Nobody pushes to it directly.

### Day-to-day

Keep your layer branch. Do not delete it after a merge.

```bash
git checkout frontend
git pull

# ... make your changes inside your own folder ...
npm test

git add -A
git commit -m "Sort the species picker by scientific name"
git push
```

Then open a pull request into `main` on GitHub. NY checks that the layers still work
together and the tests pass, then merges it.

**After anything is merged into `main`, update your branch:**

```bash
git checkout frontend
git merge main
```

Do this every time, not once a week. Branches that fall behind are what cause painful
merge conflicts.

### Shared files

These files do not belong to any one layer, so they are the only place two branches can
clash:

```
package.json  package-lock.json  vite.config.js
README.md  .env.example  .gitignore  tests/
```

- **Changes to these go through NY on `main`.**
- Need a new package? Ask NY. Don't add it to `package.json` on your branch. Two branches
  adding packages at the same time break `package-lock.json`.
- You can add tests in `tests/` on your branch. If two branches change the same spot,
  NY sorts it out.

### A feature that needs both frontend and backend

1. **Backend first.** Build the API endpoint and its tests on `backend`, and get it merged.
2. **Frontend second.** Merge `main` into `frontend` so the endpoint is there, then build
   the screen.

If the two parts really can't be split, make one short-lived branch from `main` for that
feature, merge it, and tell the layer owners to pull.

### Rules

- **Stay in your own folder.**
- **Run `npm test` before you push.** A broken `main` blocks everyone.
- **Merge `main` into your branch often.** Never merge one layer branch into another.
- **Never commit** `.env`, passwords, or anything in `.certs/`.
- **Only NY merges into `main`.**

---

## Using it on a phone

When the server starts, the terminal shows two addresses and a QR code:

```
This computer    https://localhost:44xxx
Phone / tablet   https://192.168.0.133:44xxx   (same Wi-Fi or hotspot)
```

- The port is picked at random the first time and saved in `proto.config.json`, so it stays
  the same after a restart. Run `npm run port` to change it.
- Scan the QR code with your phone, or open `/connect` for a bigger QR code and other
  network addresses.
- Your phone and computer must be on the **same Wi-Fi or hotspot**.

On a laptop the app looks like a website. On a phone it looks like an app with a tab bar
at the bottom. You can switch between the two from the floating demo button, which is handy for
showing the phone layout on a projector.

### Why HTTPS, and the security warning

Phone browsers block the camera, GPS and "add to home screen" on plain `http://` addresses.
So the server uses HTTPS by default, with a certificate it creates itself on first start
(saved in `.certs/`, which is gitignored).

Because this certificate is made locally, every browser shows a warning the first time.
This is expected. Nothing leaves your network. Accept it once:

| Browser | What to tap |
| --- | --- |
| Chrome / Android | **Advanced** → **Proceed to 192.168.x.x (unsafe)** |
| Safari / iOS | **Show Details** → **visit this website** → **Visit Website** |
| Edge | **Advanced** → **Continue to** |

**On iPhone, also trust the certificate.** Otherwise the home-screen icon shows as a plain
letter "F", and the camera may not work. Open **`/connect`** in Safari on the phone and follow
**Trust this server on your phone**:

1. **Download certificate** → **Allow**
2. **Settings** → **Profile Downloaded** → **Install**
3. **Settings** → **General** → **About** → **Certificate Trust Settings** → turn on **FloraScan local CA**
4. Delete the old home-screen icon and add it again

Good to know:

- The certificate only works for `localhost` and private network addresses, so it cannot be
  used to fake a real website.
- If your laptop's IP address changes, the server makes a new certificate automatically and
  the phone keeps trusting it.
- When you are finished, remove the profile in **Settings** → **General** → **VPN & Device
  Management**.
- Never share `.certs/ca-key.pem`. Deleting `.certs/` creates a new certificate, and phones
  will need to trust it again.

### Add it to the home screen

When you open the site on a phone, a bar offers to add FloraScan to your home screen.

| Phone | How |
| --- | --- |
| **Android** (Chrome) | Tap the button in the bar. This only works over HTTPS. |
| **iPhone / iPad** | Must be done by hand in Safari: **Share** → **Add to Home Screen**. iOS has no one-tap install. |

The **Open on phone** screen (`/connect`) shows the steps for both.

Once added, the app opens full screen, and pages you have already visited still open
without a signal.

**Blank icon on iPhone?** iOS caches icons heavily. Delete the old shortcut and add it again.

---

## Signing in

Staff sign in at **`/login`** with their email address and password, the same way the real
system will work. There is no longer a way to jump into an account without its password.

A floating button in the bottom-right corner (**Ctrl/Cmd + K**) shows who is signed in and
lets you:

- go to **Staff sign in**, or sign out
- change theme, language, and website/phone layout
- replay the welcome screen (**Intro**)

It is for demos only and comes out before release.

### Staff accounts

The staff are fictional. Each seeded account's password is the part of the email before the
`@`, followed by `123`. The addresses use the reserved `.test` domain, which can never receive
mail, so no real person gets a recovery-code email from the demo data.

| Role | Name | Email | Password |
| --- | --- | --- | --- |
| Administrator | Farah Hamid | `farah.hamid@florascan.test` | `farah.hamid123` |
| Administrator | Kevin Tan | `kevin.tan@florascan.test` | `kevin.tan123` |
| Botanist | Dr Grace Lim | `grace.lim@florascan.test` | `grace.lim123` |
| Botanist | Daniel Jugah | `daniel.jugah@florascan.test` | `daniel.jugah123` |
| Reviewer | Dr Aisyah Rahman | `aisyah.rahman@florascan.test` | `aisyah.rahman123` |
| Ranger | Ahmad Rosli | `ahmad.rosli@florascan.test` | `ahmad.rosli123` |
| Ranger | Nurul Aini | `nurul.aini@florascan.test` | `nurul.aini123` |
| Ranger | Jonathan Ngau | `jonathan.ngau@florascan.test` | `jonathan.ngau123` |
| Ranger | Mary Liew | `mary.liew@florascan.test` | `mary.liew123` |

What each role can do:

| Role | What they can do |
| --- | --- |
| Administrator | Accounts, roles, activity log, audit trail, settings |
| Botanist | Register, edit, archive and resubmit plants; manage species; print tags; view visitor reports; set up sensors |
| Reviewer | Check every botanist submission: fix it, approve it, or send it back with a note |
| Ranger | IoT sensor alerts only. Cannot register or edit plants. |

**Five wrong passwords in a row lock the account for 15 minutes.** The sign-in page counts
down the attempts left, and while the lock lasts even the right password is refused. A correct
sign in resets the count. An administrator can unlock early from **Staff accounts** (open the
person, then **Unlock account**), and resetting the password also clears the lock. Locks show in
the activity log and audit trail. The limits are `MAX_FAILED_LOGINS` and `LOCK_MINUTES` in
`Server/api.js`.

An account an administrator creates, or a password an administrator resets, gets a new random
temporary password. It is shown to the administrator once, with a copy button, and must be
changed at the next sign in. To see a deactivated account refused at sign in, deactivate one
from **Users** in the admin dashboard.

**Already have the database from before this change?** Run `npm run db:setup -- --reset` to
load these accounts. It deletes and rebuilds your local database.

How roles work:

- A role is a set of permissions such as `plant.create` or `plant.approve`. The API checks
  the permission, not the role name. Adding a new role means adding database rows, not
  changing code. (This is how the Reviewer role was added in issue #8.)
- **Nobody can approve their own record.** No role has both `plant.create` and
  `plant.approve`, and the API also blocks a reviewer from approving something they submitted.
- Only records waiting for review can be approved or returned. Archived or already-published
  records can't be published again by mistake.
- Running `npm run db:setup` on an older database adds the Reviewer role and updates the
  permissions. It does **not** add the demo reviewer account. Use `npm run db:setup -- --reset`
  for that, or create one in **Staff accounts**.

---

## Welcome screen

First-time visitors see a short introduction screen. On a computer it offers **Start
exploring**. On a phone it offers to add the app to the home screen first. It only shows
once per browser.

It never appears when someone arrives by scanning a QR tag. They go straight to the plant.

---

## Things to try

1. **QR tags.** As a botanist, open a published plant → **QR tag** tab → download or print.
   Scan it with your phone, or go to `/scan` and pick a tag.
2. **Review workflow.** As a botanist, **Register a plant** and submit it. Switch to the
   reviewer → **Review queue**. Use **Correct details** to fix something, then approve it or
   send it back with a note. Back as the botanist, **My submissions** shows the result. A
   returned record has **Fix and resubmit**, and the reviewer then sees both notes.
3. **Unknown species.** Register a plant without choosing a species. It always goes to
   review, and the reviewer can't approve it until a species is set.
4. **Skip review.** As admin, go to **System settings** and turn off `require_approval`.
   Now a botanist's new plant is published straight away.
5. **Archiving.** Archive a published plant and scan its tag: it says "no longer on
   display". Restore it and the same tag works again.
6. **Access control.** As a ranger, go to `/staff/register`. The screen says which
   permission is missing, and the API refuses the request too.
7. **Audit trail.** As admin, open **Audit trail** and click a quick question, such as
   **Who approved a plant?** or **Who changed a system setting?**. Each entry shows who did
   it, what they did, which record (plants link to the record), the value before and after,
   and when. **Activity log** shows sign-ins, failed logins and blocked requests.
8. **Hidden locations.** Open a critically endangered plant as a visitor: no location is
   shown. Switch to a botanist and the coordinates appear. Searching by trail name doesn't
   reveal it either.
9. **Printing tags.** As a botanist, **Print QR tags** → select all → print. Three tags per
   row on A4.
10. **Photo upload.** Register a plant with a photo from your phone's camera. It is saved in
    the database and is still there after a restart.
11. **Languages.** Click the globe in the header (or **Account** on
    the phone) and pick **BM** or **中文**. Every screen changes, and the choice is remembered.

---

## Translations

Supported: English, Bahasa Melayu and Simplified Chinese (issue #5).

In a component, wrap English text in `t()` from `FloraScan-Web-App/src/lib/i18n.js`:

```jsx
<h1>{t('Plant register')}</h1>
toast(t('{code} published.', { code: plant.plant_code }))
t('{name} submitted {code}', { name: <strong>{who}</strong>, code })  // placeholders can be elements
```

- The English text is the key. Malay and Chinese go in `lib/locales.js` like this:
  `'English': ['Melayu', '中文']`.
- Use `{placeholders}` instead of joining strings, so each language can put words in its
  own order.
- For text stored in a list and translated later, mark it with `msg('...')` so the checker
  finds it.

`npm run test:i18n` fails if a string is missing its Malay or Chinese version, if a
translation drops a `{placeholder}`, or if a key is built at runtime.
`node tests/i18n.test.mjs --report` also lists text that was never wrapped in `t()`.

Only the interface is translated. Plant data (Wikipedia descriptions, field notes, staff
names) is shown as written. Common server messages are translated; other server messages
stay in English.

---

## QR tags and scanning

### What address a tag uses

A printed tag is fixed to a post for years, so its link must keep working. The server
chooses the address, in this order:

1. the `public_base_url` setting (Admin → **System settings**)
2. the `PUBLIC_BASE_URL` environment variable
3. this computer's network address (fine for a demo on the same Wi-Fi)

**Set `public_base_url` before printing real tags.** Otherwise they point at a
`192.168.x.x` address that only works on your Wi-Fi.

### Three ways to scan

1. **In-app scanner.** Scan screen → **Start camera**. You need to accept the certificate
   warning first.
2. **From a photo.** Scan screen → **Upload a photo** to read a QR code from your gallery.
3. **Your phone's normal camera app.** Tags are ordinary web links, so this always works.

On iPhone, Safari may still block the camera unless you trust the certificate (see above).
If so, use option 2 or 3.

---

## Project structure

```
plant_registry_schema.sql   Main database design: 23 tables, 1 view, roles and permissions
Server/
  index.js          Starts Express + Vite on one port, HTTPS, prints the QR code
  api.js            All the API routes: login, permissions, plants, review, QR, admin
  sql.js            The only file that talks to MySQL
  db.js             Data functions built on sql.js, plus cached settings and permissions
  passwords.js      Password hashing (bcrypt)
  schema-extensions.sql   Extra tables, columns and settings the prototype needs
  seed.js           Builds the demo data
  seed-store.js     Data lists used by seed.js (not used while the app runs)
  seed-species.js   20 hand-written Bornean species
  species-data.js   Loads species.json, or the hand-written list if it's missing
  data/species.json 80 species with photos and coordinates (made by the importer)
  certs.js          Creates the local HTTPS certificates
  port.js, net.js   Random port and network address detection
FloraScan-Web-App/
  index.html
  src/
    App.jsx         Page routes and permission checks
    components/     Layout (web + phone), animations, shared UI
    screens/        Public pages; staff/ holds the staff pages
    lib/            API client, session, formatting, icons, translations
    styles/         theme.css, app.css, motion.css
  public/           App manifest, service worker and icons (for home-screen install)
.github/
  CODEOWNERS                Who reviews the shared files
  pull_request_template.md  Checklist every pull request fills in
scripts/
  db-setup.mjs        Create the database and tables, then load demo data
  seed-mysql.mjs      Load demo data into MySQL
  test-db.mjs         Reset the database before tests; refuses a remote database
  import-species.mjs  Download species, photos and locations from public sources
  photo-tints.mjs     Work out each photo's placeholder colour
  build-icons.mjs     Generate the app icons
tests/
  i18n.test.mjs     Translation checks
  api.test.mjs      API checks: permissions, publishing, validation, audit, hidden
                    locations, photo upload, QR addresses, archiving
  ui.test.mjs       Browser checks: every page under every role, forms, QR from photo,
                    hidden locations, paging, reduced motion, popups, narrow screens
```

### How it works

- **One server, one port.** Vite runs inside Express, so the API and the web app share one
  address. That is why the phone only needs one link.
- **All data is in MySQL.** Only `Server/sql.js` talks to the database, and every query uses
  parameters (no values are pasted into SQL strings).
- **Small cache.** Roles, permissions and settings are kept in memory because they are
  checked on every request. They are reloaded whenever they change.
- **Fast list pages.** A page of plants loads in a fixed number of queries, not one per plant.

### About the tech stack

The proposal says the final app will use React Native (Expo) with React Native Web. This
prototype uses plain React with Vite because it is quicker to build for a demo. The screens,
API, database and permissions all carry over. Only the UI components would change.

---

## Tests

Start the server first (`npm run dev`), then in a second terminal:

```bash
npm test             # all three suites
npm run test:i18n    # translations only (no server needed)
npm run test:api     # API only (no browser needed)
npm run test:ui      # opens headless Chrome or Edge
```

Things to know:

- **Tests reset your database first**, because they create, approve and archive real records.
- **Tests refuse to run on a database that isn't on your computer**, so they never mess up
  a shared database.
- The tests work with HTTPS or HTTP. They detect which one the server uses.
- The UI tests find Chrome or Edge on their own. If yours is somewhere unusual, set
  `CHROME_PATH`.

What they cover:

- **`test:api`**: who can and can't do what (for each role and for visitors), that nothing
  unapproved is ever public, input checks that match the database rules, the full review
  workflow, and that every change is audited.
- **`test:ui`**: opens every page as every role and fails on any console error. It also tests
  QR scanning from a photo, hidden locations, reduced-motion mode, bad form input (empty,
  out of range, script tags, SQL-like text, emoji), and checks nothing scrolls sideways at
  360, 390 and 414 px wide.

### Three layout bugs that are easy to bring back

- **Long text widening the page.** A grid column set to `1fr` can grow to fit one long
  unbroken string (like a pasted URL) and push the page sideways. Use `minmax(0, 1fr)` with
  `overflow-wrap: anywhere`. The UI tests submit a 900-character note to catch this.
- **Popups not covering the screen.** A `position: fixed` element inside a parent that has a
  `transform` (every page has one, for the page animation) only covers that parent. `Modal`
  is rendered into `document.body` to avoid this, and the tests check the backdrop fills the
  screen.
- **Role switcher covering the footer.** The switcher sits in the bottom-right corner, so the
  footer leaves space for it. The tests scroll to the bottom and check no link is hidden.

---

## Where the data comes from

`npm run import:species` builds `Server/data/species.json` from:

| Source | Used for | Licence |
| --- | --- | --- |
| [GBIF](https://www.gbif.org) | Which plants are recorded in Sarawak, names (including Malay), IUCN Red List status, real sighting locations | CC BY-NC 4.0 / CC0, depending on the dataset |
| [iNaturalist](https://www.inaturalist.org) | Photos | Creative Commons; the photographer and licence are shown on each photo |
| [Wikipedia](https://en.wikipedia.org) | Species descriptions | CC BY-SA 4.0 |

- Only Creative Commons photos are used. They are never edited, and every photo shows its
  credit.
- **The species are real. The individual plant records are made up** for the demo (plant
  IDs, trail locations, who registered them). Real GBIF locations are kept on the species
  record only, not passed off as the location of a demo plant.
- Each conservation status is marked as either a real IUCN assessment or a project estimate.
  Many Bornean trees have never been assessed, so lots show **NE** (Not Evaluated). That is
  accurate, not missing data.

### Hidden locations for endangered plants

Showing exactly where a rare plant grows helps poachers. So for visitors who are not signed
in as staff, the API removes the coordinates, location notes and site name. Search and
filters can't be used to get around this.

The `protect_locations` setting decides which plants are protected: `off`, `VU`, `EN` or
`CR` (that level and anything more endangered). The demo data sets it to `CR`.

This happens **on the server**, so the hidden data is never sent to the browser at all.

### How photos load

- While a photo loads, its space shows the photo's average colour instead of grey (from
  `npm run import:tints`; without it, a colour is picked from the file name).
- Each photo's space is reserved in advance so the page doesn't jump.
- The first row of photos loads straight away; the rest load as you scroll.
- If a species has no Creative Commons photo, a drawn SVG picture is shown instead, labelled
  *Illustrative placeholder*. It only shows parts the plant actually has (for example, no
  flower for a conifer).

---

## Not built yet

**IoT plant monitoring** is built: `/staff/iot` shows live readings and alerts from the
ESP32 sensor kit over MQTT. The firmware and setup steps are in `iot-kit/README.md`.

**Also not built yet** (as planned in the proposal): saved drafts, a separate "changes
requested" status, password reset by email, a superuser role, a map of plants, and
registering plants offline. (Pages you've visited do work offline, but you can't submit a
new plant without a signal yet.)

**Hosting is on hold.** Everyone runs it on their own computer for now. When it is hosted,
only settings need to change:

- `DATABASE_URL`, or `DB_HOST` / `DB_USER` / `DB_PASSWORD`
- for a database that needs TLS: `MYSQL_SSL_CA_CERT` (the certificate) or `MYSQL_SSL_CA`
  (a path to it)

No certificates are stored in this repository.

---

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The server won't start | MySQL probably isn't running, or you haven't run `npm run db:setup`. See *Common errors* above. |
| The phone can't open the site | Usually Windows Firewall is blocking Node. Allow it on private networks, or try another address from `/connect`. Addresses marked *virtual* (WSL, Docker, VMs) won't work from a phone. |
| The port is already in use | Run `npm run port`. |
| The camera won't open on the phone | You're probably on plain HTTP. Use `npm run dev` (HTTPS). |
| Tests suddenly fail | Reset the database: `npm run db:setup -- --reset`. |
| Tests say *"refusing to run against a remote database"* | Your `.env` points to a database that isn't on your computer. |

## Security demonstration

Rate limits and browser security headers are documented in [docs/security-demo.md](docs/security-demo.md), including the classroom presentation and a framing test. Run `npm run test:security` and `npm run demo:security` without a database to verify them.
