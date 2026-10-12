import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL_ENTITY, LegalPage, Mail } from '@/components/legal/legal-page';

/** The state whose law governs these terms: where Bramble World, Inc. is incorporated. */
const GOVERNING_STATE = 'Delaware';

export const metadata: Metadata = {
  title: 'Terms of Service · Bramble',
  description: 'The agreement between you and Bramble when you use the app.',
};

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" effective="October 12, 2026">
      <p>
        These terms are an agreement between you and {LEGAL_ENTITY} (&ldquo;Bramble&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) for the Bramble app for Mac, our website, and the
        service behind them (together, &ldquo;Bramble&rdquo;). By creating an account or using
        Bramble, you agree to them. Our <Link href="/privacy">Privacy Policy</Link> explains how we
        handle your data.
      </p>

      <h2>Who can use Bramble</h2>
      <p>
        You must be at least 16. If you&rsquo;re under 18, or under the age of majority where you
        live, a parent or guardian must agree to these terms for you. You need an account, with
        accurate details; keep your sign-in secure, because you&rsquo;re responsible for what
        happens on your account.
      </p>

      <h2>Bramble is in beta</h2>
      <p>
        Bramble is early, and it will change: features will appear, change and go away, and things
        will break. We may limit how much you can use it (for example, how many conversations you
        can import or how many scenes you can play each day), and we may change or end the beta at
        any time. If we end Bramble, we&rsquo;ll try to give you notice first. Bramble updates
        itself automatically; updates are part of Bramble and these terms apply to them.
      </p>

      <h2>The conversations you import</h2>
      <p>
        Bramble works from your own conversations, which include other people. When you import one,
        you promise that:
      </p>
      <ul>
        <li>you were a participant in the conversation;</li>
        <li>
          you&rsquo;re allowed to use it this way, and doing so doesn&rsquo;t break any law, or any
          promise of confidentiality you made; and
        </li>
        <li>
          you&rsquo;ll respect the privacy of the people in it, including by not importing a
          conversation someone has asked you not to share.
        </li>
      </ul>
      <p>
        You keep ownership of your conversations. You give us permission to use them, and the
        stories made from them, only to run Bramble for you as described in our Privacy Policy. This
        permission ends when you delete your account, except for copies we must keep by law or that
        are waiting to expire from backups.
      </p>

      <h2>Your stories are fiction</h2>
      <p>
        Stories in Bramble are written by an AI model. They&rsquo;re inspired by real conversations,
        but they&rsquo;re fiction: they can be inaccurate, invent things that never happened,
        portray real people in ways they wouldn&rsquo;t recognise, or be unexpected or upsetting.
        They are not statements of fact about anyone, and they don&rsquo;t represent our views.
        Don&rsquo;t present them as true, or rely on them for decisions about your relationships,
        health, money or anything else important.
      </p>
      <p>
        As between you and us, you may use your stories for your own personal, non-commercial
        purposes. If you share them, you&rsquo;re responsible for doing so in a way that respects
        the people in them.
      </p>

      <h2>Things you may not do</h2>
      <ul>
        <li>
          use Bramble, or anything it creates, to harass, threaten, defame, embarrass or harm
          anyone;
        </li>
        <li>import conversations you have no right to use, or that involve exploiting a child;</li>
        <li>use Bramble for anything illegal;</li>
        <li>
          get around Bramble&rsquo;s limits or access controls, including sharing beta access codes
          publicly, or try to access other people&rsquo;s accounts or our systems;
        </li>
        <li>
          copy, modify, reverse engineer or resell the app or service, except where the law allows
          it regardless of this term; or
        </li>
        <li>overload Bramble, or use automated means to access it.</li>
      </ul>
      <p>
        We may suspend or close an account that breaks these terms, or that puts other people or
        Bramble at risk.
      </p>

      <h2>Our part</h2>
      <p>
        Bramble, including the app, its design, and the software and models we use, belongs to us
        and our licensors. We give you a personal, non-transferable, revocable licence to use the
        app on Macs you own or control, under these terms. If you send us feedback or ideas, we may
        use them without owing you anything.
      </p>
      <p>
        Bramble relies on services from other companies, such as Apple&rsquo;s Messages and macOS,
        and our AI provider. We aren&rsquo;t responsible for them, and changes they make can affect
        what Bramble can do.
      </p>

      <h2>Ending things</h2>
      <p>
        You can stop using Bramble at any time, and ask us to delete your account by emailing{' '}
        <Mail />. We can end your access as described above. The sections on your stories being
        fiction, our part, disclaimers, limits on liability, indemnity and the law that applies
        continue after your account ends.
      </p>

      <h2>Disclaimers</h2>
      <p>
        Bramble is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the fullest
        extent the law allows, we disclaim all warranties, express or implied, including
        merchantability, fitness for a particular purpose and non-infringement. We don&rsquo;t
        promise that Bramble will be uninterrupted, error-free or secure, that stories will be
        accurate or appropriate, or that your data won&rsquo;t be lost.
      </p>

      <h2>Limits on our liability</h2>
      <p>
        To the fullest extent the law allows, we won&rsquo;t be liable for any indirect, incidental,
        special, consequential or punitive damages, or for lost data, profits or goodwill, arising
        from Bramble or these terms. Our total liability for any claim about Bramble or these terms
        is limited to the greater of what you paid us in the 12 months before the claim and US$100.
        Some places don&rsquo;t allow these limits, so they apply to you only as far as your local
        law permits.
      </p>

      <h2>Indemnity</h2>
      <p>
        If someone makes a claim against us because of conversations you imported, how you used
        Bramble or what it created for you, or your breaking these terms or the law, you&rsquo;ll
        cover our reasonable costs of dealing with it, including legal fees, as far as the law
        allows.
      </p>

      <h2>The law that applies</h2>
      <p>
        These terms are governed by the laws of the State of {GOVERNING_STATE}, USA, without regard
        to its conflict-of-law rules. Disputes will be decided in the state or federal courts
        located in {GOVERNING_STATE}, and you and we agree to their jurisdiction. If you&rsquo;re a
        consumer living outside the US, you keep any protections your local law gives you that
        can&rsquo;t be waived, and you may bring claims in your local courts.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. If a change is significant, we&rsquo;ll tell you in the app or by
        email before it takes effect. Continuing to use Bramble after that means you accept the new
        terms; if you don&rsquo;t, stop using Bramble and ask us to delete your account.
      </p>

      <h2>The rest</h2>
      <p>
        These terms and our Privacy Policy are the whole agreement between you and us about Bramble.
        If part of them can&rsquo;t be enforced, the rest still applies. If we don&rsquo;t enforce
        something straight away, we haven&rsquo;t given up the right to. You can&rsquo;t transfer
        these terms to anyone else; we may transfer them as part of a merger or sale of the company.
      </p>

      <h2>Contact</h2>
      <p>
        {LEGAL_ENTITY}, <Mail />.
      </p>
    </LegalPage>
  );
}
