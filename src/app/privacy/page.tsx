import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL_ENTITY, LegalPage, Mail } from '@/components/legal/legal-page';

/**
 * Bramble's privacy policy.
 *
 * Every statement here is a claim about the code, and most of them are
 * enforced or tested somewhere: the transcript's 30-minute life and the "never
 * written to the database" rule (src/docs/invariants.md §1 and the scan in
 * import-runner.integration.test.ts), account deletion
 * (purge.integration.test.ts), the analytics allow-lists (src/lib/analytics and
 * the Mac's Analytics.swift). Change the behaviour and this page has to change
 * with it, in the same PR.
 */
export const metadata: Metadata = {
  title: 'Privacy Policy · Bramble',
  description: 'What Bramble collects, why, who it shares it with, and how to delete it.',
};

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" effective="October 13, 2026">
      <p>
        Bramble turns conversations you choose into interactive stories you can play. That means
        handling some of the most personal data there is, so this policy explains exactly what we
        collect, what we do with it, who else touches it, and how to have it deleted.
      </p>
      <p>
        Bramble is operated by {LEGAL_ENTITY} (&ldquo;Bramble&rdquo;, &ldquo;we&rdquo;,
        &ldquo;us&rdquo;). This policy covers the Bramble app for Mac and the website at
        brambleworld.com. Questions go to <Mail />.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>
          Nothing leaves your Mac until you pick a conversation to send. Bramble reads your messages
          on your Mac only to show you your conversations and prepare the one you choose.
        </li>
        <li>
          A conversation you send is encrypted, kept for at most 30 minutes while a story is written
          from it, and then deleted. Your messages are never saved in our database.
        </li>
        <li>
          Phone numbers and email addresses in that conversation are replaced with random codes on
          your Mac before it is sent.
        </li>
        <li>
          We keep the story: the characters, events and relationships an AI model wrote from your
          conversation, and the choices you make while playing.
        </li>
        <li>We don&rsquo;t sell your data, and we don&rsquo;t use it for advertising.</li>
        <li>Email us and we&rsquo;ll delete your account and everything in it.</li>
      </ul>

      <h2>What we collect, and why</h2>

      <h3>Your account</h3>
      <p>
        When you sign up we collect your email address and, if you use one, your password, or the
        details Apple shares when you use Sign in with Apple. Sign-in is run by our authentication
        provider, Clerk, which stores your password in hashed form; we never see it. We keep a copy
        of your email address with your account so we can recognise you and contact you about your
        account. Clerk also records sign-in activity, such as your device, browser and IP address,
        to keep your account secure.
      </p>

      <h3>Messages and contacts on your Mac</h3>
      <p>
        With the access you grant (Full Disk Access for Messages, and Contacts), Bramble reads your
        Messages history and contact names on your Mac to list your conversations and show who is in
        them. This stays on your Mac. Bramble also keeps a few things there for itself: a key used
        to create the random codes described below, and a list of which conversations you&rsquo;ve
        imported.
      </p>

      <h3>Conversations you choose to send</h3>
      <p>When you choose a conversation, Bramble sends us, for that conversation only:</p>
      <ul>
        <li>the text of each message and when it was sent;</li>
        <li>whether you sent it; and</li>
        <li>
          the name each person has in your Contacts (or, if they aren&rsquo;t in your Contacts or
          you haven&rsquo;t allowed access, a placeholder such as &ldquo;Unknown &middot;
          3fa2&rdquo; made from their random code).
        </li>
      </ul>
      <p>
        Before anything is sent, your Mac replaces phone numbers and email addresses with random
        codes, so these never reach us. Photos and other attachments are not sent.
      </p>
      <p>
        What we receive is encrypted in transit and stored encrypted (AES-256) in temporary storage
        for <strong>at most 30 minutes</strong>. Only the process that writes your story can read
        it. It sends the conversation to our AI provider, OpenAI, to write the story, and the
        conversation is deleted when that&rsquo;s done (or when the 30 minutes run out, whichever
        comes first). Your messages are never written to our database, and never to our logs.
      </p>

      <h3>Your stories</h3>
      <p>From each conversation, an AI model writes a story, and we keep that. It includes:</p>
      <ul>
        <li>
          characters based on the people in the conversation, with the names you have for them;
        </li>
        <li>descriptions of them and their relationships, written by the model;</li>
        <li>events, with the dates they happened, and recurring references;</li>
        <li>
          and as you play, the scenes the model writes, the choices you&rsquo;re offered and the
          ones you make.
        </li>
      </ul>
      <p>
        Because stories are written from real conversations, they can describe real people and real
        things that happened, including sensitive things if your conversation was about them. The
        model writes them in its own words; it is instructed never to quote your messages. We also
        keep a one-way scrambled form of each person&rsquo;s random code, so the same person is
        recognised across your conversations without us knowing who they are. These stories are what
        Bramble is, so we keep them for as long as you have an account.
      </p>

      <h3>Usage data and crash reports</h3>
      <p>
        Unless you turn it off, the app sends usage events (for example, which step of signing in or
        onboarding you reached, or that you made the second of three choices) to PostHog, and crash
        reports (what the app was doing when it crashed, your Mac model, macOS version and Bramble
        version) to Sentry. Our server also records a few events, such as that a story finished
        being written and how long it took. These are tied to a random account ID, not your name or
        email, and never include your messages, the names of people in them, or your stories. Turn
        them off in Bramble&rsquo;s Settings, with &ldquo;Share anonymous usage data and crash
        reports&rdquo;; that stops both the app and our server from sending them.
      </p>

      <h3>Notifications</h3>
      <p>
        If you allow notifications, Bramble shows them on your Mac when a story you imported is
        ready, and when your energy is back after running out. They&rsquo;re created on your Mac,
        never name the people in your stories, and send nothing to us or anyone else. Turn energy
        reminders off in Bramble&rsquo;s Settings, or all of them in macOS&rsquo;s System Settings.
      </p>

      <h3>Updates and downloads</h3>
      <p>
        Bramble is downloaded from, and checks for updates at, GitHub. Like any website, GitHub
        receives your IP address and the version of Bramble you have when it does.
      </p>

      <h3>Our website</h3>
      <p>
        brambleworld.com doesn&rsquo;t use analytics or advertising cookies. Our hosting providers
        keep standard server logs, including IP addresses. If something breaks on the site, we
        record the error, without your IP address.
      </p>

      <h2>Who else handles your data</h2>
      <p>We use these providers to run Bramble. Each gets only what it needs:</p>
      <ul>
        <li>
          <strong>OpenAI</strong>: writes stories. It receives the conversations you send (to create
          a story) and the story so far (to write each scene). Under OpenAI&rsquo;s terms for its
          API, it doesn&rsquo;t train its models on this data; it may keep it for up to 30 days to
          detect abuse.
        </li>
        <li>
          <strong>Clerk</strong>: sign-in and account security.
        </li>
        <li>
          <strong>Amazon Web Services</strong>: hosts our website, our servers and our database, in
          the United States.
        </li>
        <li>
          <strong>PostHog</strong> and <strong>Sentry</strong>: usage data and crash reports, as
          described above.
        </li>
        <li>
          <strong>GitHub</strong>: hosts app downloads and updates.
        </li>
      </ul>
      <p>
        We don&rsquo;t sell personal information, and we don&rsquo;t share it for targeted
        advertising. We would disclose information if the law requires it, to protect people from
        harm, or as part of a merger or sale of the company, in which case this policy would
        continue to apply to it.
      </p>

      <h2>People in your conversations</h2>
      <p>
        Your conversations include other people. When you send one, we process what it says about
        them, and the stories keep a model-written version of it, under the name you have for them.
        We never receive their phone numbers or email addresses. Stories are only shown to the
        account that created them. If you think you&rsquo;re in someone&rsquo;s Bramble story and
        want something removed, email <Mail />. Because we never receive phone numbers or email
        addresses, we may need help from the person who imported the conversation to find it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Conversations you send: at most 30 minutes.</li>
        <li>Your account and stories: until you ask us to delete them.</li>
        <li>Download-page IP addresses: 15 minutes.</li>
        <li>
          Usage data and crash reports: for as long as our providers keep them for us, after which
          they&rsquo;re deleted automatically.
        </li>
        <li>Database backups: deleted on a rolling schedule, within 35 days.</li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        Email <Mail /> from the address you use for Bramble and ask us to delete your account.
        Within 30 days we&rsquo;ll delete your account, your stories and everything else we hold
        about you in our database, your Clerk account, and your usage data in PostHog, and confirm
        when it&rsquo;s done. Copies in our database backups disappear as those backups expire.
        Deleting your account does not delete anything on your Mac; to remove that, delete the app.
      </p>

      <h2>Your rights</h2>
      <p>
        Wherever you live, you can ask us for a copy of your data, to correct it, or to delete it,
        and you can stop usage data and crash reports at any time in Settings. Email <Mail />;
        we&rsquo;ll answer within 30 days and won&rsquo;t treat you differently for asking.
      </p>
      <p>
        If you&rsquo;re in the European Economic Area or the UK, we rely on these legal bases: to
        provide the service you asked for (your account, the stories you create), your consent
        (sending a conversation, which you choose each time, and which you can withdraw by deleting
        your account), and our legitimate interests (keeping Bramble secure, understanding how
        it&rsquo;s used, and processing information about the other people in your conversations so
        we can make your stories). You can object to processing based on legitimate interests, and
        you can complain to your local data protection authority.
      </p>
      <p>
        If you&rsquo;re in California or another US state with a privacy law, you have the rights
        above to know, access, correct and delete. We don&rsquo;t sell or share personal information
        as those laws define it.
      </p>

      <h2>Where your data is processed</h2>
      <p>
        Bramble is run from the United States, and our providers process data there. If you use
        Bramble from elsewhere, your data is transferred to the United States.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit, conversations are encrypted while they&rsquo;re briefly
        stored, and access to our systems is limited to the people who run Bramble. No system is
        perfectly secure, but we&rsquo;ll tell you promptly, as the law requires, if a breach
        affects your data.
      </p>

      <h2>Children</h2>
      <p>
        Bramble is not for anyone under 16. We don&rsquo;t knowingly collect data from anyone
        younger, and we&rsquo;ll delete an account we learn belongs to someone under 16.
      </p>

      <h2>Changes</h2>
      <p>
        If we change this policy, we&rsquo;ll update the date at the top. If a change matters to how
        your data is used, we&rsquo;ll tell you in the app or by email before it takes effect.
      </p>

      <h2>Contact</h2>
      <p>
        {LEGAL_ENTITY}, <Mail />. See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalPage>
  );
}
