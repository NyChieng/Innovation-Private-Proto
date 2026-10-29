import crypto from 'node:crypto';
// The fixture store, not the database: this file generates the demo dataset,
// and scripts/seed-mysql.mjs writes it into MySQL.
import { db, insert, nowIso, notify, notifyPermission, audit, activity, reset } from './seed-store.js';
import { SPECIES_DATA, photoExists, tintFor } from './species-data.js';
import { hashPassword, DEMO_PASSWORD } from './passwords.js';

const SPECIES = SPECIES_DATA.species;

/* Deterministic pseudo-random, so every run of the demo looks the same. */
let _s = 20260925;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b, dp = 2) => Number((a + rnd() * (b - a)).toFixed(dp));
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

/* Niah National Park, Miri Division, Sarawak. */
const NIAH = { lat: 3.8167, lon: 113.7833 };

const SITES = [
  'Great Cave Trail, marker 4',
  'Great Cave Trail, marker 11',
  'Traders Cave boardwalk',
  'Painted Cave Trail, upper section',
  'Madu Trail, stream crossing',
  'Bukit Kasut summit path',
  'Subis limestone ridge, west face',
  'Riverside boardwalk, Sungai Niah',
  'Park HQ interpretive garden',
  'Nursery bench A',
  'Nursery bench B',
  'Botanic plot 3, restoration trial',
  'Jalan Niah entrance avenue',
  'Longhouse trail, km 1.2',
];

