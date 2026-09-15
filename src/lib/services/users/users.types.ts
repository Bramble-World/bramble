export type User = {
  id: string;
  clerkId: string;
  email: string;
  // Optional so readers can project a subset of columns. `null` is the value
  // the database returns for an unverified user; absent means "not selected".
  emailVerifiedAt: Date | null;
};
