import Image from 'next/image';
import Link from 'next/link';

/**
 * The frame both legal documents sit in: the logo home, a title, the date the
 * text took effect, and the document set as readable prose.
 */
export const LEGAL_ENTITY = 'Bramble World, Inc.';
export const LEGAL_CONTACT = 'great@brambleworld.com';

export function LegalPage({
  title,
  effective,
  children,
}: {
  title: string;
  effective: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-svh w-full flex-col bg-[#FFFFFB] px-6 py-8">
      <header>
        <Link href="/">
          <Image
            src="/bramble-logo.png"
            alt="bramble"
            width={72}
            height={72}
            priority
            className="h-14 w-14 md:h-16 md:w-16"
          />
        </Link>
      </header>

      <article className="prose prose-neutral prose-headings:font-bold prose-a:text-black mx-auto mt-10 mb-16 w-full max-w-2xl">
        <h1>{title}</h1>
        <p className="text-sm text-black/60">Effective {effective}</p>
        {children}
      </article>

      <LegalLinks />
    </main>
  );
}

/** Privacy and terms, for the foot of every public page. */
export function LegalLinks() {
  return (
    <nav className="flex justify-center gap-6 pb-4 text-sm text-black/50">
      <Link href="/privacy" className="hover:text-black">
        privacy
      </Link>
      <Link href="/terms" className="hover:text-black">
        terms
      </Link>
    </nav>
  );
}

export function Mail() {
  return <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>;
}
