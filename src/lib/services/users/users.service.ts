import { NotFoundError } from '@/lib/utils/errors';
import * as reader from './users.reader';
import { User } from './users.types';
export async function getUserByClerkId(
  clerkId: string
): Promise<Pick<User, 'id' | 'clerkId' | 'email'>> {
  const user = await reader.getUserByClerkId(clerkId);
  if (!user) {
    throw new NotFoundError(`User with clerkId ${clerkId} not found`);
  }
  return user;
}
