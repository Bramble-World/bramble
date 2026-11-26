import {
  CODE_ALPHABET,
  CODE_LENGTH,
  normalizeCode,
  type InviteView,
} from '@/lib/services/invites/invites.service';
import { NotFoundError } from '@/lib/utils/errors';

/** What `/invite/[code]` shows for the code in its URL. */
export type InvitePage =
  | { kind: 'redirect'; code: string }
  | { kind: 'missing' }
  | { kind: 'invite'; code: string; invite: InviteView };

const SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * The code as the URL gave it, read the way the app reads one: any case,
 * spaces ignored. A code that isn't in its one spelling is sent there, so the
 * page a link opens always shows the code exactly as it's typed; one that
 * can't be a code is missing without a lookup.
 */
export async function resolveInvite(
  raw: string,
  read: (code: string) => Promise<InviteView>
): Promise<InvitePage> {
  const code = normalizeCode(decodeURIComponent(raw));
  if (!SHAPE.test(code)) return { kind: 'missing' };
  if (code !== raw) return { kind: 'redirect', code };
  try {
    return { kind: 'invite', code, invite: await read(code) };
  } catch (error) {
    if (error instanceof NotFoundError) return { kind: 'missing' };
    throw error;
  }
}
