export type User = {
  id: string;
  clerkId: string;
  email: string;
  // Optional so readers can project a subset of columns. `null` is the value
  // the database returns for an unverified user; absent means "not selected".
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
};

/** What every reader projects. clerkId is an internal join key, never returned to a client. */
export type PublicUser = Pick<User, 'id' | 'clerkId' | 'email'>;
