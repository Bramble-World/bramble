import Image from 'next/image';
import { LegalLinks } from '@/components/legal/legal-page';

/** A code that was never made, or was mistyped. */
export default function InviteNotFound() {
  return (
    <main className="flex min-h-svh w-full flex-col items-center justify-center gap-10 bg-[#FFFFFB] px-6 py-8">
      <Image src="/bramble-logo.png" alt="bramble" width={72} height={72} priority />
      <p className="max-w-sm text-center text-2xl leading-tight font-bold text-black">
        we couldn&rsquo;t find that invite. check the link, or ask for a new one.
      </p>
      <LegalLinks />
    </main>
  );
}
