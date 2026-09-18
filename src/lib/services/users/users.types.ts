export type User = {
  id: string;
  clerkId: string;
  email: string;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * Writer inputs carry `verified`, not a timestamp: the writer derives
 * email_verified_at itself, because the correct value depends on whether the
 * address changed. See users.writer.ts.
 */
export type NewUser = {
  clerkId: string;
  email: string;
  verified: boolean;
};

export type UserPatch = {
  email?: string;
  verified?: boolean;
};

/** What every reader projects. clerkId is an internal join key, never returned to a client. */
export type PublicUser = Pick<User, 'id' | 'clerkId' | 'email'>;