export function seed() {
  // Calling this twice should produce one dataset, not two stacked on top of
  // each other - which is what happened when the store was global.
  reset();

  /* ---------------------------------------------------------------- */
  /* Roles, permissions, role_permissions  (schema section 8)          */
  /* ---------------------------------------------------------------- */
  const roles = [
    { id: 1, name: 'admin', label: 'Administrator', description: 'Manages staff accounts and roles, resets passwords, reviews the activity log' },
    { id: 2, name: 'ranger', label: 'Ranger', description: 'Responds to IoT sensor alerts in the field. Does not register or edit plant records' },
    { id: 3, name: 'botanist', label: 'Botanist / Officer', description: 'Ground-truths plants: registers, edits and archives plant and species records, prints QR tags; sets up sensors' },
    { id: 4, name: 'reviewer', label: 'Reviewer', description: 'Double-checks every plant a botanist registers, then approves it for publication or returns it with a note' },
  ];
  roles.forEach((r) => db.roles.push({ ...r, created_at: nowIso() }));

  const PERMS = [
    ['plant.view_all', 'See plant records in any status, not only approved ones'],
    ['plant.create', 'Register a plant and track own submissions'],
    ['plant.edit', 'Edit any plant record'],
    ['plant.archive', 'Archive or restore a plant record'],
    ['plant.approve', 'Review queue: approve, or reject with a note'],
    ['plant.history', 'View the change history of a plant'],
    ['species.manage', 'Add or edit species and their conservation status'],
    ['qr.print', 'Download and print QR tags'],
    ['qr.manage', 'Replace or deactivate a QR code'],
    ['report.view', 'View public error reports'],
    ['report.resolve', 'Resolve or dismiss public error reports'],
    ['sensor.view', 'View the IoT dashboard: readings, charts, sensor list and alerts'],
    ['alert.resolve', 'Resolve sensor alerts with a note'],
    ['sensor.manage', 'Set up sensors: link to a plant, set alert limits, issue device keys'],
    ['user.view', 'View staff accounts'],
    ['user.manage', 'Create, edit, activate and deactivate staff accounts; reset passwords'],
    ['user.assign_role', 'Change a staff member role'],
    ['system.audit', 'View the activity log and audit trail'],
    ['system.settings', 'Change system settings'],
    ['system.import', 'Run bulk imports'],
  ];
  PERMS.forEach(([code, description]) => insert('permissions', { code, description }));

  const grant = (roleId, codes) => {
    codes.forEach((code) => {
      const p = db.permissions.find((x) => x.code === code);
      if (p) db.role_permissions.push({ role_id: roleId, permission_id: p.id });
    });
  };
  // The prototype lets an admin flip the require_approval switch, so admin
  // also holds system.settings here (the SQL file defers it to a superuser).
  grant(1, ['user.view', 'user.manage', 'user.assign_role', 'system.audit', 'system.settings']);
  // Rangers are in charge of the plants only when a sensor raises an alert.
  // Botanists own the ground-truthing, and nothing they register publishes
  // until a reviewer - a second person - has checked it. Keep this in step
  // with section 6 of Server/schema-extensions.sql.
  grant(2, ['sensor.view', 'alert.resolve']);
  grant(3, ['plant.view_all', 'plant.create', 'plant.edit', 'plant.archive',
    'plant.history', 'species.manage', 'qr.print', 'qr.manage', 'report.view', 'report.resolve',
    'sensor.view', 'sensor.manage']);
  grant(4, ['plant.view_all', 'plant.edit', 'plant.approve', 'plant.history']);

  /* ---------------------------------------------------------------- */
  /* Conservation statuses                                             */
  /* ---------------------------------------------------------------- */
  [['NE', 'Not evaluated'], ['DD', 'Data deficient'], ['LC', 'Least concern'],
   ['NT', 'Near threatened'], ['VU', 'Vulnerable'], ['EN', 'Endangered'],
   ['CR', 'Critically endangered'], ['EW', 'Extinct in the wild'], ['EX', 'Extinct']]
    .forEach(([code, label], i) => insert('conservation_statuses', { code, label, sort_order: i + 1 }));

  const statusId = (code) => db.conservation_statuses.find((c) => c.code === code)?.id ?? null;

  /* ---------------------------------------------------------------- */
  /* Staff accounts                                                    */
  /* Demo password for every account is 'demo1234'.                    */
  /* ---------------------------------------------------------------- */
  const USERS = [
    { role: 1, full_name: 'Neng Yi Chieng', email: 'admin@niah.sarawak.gov.my', title: 'System Administrator' },
    { role: 3, full_name: 'Dr Sue Han Lee', email: 'suehan.lee@niah.sarawak.gov.my', title: 'Senior Botanist' },
    { role: 3, full_name: 'Hans Jia Syn Yee', email: 'hans.yee@niah.sarawak.gov.my', title: 'Botanist' },
    { role: 2, full_name: 'Edmund Guo Qian Yu', email: 'edmund.yu@niah.sarawak.gov.my', title: 'Park Ranger' },
    { role: 2, full_name: 'Lim Yon', email: 'lim.yon@niah.sarawak.gov.my', title: 'Park Ranger' },
    { role: 2, full_name: 'Edward Ngie Jie Ling', email: 'edward.ling@niah.sarawak.gov.my', title: 'Field Ranger' },
    { role: 2, full_name: 'Darren Chong Yue Yang', email: 'darren.chong@niah.sarawak.gov.my', title: 'Field Ranger' },
    { role: 1, full_name: 'Jiaqi Hu', email: 'jiaqi.hu@niah.sarawak.gov.my', title: 'Administrator (on leave)', inactive: true },
    // Appended rather than inserted, so the indexes used further down for the
    // audit history still point at the same people.
    { role: 4, full_name: 'Dr Mei Ling Wong', email: 'meiling.wong@niah.sarawak.gov.my', title: 'Herbarium Curator' },
  ];

  USERS.forEach((u, i) => insert('users', {
    role_id: u.role,
    full_name: u.full_name,
    email: u.email,
    title: u.title,
    phone: '+60 8' + (5000000 + Math.floor(rnd() * 900000)),
    // A real bcrypt hash, salted per account, exactly as the schema specifies.
    // Every demo account shares the same password; the hashes still differ.
    password_hash: hashPassword(DEMO_PASSWORD),
    must_change_password: 0,
    is_active: u.inactive ? 0 : 1,
    email_verified_at: daysAgo(120),
    last_login_at: u.inactive ? daysAgo(41) : daysAgo(between(0, 4, 0)),
    created_by: i === 0 ? null : 1,
    created_at: daysAgo(180 - i * 6),
    updated_at: daysAgo(10),
    deleted_at: null,
  }));

  const admin = db.users[0];
  const botanists = db.users.filter((u) => u.role_id === 3);
  const rangers = db.users.filter((u) => u.role_id === 2 && u.is_active);
  const leadBotanist = botanists[0];
  const reviewer = db.users.find((u) => u.role_id === 4);

  /* ---------------------------------------------------------------- */
  /* Species                                                           */
  /* ---------------------------------------------------------------- */
  SPECIES.forEach((s, i) => insert('species', {
    scientific_name: s.scientific_name,
    common_name: s.common_name,
    local_name: s.local_name,
    family: s.family,
    genus: s.genus,
    species_epithet: s.species_epithet,
    description: s.description,
    characteristics: s.characteristics,
    growth_form: s.growth_form,
    leaf_description: s.leaf_description,
    flower_description: s.flower_description,
    fruit_description: s.fruit_description,
    habitat: s.habitat,
    distribution: s.distribution,
    conservation_status_id: statusId(s.conservation),
    // Provenance, so the page can say where a figure came from instead of
    // presenting an estimate as though it were an assessment.
    conservation_source: s.conservation_source || null,
    authorship: s.authorship || null,
    gbif_key: s.gbif_key || null,
    inat_id: s.inat_id || null,
    wikipedia_url: s.wikipedia_url || null,
    // Real georeferenced records from GBIF. The demo specimens themselves sit
    // in Niah, so these are kept on the species as evidence of where the
    // species has actually been recorded in Sarawak - not as specimen coords.
    occurrence_points: s.occurrence_points || [],
    photo_credits: (s.photos || []).filter((ph) => photoExists(ph.file)).map((ph) => ({
      file: ph.file, credit: ph.attribution, license: ph.license, source: ph.source, url: ph.page,
    })),
    created_by: botanists[i % botanists.length].id,
    created_at: daysAgo(170 - i * 2),
    updated_at: daysAgo(30),
    deleted_at: null,
  }));

  /* ---------------------------------------------------------------- */
  /* Plants - physical specimens                                       */
  /* ---------------------------------------------------------------- */
  let codeSeq = 0;
  const plantCode = () => 'PLT-2026-' + String(++codeSeq).padStart(4, '0');

  const HEIGHTS = {
    tree: [4, 55], palm: [0.6, 3], shrub: [0.8, 4],
    herb: [0.2, 2.5], climber: [0.3, 12], parasite: [0.1, 0.9],
  };

  function makePlant({ species, status, registeredBy, verifiedBy, day, site, proposed = null, notes = null }) {
    const gf = species?.growth_form || 'herb';
    const [hmin, hmax] = HEIGHTS[gf] || [0.5, 3];
    const height = between(hmin, hmax);
    return insert('plants', {
      plant_code: plantCode(),
      species_id: species?.id ?? null,
      proposed_species_name: proposed,
      status,
      latitude: Number((NIAH.lat + (rnd() - 0.5) * 0.045).toFixed(7)),
      longitude: Number((NIAH.lon + (rnd() - 0.5) * 0.045).toFixed(7)),
      altitude_m: between(8, 180, 1),
      gps_accuracy_m: between(3, 12, 1),
      site_name: site,
      location_notes: pick([
        'Left of the boardwalk, 3 m in from the handrail.',
        'On the uphill side of the trail beside a large limestone boulder.',
        'Second specimen after the interpretive panel.',
        'Beside the drainage channel, partly shaded at midday.',
        'In the gap created by the 2024 treefall.',
        'Riverside, about 8 m above the normal water line.',
        'Under closed canopy, deep shade all day.',
      ]),
      height_m: height,
      trunk_diameter_cm: gf === 'tree' ? between(8, 140, 1) : null,
      health_status: pick(['healthy', 'healthy', 'healthy', 'fair', 'fair', 'poor']),
      life_stage: height < (hmax - hmin) * 0.25 + hmin ? 'seedling' : height < (hmax - hmin) * 0.6 + hmin ? 'sapling' : 'mature',
      morphology_notes: notes || pick([
        'Bole straight and clear to the first branch; no visible damage.',
        'Multi-stemmed from the base, probably coppiced after earlier disturbance.',
        'Minor lightning scar on the upper trunk, callusing well.',
        'Epiphytic ferns and orchids established along the main limbs.',
        'Leaf flush in progress at the time of survey.',
        'Slight lean downslope; root plate sound.',
        null,
      ]),
      notes: null,
      view_count: Math.floor(rnd() * 480),
      registered_by: registeredBy.id,
      registered_at: daysAgo(day),
      verified_by: verifiedBy?.id ?? null,
      verified_at: verifiedBy ? daysAgo(day - 0.4) : null,
      created_at: daysAgo(day),
      updated_at: daysAgo(day - 0.4),
      deleted_at: null,
    });
  }

  // Approved, published records - the bulk of the public register.
  // Enough specimens that most species in the list are represented, and the
  // commoner ones appear more than once, as they would in a real park.
  const approvedCount = Math.min(140, Math.round(db.species.length * 1.5));
  for (let i = 0; i < approvedCount; i++) {
    const species = db.species[i % db.species.length];
    makePlant({
      species,
      status: 'approved',
      registeredBy: pick(botanists),
      verifiedBy: reviewer,
      day: between(6, 150, 1),
      // Weighted, not round-robin: a real park has hotspots and quiet corners,
      // and a perfectly even spread across every trail looks invented.
      site: SITES[Math.min(SITES.length - 1, Math.floor(Math.abs(rnd() + rnd() - 1) * SITES.length * 1.35))],
    });
  }

  // Archived - withdrawn from public view but retained.
  makePlant({
    species: db.species.find((s) => s.scientific_name === 'Macaranga gigantea'),
    status: 'archived', registeredBy: pick(botanists), verifiedBy: reviewer,
    day: 96, site: 'Jalan Niah entrance avenue',
    notes: 'Removed during widening of the entrance avenue in August. Record retained; printed tag withdrawn.',
  });
  makePlant({
    species: db.species.find((s) => s.scientific_name === 'Dillenia suffruticosa'),
    status: 'archived', registeredBy: pick(botanists), verifiedBy: reviewer,
    day: 71, site: 'Botanic plot 3, restoration trial',
    notes: 'Specimen died back after the dry spell; replaced by PLT-2026-0022 on the same plot.',
  });

  /* ---------------------------------------------------------------- */
  /* Pending submissions - the reviewer's queue                        */
  /* ---------------------------------------------------------------- */
  const pendingSpec = [
    { sci: 'Licuala orbicularis', site: 'Madu Trail, stream crossing', by: 0,
      note: 'Single undivided leaf just over 80 cm. Deep shade, damp clay bank.' },
    { sci: 'Nepenthes rafflesiana', site: 'Subis limestone ridge, west face', by: 1,
      note: 'Climbing to about 4 m. Upper pitchers only, no ground rosette found.' },
    { sci: 'Eusideroxylon zwageri', site: 'Great Cave Trail, marker 11', by: 2,
      note: 'Large belian, girth well over a metre. Possibly the tree mentioned in the 2019 survey.' },
    { sci: 'Durio graveolens', site: 'Longhouse trail, km 1.2', by: 0,
      note: 'Flowering on the trunk. Photographed at dusk, bats present.' },
    { sci: null, proposed: 'Hoya sp. (waxy leaves, pale globe flowers)', site: 'Painted Cave Trail, upper section', by: 1,
      note: 'Climber on limestone, thick waxy leaves, spherical umbel of pale flowers. Not in the species list yet - provisional genus only.' },
    { sci: null, proposed: 'Bulbophyllum sp. (small orchid on Belian)', site: 'Great Cave Trail, marker 4', by: 3,
      note: 'Small epiphytic orchid on a belian limb about 5 m up. Photographed with zoom; no flowers open yet.' },
  ];

  pendingSpec.forEach((p, i) => {
    const species = p.sci ? db.species.find((s) => s.scientific_name === p.sci) : null;
    const botanist = botanists[p.by % botanists.length];
    const day = between(0.2, 9, 2);
    const plant = makePlant({
      species, status: 'pending', registeredBy: botanist, verifiedBy: null,
      day, site: p.site, proposed: p.proposed || null, notes: p.note,
    });
    const sub = insert('plant_submissions', {
      plant_id: plant.id,
      submission_type: 'new',
      status: 'pending',
      proposed_changes: null,
      submitted_by: botanist.id,
      submitted_at: plant.registered_at,
      reviewed_by: null, reviewed_at: null, review_comment: null,
      created_at: plant.registered_at,
    });
    notifyPermission('plant.approve', {
      type: 'submission.new',
      title: 'New submission awaiting review',
      body: botanist.full_name + ' submitted ' + plant.plant_code + ' from ' + p.site + '.',
      related_type: 'submission', related_id: sub.id,
    });
  });

  /* Rejected - so botanists have something to see under "my submissions". */
  const rejected = [
    { sci: 'Vatica venulosa', site: 'Riverside boardwalk, Sungai Niah', by: 2, day: 22,
      comment: 'Photographs show the fine net venation of Vatica but the fruit wings are not visible, and Shorea cannot be ruled out. Please re-photograph the fallen fruit and the bark slash, then resubmit.' },
    { sci: 'Shorea macrophylla', site: 'Nursery bench B', by: 1, day: 34,
      comment: 'This is a duplicate of PLT-2026-0009, which is already published on the same bench. Closing this one.' },
  ];
  rejected.forEach((r) => {
    const species = db.species.find((s) => s.scientific_name === r.sci);
    const botanist = botanists[r.by % botanists.length];
    const plant = makePlant({
      species, status: 'rejected', registeredBy: botanist, verifiedBy: null, day: r.day, site: r.site,
    });
    insert('plant_submissions', {
      plant_id: plant.id, submission_type: 'new', status: 'rejected',
      proposed_changes: null, submitted_by: botanist.id, submitted_at: plant.registered_at,
      reviewed_by: reviewer.id, reviewed_at: daysAgo(r.day - 1), review_comment: r.comment,
      created_at: plant.registered_at,
    });
    notify({
      user_id: botanist.id, type: 'submission.rejected',
      title: 'Submission returned: ' + plant.plant_code,
      body: reviewer.full_name + ' asked for changes. ' + r.comment.slice(0, 90) + '...',
      related_type: 'plant', related_id: plant.id,
    });
  });

  /* Approved-through-review history, so the queue is not the whole story. */
  db.plants.filter((p) => p.status === 'approved' && p.verified_by).slice(0, 12).forEach((p) => {
    if (p.registered_by === p.verified_by) return;
    insert('plant_submissions', {
      plant_id: p.id, submission_type: 'new', status: 'approved',
      proposed_changes: null, submitted_by: p.registered_by, submitted_at: p.registered_at,
      reviewed_by: p.verified_by, reviewed_at: p.verified_at, review_comment: null,
      created_at: p.registered_at,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Photos - procedural SVG, generated on demand by server/images.js  */
  /* ---------------------------------------------------------------- */
  /**
   * Which shots make sense for a given plant. A conifer has no flowers and
   * Rafflesia has no leaves or bark, so those angles are left out rather than
   * illustrated wrongly - a botanist reviewing the demo would spot it at once.
   * The first shot is always the whole plant, since that is what the card
   * thumbnail and the hero image on the plant page use.
   */
  function anglesFor(sp) {
    if (!sp) return ['habit', 'habitat'];
    const name = sp.scientific_name;
    if (name.startsWith('Rafflesia')) return ['habit', 'flower', 'habitat'];
    if (sp.family === 'Araucariaceae') return ['habit', 'leaf', 'bark', 'habitat']; // conifer: cones, not flowers
    if (sp.growth_form === 'tree') return ['habit', 'leaf', 'bark', 'flower', 'fruit', 'habitat'];
    if (sp.growth_form === 'palm') return ['habit', 'leaf', 'fruit', 'habitat'];
    if (sp.growth_form === 'climber') return ['habit', 'leaf', 'flower', 'habitat'];
    return ['habit', 'leaf', 'flower', 'habitat'];
  }

  db.plants.forEach((p) => {
    const sp = db.species.find((s) => s.id === p.species_id);
    const source = sp ? SPECIES.find((x) => x.scientific_name === sp.scientific_name) : null;
    // Use a photograph whenever we have one. A locally cached copy is
    // preferred (it works with no internet); otherwise point straight at the
    // iNaturalist CDN, and the client falls back between the two.
    const real = (source?.photos || []).filter((ph) => ph.url || photoExists(ph.file));

    if (real.length) {
      // Real photographs from iNaturalist, under Creative Commons. The
      // photographer is credited on the plant page; we never alter the image.
      real.forEach((ph, i) => insert('plant_photos', {
        plant_id: p.id,
        file_path: photoExists(ph.file) ? '/api/photos/file/' + ph.file : ph.url,
        thumbnail_path: photoExists(ph.file) ? '/api/photos/file/' + ph.file : ph.url,
        remote_url: ph.url || null,
        tint: tintFor(ph.file),
        file_name: ph.file || null,
        mime_type: 'image/jpeg',
        size_bytes: 0,
        width_px: null, height_px: null,
        caption: i === 0 ? 'Photographed in the field.' : null,
        credit: ph.attribution || null,
        license: ph.license || null,
        source_name: ph.source || null,
        source_url: ph.page || null,
        is_primary: i === 0 ? 1 : 0,
        uploaded_by: p.registered_by,
        created_at: p.registered_at,
        deleted_at: null,
      }));
      return;
    }

    // No photograph for this species: fall back to the generated illustration.
    const base = (sp?.scientific_name || p.proposed_species_name || p.plant_code).replace(/s+/g, '-').toLowerCase();
    const available = anglesFor(sp);
    const n = Math.min(available.length, 3 + Math.floor(rnd() * 2));
    for (let i = 0; i < n; i++) {
      const angle = i === 0 ? available[0] : available[1 + ((p.id + i) % (available.length - 1))];
      insert('plant_photos', {
        plant_id: p.id,
        file_path: '/api/photos/' + base + '--' + angle + '--' + p.id + '.svg',
        thumbnail_path: '/api/photos/' + base + '--' + angle + '--' + p.id + '.svg',
        file_name: base + '-' + angle + '.svg',
        mime_type: 'image/svg+xml',
        size_bytes: 0,
        width_px: 1600, height_px: 1200,
        caption: {
          habit: 'Whole plant, showing overall habit and setting.',
          leaf: 'Leaf detail, upper and lower surface.',
          bark: 'Bark and trunk detail at breast height.',
          flower: 'Inflorescence at the time of survey.',
          fruit: 'Fruit, collected from beneath the specimen.',
          habitat: 'Surrounding habitat and canopy position.',
        }[angle],
        credit: null,
        license: null,
        source_name: 'Generated illustration',
        source_url: null,
        is_primary: i === 0 ? 1 : 0,
        uploaded_by: p.registered_by,
        created_at: p.registered_at,
        deleted_at: null,
      });
    }
  });

  /* ---------------------------------------------------------------- */
  /* QR codes - issued automatically on publication                    */
  /* ---------------------------------------------------------------- */
  db.plants.filter((p) => p.status === 'approved' || p.status === 'archived').forEach((p) => {
    const qr = insert('qr_codes', {
      plant_id: p.id,
      qr_token: crypto.randomUUID(),
      image_path: null,
      target_url: null, // filled in at request time from the live host
      version: 1,
      status: p.status === 'archived' ? 'inactive' : 'active',
      generated_by: p.verified_by,
      generated_at: p.verified_at || p.registered_at,
      deactivated_at: p.status === 'archived' ? daysAgo(30) : null,
      deactivation_reason: p.status === 'archived' ? 'Specimen removed from display' : null,
      created_at: p.verified_at || p.registered_at,
    });
    const scans = Math.floor(p.view_count / 6);
    for (let i = 0; i < scans; i++) {
      insert('qr_scans', {
        qr_code_id: qr.id, plant_id: p.id,
        user_id: rnd() < 0.12 ? pick([...rangers, ...botanists]).id : null,
        device_type: pick(['android', 'ios', 'android', 'android']),
        ip_hash: crypto.createHash('sha256').update('demo' + i + p.id).digest('hex'),
        scanned_at: daysAgo(between(0, 60, 3)),
      });
    }
  });

  /* ---------------------------------------------------------------- */
  /* Public error reports                                              */
  /* ---------------------------------------------------------------- */
  const approved = db.plants.filter((p) => p.status === 'approved');
  [
    { issue: 'wrong_name', desc: 'The label says Nepenthes ampullaria but the pitchers on this plant are clearly funnel-shaped with a narrow lid. I think it is N. rafflesiana.', name: 'Adeline Tan', email: 'adeline.t@example.com' },
    { issue: 'bad_photo', desc: 'The main photograph is very dark and it is hard to see the leaf shape on a phone in daylight.', name: 'Visitor', email: null },
    { issue: 'wrong_location', desc: 'The tag is about 30 m further along the trail than the map pin shows.', name: 'Mohd Faizal', email: 'faizal@example.com' },
  ].forEach((r, i) => {
    insert('plant_reports', {
      plant_id: approved[i * 5].id,
      reported_by: null,
      reporter_name: r.name, reporter_email: r.email,
      issue_type: r.issue, description: r.desc,
      status: i === 2 ? 'resolved' : 'open',
      handled_by: i === 2 ? leadBotanist.id : null,
      handled_at: i === 2 ? daysAgo(3) : null,
      resolution_note: i === 2 ? 'Coordinates corrected from the ranger GPS track and the record republished.' : null,
      created_at: daysAgo(between(1, 26, 1)),
    });
  });

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */
  [
    ['site_name', 'FloraScan', 'string', 'Shown in headers and page titles'],
    ['park_name', 'Niah National Park', 'string', 'The site this register covers'],
    ['qr_base_url', '/p/', 'string', 'Plant page address the QR codes encode, before the token'],
    ['public_base_url', '', 'string', 'Permanent public address of the site, e.g. https://florascan.example.org. Printed QR codes encode it, so set it before printing any tag for real. Blank uses this machine network address, which suits a demo'],
    ['plant_code_prefix', 'PLT', 'string', 'Prefix for generated Plant IDs'],
    ['require_approval', 'true', 'bool', 'true = botanist entries wait for a reviewer; false = they publish immediately. A "species not listed" entry always waits'],
    ['max_upload_mb', '8', 'int', 'Maximum photo upload size'],
    ['allowed_image_types', '["image/jpeg","image/png","image/webp"]', 'json', 'Accepted MIME types'],
    ['sensor_offline_minutes', '15', 'int', 'A sensor with no reading for this many minutes is shown as Offline'],
    ['protect_locations', 'CR', 'string', 'Withhold exact locations from the public for species at this IUCN category or worse. One of: off, VU, EN, CR. Staff always see the real location'],
  ].forEach(([setting_key, setting_value, value_type, description]) =>
    insert('settings', { setting_key, setting_value, value_type, description, updated_by: null, updated_at: nowIso() }));

  /* ---------------------------------------------------------------- */
  /* Audit + activity history                                          */
  /* ---------------------------------------------------------------- */
  // Every plant, not a sample: a record without any history looks broken on
  // the history tab, and a real register would have an entry for each one.
  db.plants.forEach((p) => {
    audit({
      user_id: p.registered_by, action: 'create', entity_type: 'plants', entity_id: p.id,
      old_values: null, new_values: { plant_code: p.plant_code, status: 'pending' },
    });
    if (p.verified_by) {
      audit({
        user_id: p.verified_by, action: 'approve', entity_type: 'plants', entity_id: p.id,
        old_values: { status: 'pending' }, new_values: { status: 'approved' },
      });
    }
  });
  audit({
    user_id: admin.id, action: 'role_change', entity_type: 'users', entity_id: db.users[6].id,
    old_values: { role: 'ranger' }, new_values: { role: 'ranger', title: 'Field Ranger' },
  });
  audit({
    user_id: admin.id, action: 'password_reset', entity_type: 'users', entity_id: db.users[5].id,
    old_values: null, new_values: { must_change_password: 1 },
  });

  db.users.filter((u) => u.is_active).forEach((u) => {
    activity({ user_id: u.id, action: 'login', detail: 'Signed in from the staff dashboard' });
  });
  activity({ user_id: null, action: 'login_failed', detail: 'Unknown email: ranger@niah.gov.my' });
  activity({ user_id: db.users[7].id, action: 'logout', detail: 'Signed out' });

  /* A couple of unread notifications for the two botanists. */
  const ownApproved = approved.find((p) => p.registered_by === botanists[1].id) || approved[1];
  notify({
    user_id: leadBotanist.id, type: 'report.new',
    title: 'Visitor reported incorrect information',
    body: 'A visitor questioned the species on ' + approved[0].plant_code + '.',
    related_type: 'plant', related_id: approved[0].id,
  });
  notify({
    user_id: botanists[1].id, type: 'submission.approved',
    title: 'Submission published',
    body: 'Your record ' + ownApproved.plant_code + ' was approved and is now public.',
    related_type: 'plant', related_id: ownApproved.id,
  });

  return db;
}
