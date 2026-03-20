/**
 * appwrite/appwrite-setup.js
 *
 * Standalone script to create all Appwrite collections for the Discord bot.
 *
 * Usage:
 *   node appwrite/appwrite-setup.js
 *
 * Required environment variables:
 *   APPWRITE_ENDPOINT    - e.g. https://fra.cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  - e.g. tutorslink
 *   APPWRITE_API_KEY     - Server API key with databases.write scope
 *   APPWRITE_DB_ID       - Database ID (default: tutorslink)
 */

import dotenv from 'dotenv';
dotenv.config();

import { Client, Databases, Permission, Role, AppwriteException } from 'node-appwrite';
import { DB_ID, COLLECTION_IDS } from './collection-ids.js';

const ENDPOINT   = process.env.APPWRITE_ENDPOINT   || 'https://fra.cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || 'tutorslink';
const API_KEY    = process.env.APPWRITE_API_KEY;

if (!API_KEY) {
  console.error('Missing required environment variable: APPWRITE_API_KEY');
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const databases = new Databases(client);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a collection, skipping if it already exists (HTTP 409).
 */
async function createCollection(collectionId, name, permissions = []) {
  try {
    await databases.createCollection(DB_ID, collectionId, name, permissions);
    console.log(`  ✅ Created collection: ${collectionId}`);
    return true;
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      console.log(`  ⏭  Skipped (already exists): ${collectionId}`);
      return false;
    }
    throw e;
  }
}

/**
 * Create a longtext attribute, skipping if the collection already had it.
 */
async function createLongtextAttr(collectionId, key, required = false) {
  try {
    await databases.createLongtextAttribute(DB_ID, collectionId, key, required);
    console.log(`    + attribute: ${key} (longtext)`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // attribute already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}: ${e.message}`);
    }
  }
}

/**
 * Create a string attribute, skipping if already exists.
 */
async function createStringAttr(collectionId, key, size = 512, required = false) {
  try {
    await databases.createStringAttribute(DB_ID, collectionId, key, size, required);
    console.log(`    + attribute: ${key} (string, size=${size})`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}: ${e.message}`);
    }
  }
}

/**
 * Create an integer attribute, skipping if already exists.
 */
async function createIntegerAttr(collectionId, key, required = false) {
  try {
    await databases.createIntegerAttribute(DB_ID, collectionId, key, required);
    console.log(`    + attribute: ${key} (integer)`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}: ${e.message}`);
    }
  }
}

/**
 * Wait for a collection's attributes to finish processing (Appwrite builds
 * attributes asynchronously; we need to wait before adding documents).
 */
async function waitForAttributes(collectionId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const col = await databases.getCollection(DB_ID, collectionId);
    const attrs = col.attributes || [];
    const allReady = attrs.every(a => a.status === 'available');
    if (allReady && attrs.length > 0) return;
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------------------
// Public permissions (any user can read, only server key can write)
// ---------------------------------------------------------------------------
const PUBLIC_READ_PERMS = [
  Permission.read(Role.any()),
];

const SERVER_ONLY_PERMS = [];   // rely on API-key-level access; no public read

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

/**
 * Each collection uses a `data` longtext field to store the full JSON payload.
 * Synced collections also expose a lightweight `entityId` string for
 * cross-app lookups (e.g. the website can filter tutorProfiles by tutorId).
 */
const COLLECTIONS = [
  // ── Synced with Website ──────────────────────────────────────────────────

  {
    id: COLLECTION_IDS.subjects,
    name: 'Discord Subjects',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all") holding a JSON array of subject strings.
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.subjectLevels,
    name: 'Discord Subject Levels',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): { subjectName: levelKey, … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.subjectTutors,
    name: 'Discord Subject Tutors',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): { subjectName: [tutorId, …], … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tutorProfiles,
    name: 'Discord Tutor Profiles',
    permissions: PUBLIC_READ_PERMS,
    // One document per tutor; documentId = tutorId.
    // data: JSON.stringify({ addedAt, students, reviews, rating, username, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // Discord tutorId
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.studentAssignments,
    name: 'Discord Student Assignments',
    permissions: PUBLIC_READ_PERMS,
    // One document per student; documentId = studentId.
    // data: JSON.stringify({ tutorId, subject, assignedAt, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // Discord studentId
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.pendingReviews,
    name: 'Discord Pending Reviews',
    permissions: PUBLIC_READ_PERMS,
    // One document per review; documentId = review.id.
    // data: JSON.stringify({ id, studentId, tutorId, subject, rating, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // review id
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.reviewConfig,
    name: 'Discord Review Config',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="config"): { delaySeconds, … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.modmail,
    name: 'Discord Modmail',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): full modmail object serialized as JSON.
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.initMessage,
    name: 'Discord Init Message',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="config"): { message: "…template…" }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.nextAdCodes,
    name: 'Discord Ad Codes',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): { igcse: 3, a_level: 1, … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  // ── Discord-Only ─────────────────────────────────────────────────────────

  {
    id: COLLECTION_IDS.cooldowns,
    name: 'Discord Cooldowns',
    permissions: SERVER_ONLY_PERMS,
    // One document per user; documentId = userId.
    // data: JSON.stringify({ lastCooldown: timestamp })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.bumpLeaderboard,
    name: 'Discord Bump Leaderboard',
    permissions: SERVER_ONLY_PERMS,
    // One document per user; documentId = userId.
    // data: JSON.stringify({ count, lastBump })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.sticky,
    name: 'Discord Sticky',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="config"): { title, body, color, messageId } | null
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tickets,
    name: 'Discord Tickets',
    permissions: SERVER_ONLY_PERMS,
    // One document per ticket; documentId = ticketId.
    // data: JSON.stringify({ studentId, subject, channelId, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tempCreateAd,
    name: 'Discord Temp Create Ad',
    permissions: SERVER_ONLY_PERMS,
    // One document per session; documentId = messageId.
    // data: JSON.stringify({ userId, selectedTutorId, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tempTutorAdd,
    name: 'Discord Temp Tutor Add',
    permissions: SERVER_ONLY_PERMS,
    // One document per session; documentId = userId.
    // data: JSON.stringify({ subject, userid, level })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tempTutorRemove,
    name: 'Discord Temp Tutor Remove',
    permissions: SERVER_ONLY_PERMS,
    // One document per session; documentId = userId.
    // data: JSON.stringify({ subject, userid })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🚀 Appwrite Collection Setup`);
  console.log(`   Endpoint:   ${ENDPOINT}`);
  console.log(`   Project:    ${PROJECT_ID}`);
  console.log(`   Database:   ${DB_ID}`);
  console.log(`   Collections to create: ${COLLECTIONS.length}\n`);

  let created = 0;
  let skipped = 0;
  let errors  = 0;

  for (const col of COLLECTIONS) {
    console.log(`\n📁 ${col.name} (${col.id})`);
    try {
      const wasCreated = await createCollection(col.id, col.name, col.permissions);
      if (wasCreated) {
        created++;
        if (col.attrs) await col.attrs(col.id);
        // Wait for Appwrite to finish processing the new attributes.
        await waitForAttributes(col.id);
      } else {
        skipped++;
      }
    } catch (e) {
      errors++;
      console.error(`  ❌ Error creating ${col.id}: ${e.message}`);
    }
  }

  console.log(`\n✨ Done!`);
  console.log(`   Created: ${created}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors:  ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
