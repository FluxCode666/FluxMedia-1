import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import { canonicalizeEmailForIdentity } from "./email-domain";

const goBackendConfigured = Boolean(process.env.GO_BACKEND_URL || process.env.GO_BACKEND_INTERNAL_URL);
const legacyRequire = createRequire(import.meta.url);
const legacyDatabase = goBackendConfigured ? null : legacyRequire("@repo/database");
const legacySchema = null;
type LegacyDatabase = typeof import("@repo/database");
type LegacySchema = typeof import("@repo/database/schema");
const legacyValue = <K extends keyof (LegacyDatabase & LegacySchema)>(key: K) => {
  if (legacyDatabase && Object.prototype.hasOwnProperty.call(legacyDatabase, key)) {
    return legacyDatabase[key as keyof LegacyDatabase];
  }
  if (legacySchema && Object.prototype.hasOwnProperty.call(legacySchema, key)) {
    return legacySchema[key as keyof LegacySchema];
  }
  return undefined;
};
const db = legacyValue("db") as typeof import("@repo/database").db;
const registrationIdentity = legacyValue("registrationIdentity") as typeof import("@repo/database/schema").registrationIdentity;
const user = legacyValue("user") as typeof import("@repo/database/schema").user;

export async function isRegistrationEmailTaken(email: string) {
  if (!db || !registrationIdentity || !user) {
    throw new Error("Legacy registration identity storage is disabled in Go mode");
  }
  const normalizedEmail = canonicalizeEmailForIdentity(email);

  if (!normalizedEmail) {
    return false;
  }

  const [identity] = await db
    .select({ id: registrationIdentity.id })
    .from(registrationIdentity)
    .where(eq(registrationIdentity.email, normalizedEmail))
    .limit(1);

  if (identity) {
    return true;
  }

  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalizedEmail}`)
    .limit(1);

  return Boolean(existingUser);
}

export async function recordRegistrationIdentity(
  email: string,
  userId?: string | null
) {
  if (!db || !registrationIdentity) {
    throw new Error("Legacy registration identity storage is disabled in Go mode");
  }
  const normalizedEmail = canonicalizeEmailForIdentity(email);
  const now = new Date();

  if (!normalizedEmail) {
    return;
  }

  await db
    .insert(registrationIdentity)
    .values({
      id: randomUUID(),
      email: normalizedEmail,
      userId: userId ?? null,
      firstRegisteredAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: registrationIdentity.email,
      set: {
        userId: userId ?? null,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

export async function markRegistrationIdentityDeleted(
  email: string,
  userId?: string | null
) {
  if (!db || !registrationIdentity) {
    throw new Error("Legacy registration identity storage is disabled in Go mode");
  }
  const normalizedEmail = canonicalizeEmailForIdentity(email);
  const now = new Date();

  if (!normalizedEmail) {
    return;
  }

  await db
    .insert(registrationIdentity)
    .values({
      id: randomUUID(),
      email: normalizedEmail,
      userId: userId ?? null,
      firstRegisteredAt: now,
      lastSeenAt: now,
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: registrationIdentity.email,
      set: {
        userId: userId ?? null,
        lastSeenAt: now,
        deletedAt: now,
        updatedAt: now,
      },
    });
}
