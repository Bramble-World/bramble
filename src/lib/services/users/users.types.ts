export type User = {
  id: string;
  /** Null only for a guest. A CHECK constraint holds an account to both. */
  clerkId: string | null;
  /** Null only for a guest. */
  email: string | null;
  emailVerifiedAt: Date | null;
  /** Whether this reader lets us record how they use the app. */
  shareUsage: boolean;
  /** Playing before signing up. See `users.isGuest` in the schema. */
  isGuest: boolean;
  /** `admin` for the team: unlimited energy, no analytics. See `users.role`. */
  role: UserRole;
  deletedAt: Date | null;
};

export type UserRole = 'player' | 'admin';

/**
 * Writer inputs carry `verified`, not a timestamp: the writer derives
 * email_verified_at itself, because the correct value depends on whether the
 * address changed. See users.writer.ts.
 */
export type NewUser = {
  clerkId: string;
  email: string;
  verified: boolean;
  /** From Clerk's public metadata. A player when absent. */
  role?: UserRole;
};

export type UserPatch = {
  email?: string;
  verified?: boolean;
  /** The analytics opt-out. Independent of the address fields. */
  shareUsage?: boolean;
  /** From Clerk's public metadata, on every `user.updated`. */
  role?: UserRole;
};

/**
 * What every reader projects. clerkId is an internal join key, never returned to a client.
 *
 * `isGuest` rides along because handlers branch on it — a guest has no energy
 * balance, and cannot import — and a second read per request to find out would
 * be the same row twice. `role` rides along for the same reason: energy and
 * `GET /api/me` read it from the user already in hand.
 */
export type PublicUser = Pick<User, 'id' | 'clerkId' | 'email' | 'shareUsage' | 'isGuest' | 'role'>;
