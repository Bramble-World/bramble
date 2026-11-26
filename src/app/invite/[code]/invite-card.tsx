import type { InviteState } from '@/lib/services/invites/invites.service';
import { CopyCode } from './copy-code';

/**
 * What the page says for an invite. Only the inviter's first name is shown,
 * which is what the invite was made to share (/privacy, "Stories for two").
 */
export function InviteCard({
  state,
  inviterFirstName,
  code,
  appStoreUrl,
}: {
  state: InviteState;
  inviterFirstName: string;
  code: string;
  appStoreUrl: string | null;
}) {
  const name = inviterFirstName.toLowerCase();
  if (state === 'accepted') {
    return <p className={LINE}>{`${name}'s invite has already been used.`}</p>;
  }
  if (state === 'expired') {
    return <p className={LINE}>{`${name}'s invite has run out. ask them to send a new one.`}</p>;
  }
  return (
    <div className="flex flex-col items-center gap-8">
      <p className={LINE}>{`${name} invited you to a story together.`}</p>
      <CopyCode code={code} />
      <p className="max-w-sm text-center text-base text-black/70">
        open bramble and tap &ldquo;got an invite code?&rdquo;
      </p>
      {appStoreUrl ? (
        <a
          href={appStoreUrl}
          className="rounded-full bg-black px-8 py-4 text-center text-xl font-bold text-[#FFFFFB] sm:text-2xl"
        >
          get bramble on the app store
        </a>
      ) : null}
    </div>
  );
}

const LINE = 'max-w-sm text-center text-2xl leading-tight font-bold text-black';
