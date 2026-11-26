import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { env } from '@/env';
import { LegalLinks } from '@/components/legal/legal-page';
import { readInvite } from '@/lib/services/invites/invites.service';
import { InviteCard } from './invite-card';
import { resolveInvite } from './resolve';

/**
 * No name here: a link preview is seen by anyone the link reaches, and the
 * name is only for whoever opens it.
 */
export const metadata: Metadata = {
  title: 'a story for two on bramble',
  description: 'someone invited you to a story together.',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'a story for two on bramble',
    description: 'someone invited you to a story together.',
  },
};

/**
 * Where an invite link lands when Bramble isn't installed: with the app, iOS
 * opens `/invite/<code>` in it instead (`/.well-known/apple-app-site-association`).
 * Without it, this shows the code to type after installing: iOS doesn't carry
 * a link through a fresh install, and nothing here tries to (no fingerprinting).
 */
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  // Per request: the invite's state and the store link both change.
  await connection();
  const page = await resolveInvite((await params).code, (code) => readInvite(code));
  if (page.kind === 'redirect') redirect(`/invite/${page.code}`);
  if (page.kind === 'missing') notFound();

  return (
    <main className="flex min-h-svh w-full flex-col items-center justify-center gap-10 bg-[#FFFFFB] px-6 py-8">
      <Image src="/bramble-logo.png" alt="bramble" width={72} height={72} priority />
      <InviteCard
        state={page.invite.state}
        inviterFirstName={page.invite.inviterFirstName}
        code={page.code}
        appStoreUrl={env.IOS_APP_STORE_URL ?? null}
      />
      <LegalLinks />
    </main>
  );
}
