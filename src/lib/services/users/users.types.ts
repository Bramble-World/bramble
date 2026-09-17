export type User = {
  id: string;
  clerkId: string;
  email: string;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
};

export type NewUser = {
  clerkId: string;
  email: string;
  emailVerifiedAt?: Date | null;
};

export type UserPatch = {
  email?: string;
  emailVerifiedAt?: Date | null;
};

/** What every reader projects. clerkId is an internal join key, never returned to a client. */
export type PublicUser = Pick<User, 'id' | 'clerkId' | 'email'>;
