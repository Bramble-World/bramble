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
 * (purge.integration.test.ts and account-deletion.routes.integration.test.ts), the analytics allow-lists (src/lib/analytics and
 * the Mac's Analytics.swift), and a guest's seven days, App Attest key and
 * per-address count (GUEST_LIFETIME_MS, guest-sweep.ts, attestation.ts,
 * ip-limit.ts, and guests.routes.integration.test.ts), and the last-life answers: checked before they
 * are kept, a flagged one never kept, moved on sign-up and deleted with the account (safety.ts,
 * reborn-answers.service.ts, guests.routes.integration.test.ts and purge.integration.test.ts), and story
 * reports: codes only, deleted with the account (reports.service.ts, reports.routes.integration.test.ts,
 * purge.integration.test.ts). The age question and the AI notice are the iPhone app's
 * (Onboarding/BeforeYouStart). Change the
 * behaviour and this page has to change with it, in the same PR.
 */
export const metadata: Metadata = {
  title: 'Privacy Policy · Bramble',
  description: 'What Bramble collects, why, who it shares it with, and how to delete it.',
};

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" effective="November 28, 2026">
      <p>
        Bramble turns conversations you choose, or on iPhone the people you name, into interactive
        stories you can play. That means handling some of the most personal data there is, so this
        policy explains exactly what we collect, what we do with it, who else touches it, and how to
        have it deleted.
      </p>
      <p>
        Bramble is operated by {LEGAL_ENTITY} (&ldquo;Bramble&rdquo;, &ldquo;we&rdquo;,
        &ldquo;us&rdquo;). This policy covers the Bramble app for iPhone, the website at
        brambleworld.com, and what Bramble for Mac collected while it was in use: it ended on
        November 25, 2026. Questions go to <Mail />.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>
          Bramble for Mac ended on November 25, 2026. Its last version reads nothing and sends
          nothing, and our servers no longer accept earlier versions. While it was in use, nothing
          left your Mac until you picked a conversation to send.
        </li>
        <li>
          A conversation you sent was encrypted, kept for at most 30 minutes while a story was
          written from it, and then deleted. Your messages were never saved in our database.
        </li>
        <li>
          Phone numbers and email addresses in that conversation were replaced with random codes on
          your Mac before it was sent.
        </li>
        <li>
          We keep the story: the characters, events and relationships an AI model wrote from your
          conversation, and the choices you make while playing.
        </li>
        <li>
          On iPhone you can play before signing up. What you enter and play then is kept for 7 days
          and deleted automatically unless you save it by signing up.
        </li>
        <li>
          Stories are written by an AI model from OpenAI. Before you start on iPhone, the app tells
          you what it sends to OpenAI and asks you to agree.
        </li>
        <li>
          If you connect Bramble in ChatGPT and ask it for a Bramble story, or tap a Bramble link
          ChatGPT writes you, we get something about your life and write stories from it that only
          you play. We delete what we got once the stories are written.
        </li>
        <li>We don&rsquo;t sell your data, and we don&rsquo;t use it for advertising.</li>
        <li>
          You can delete your account and everything in it from Settings in the iPhone app, or by
          emailing us.
        </li>
      </ul>

      <h2>What we collect, and why</h2>

      <h3>Your account</h3>
      <p>
        When you sign up we collect your email address and, if you use one, your password, or the
        details Apple shares when you use Sign in with Apple. If you add a passkey, it stays in your
        iCloud Keychain or password manager; Clerk keeps only its public key. Sign-in is run by our
        authentication provider, Clerk, which stores your password in hashed form; we never see it.
        We keep a copy of your email address with your account so we can recognise you and contact
        you about your account. Clerk also records sign-in activity, such as your device, browser
        and IP address, to keep your account secure.
      </p>

      <h3>Before you start (iPhone)</h3>
      <p>
        The first time you open Bramble on iPhone, it asks the year you were born, because Bramble
        is only for people 16 and older. The year isn&rsquo;t sent to us or kept: the app keeps only
        whether you&rsquo;re old enough, on your iPhone, so it doesn&rsquo;t ask again. The same
        screen tells you that what you type is sent to OpenAI to write your stories, and asks you to
        agree before anything is sent.
      </p>

      <h3>Playing before you sign up (iPhone)</h3>
      <p>
        On iPhone you can start a story without an account. When you do, we create a temporary guest
        account, known to us only by a random ID; it has no email address or password. We keep what
        you enter and play as a guest:
      </p>
      <ul>
        <li>the name you give the person in your story, and the pronouns you choose for them;</li>
        <li>
          who they are to you, from the options we offer (for example, an ex or a sibling); and
        </li>
        <li>the story, the scenes the AI model writes, and the choices you make.</li>
      </ul>
      <p>
        The name, the pronouns and the story so far are sent to our AI provider, OpenAI, to write
        each new scene. A guest account and everything in it is deleted automatically{' '}
        <strong>7 days</strong> after it was created, unless you save your story by signing up. When
        you sign up, the story becomes part of your new account; if you sign in to an account you
        already have, the story is added to it and the guest account is deleted.
      </p>
      <p>
        To limit how many guest accounts can be created, the app uses Apple&rsquo;s App Attest,
        which lets our server check that a request comes from a genuine copy of Bramble on a real
        Apple device. The app creates a key for this on your iPhone, and we keep that key&rsquo;s
        identifier with the guest account until you sign up or the guest account is deleted. It
        identifies that key, not you or your device, and we don&rsquo;t use your device&rsquo;s
        advertising identifier. We also count how many guest accounts are created from each IP
        address, and keep that count for an hour.
      </p>

      <h3>Questions about your last life (iPhone)</h3>
      <p>
        When you start on iPhone, the app may ask you up to three questions about your past: a
        choice you still wonder about, someone who changed the direction of your life (and who they
        were to you, such as a parent or an ex), and something you were about to do. Every question
        can be skipped. We ask you not to use real names, and we change details anyway (see below).
      </p>
      <p>
        When you answer, we first send your answer to OpenAI&rsquo;s moderation service to check
        whether it talks about self-harm, abuse or someone in danger. If it does, we don&rsquo;t
        keep it (and we delete any earlier answer you gave to that question): it won&rsquo;t become
        a story and no one else will see it, and the app points you to free helplines instead. If
        the check can&rsquo;t be run, we don&rsquo;t keep the answer either.
      </p>
      <p>
        Otherwise we keep your answer with your guest account, and with your account once you sign
        up. We&rsquo;ll use your answers to write stories that other Bramble players can play.
        Before anyone else sees such a story, the names, places, schools, employers and any other
        details that could identify you or anyone else are changed, and your own words are never
        shown as you wrote them. Your answers are sent to OpenAI to check them and to write those
        stories. They are never part of usage data or crash reports.
      </p>
      <p>
        Choosing &ldquo;i&rsquo;d rather not say&rdquo; on a question you&rsquo;d already answered
        deletes that answer. Deleting your account deletes your answers, and stories written from
        them are taken out of the stories other players are offered.
      </p>

      <h3>Bramble in ChatGPT</h3>
      <p>
        You can connect your Bramble account in ChatGPT and ask it to write you a Bramble story
        about your life, in ChatGPT or with the &ldquo;make a story with chatgpt&rdquo; button in
        the iPhone app, which opens ChatGPT with that request already sent. ChatGPT picks a real
        situation from what it knows about you and sends it to us straight away, without showing it
        to you first: asking for the story is your ok. It sends a description of the situation, up
        to three people in it (their first names, who they are to you, and a little about them), and
        optionally a line about you. We don&rsquo;t get your ChatGPT conversations or memory, only
        what ChatGPT sends in that request. You can ask ChatGPT what it sent, and delete the story
        (see below).
      </p>
      <p>
        You can also ask ChatGPT for a Bramble link without connecting: the &ldquo;make a story with
        chatgpt&rdquo; button in the app opens ChatGPT with that request, and ChatGPT replies with a
        link that holds up to five situations from what it knows about you, each with the first
        names of the people in it and who they are to you. What ChatGPT put in the link is in the
        part after the &ldquo;#&rdquo;, which your browser never sends to our website. If the link
        opens our website instead of the app (inside ChatGPT&rsquo;s browser, say), the page reads
        that part only in your browser, to hand it to the app when you tap &ldquo;open in
        bramble&rdquo;. When you tap the link, the Bramble app opens and sends it to our server
        straight away, without showing it to you first: tapping it is your ok. We send it to OpenAI
        to sort it into the situations we can write stories from. That step leaves out anything
        about health (including sexual health), mental-health crises or self-harm, money or debt,
        legal trouble, addresses and other details that identify someone, school or work logistics,
        anything sexual, and anything too thin to make a story, whatever ChatGPT put in the link. We
        keep only the situations it picked, never the rest of what the link held, and each one then
        goes the way a story asked for in ChatGPT does, below. So that a link the app sends twice
        (if it lost the first answer) makes its stories only once, we keep a one-way fingerprint of
        the link and your account, which can&rsquo;t be turned back into what the link said, and
        what we answered, both for 30 minutes. You can make up to five stories a day, however you
        ask.
      </p>
      <p>
        We first send it to OpenAI&rsquo;s moderation service; if it talks about self-harm, abuse or
        someone in danger, we don&rsquo;t keep it. Otherwise we send it to OpenAI to write the
        story, which then becomes your next story in the iPhone app; if you allow notifications, we
        tell you when it&rsquo;s ready. The people keep the names ChatGPT sent. The story is only
        ever yours: it isn&rsquo;t offered to anyone else. We delete what ChatGPT sent as soon as
        the story is written, or as soon as we decide we can&rsquo;t write one from it; after that,
        the story is the only copy. We also note when your account first connected. You can delete a
        story in ChatGPT (&ldquo;delete my bramble story&rdquo;), which removes it and the people it
        added from your account, and disconnect Bramble in ChatGPT&rsquo;s settings; a story made
        from a link is deleted with your account, or when you email us to delete it. What ChatGPT
        itself keeps is covered by OpenAI&rsquo;s own privacy policy, not this one.
      </p>

      <h3>Stories for two (iPhone)</h3>
      <p>
        You can invite someone to play a story with you. When you make an invite we store a
        six-letter code, the first name you typed for yourself, when you made it and when it expires
        (after 7 days). Anyone who opens the code, in the app or at our invite link, sees that first
        name and nothing else about you. If you open an invite before you have an account, the app
        keeps just the six-letter code (never a name) on your iPhone until you accept it, turn it
        down, the invite is no longer open, or 7 days pass, so it&rsquo;s still there after you sign
        up. When someone with an account accepts, we record who accepted and when, and they give the
        first name they want you to know them by. You each get your own side of the same story, in
        your own account: the other person is a character in it by the first name they gave. Neither
        of you can see the other&rsquo;s side, any of the other&rsquo;s other stories, or anything
        else in the other&rsquo;s account. Some of what you do in your side reaches theirs: when one
        of your choices is something their character would know about (you told them, texted them,
        showed them, or they were there), a short note of what happened is kept with their side, and
        their next beat opens with texts from your character about it, written by our story model
        (OpenAI) for their side. They see only that beat, never your words, your choices themselves
        or the rest of your side; what you keep to yourself stays in your side. Nothing you type
        crosses, and you can&rsquo;t message each other. If you haven&rsquo;t played your side for 3
        days, nothing new reaches it until you do. When something reaches their side while
        they&rsquo;re away, we may send them one notification saying their story for two moved,
        which never says who or what. If one of you deletes their account, the other&rsquo;s side
        stays theirs and carries on, with the character who was the person who left renamed to a
        made-up first name everywhere in it, so nothing in it is linked to them any more; anything
        of theirs that hadn&rsquo;t yet reached it is deleted.
      </p>

      <h3>Reporting a story</h3>
      <p>
        If you report a story in the app, we keep the reason you picked from our list, which story
        and which scene you reported, and when. There&rsquo;s no space to write anything; to tell us
        more, email us. Reports reach us as an alert that carries only the reason and a random ID.
        To decide what to do, someone on our team reads your copy of that story, the one you
        reported. If it came from the stories we offer other players, we may stop offering it. Your
        report is deleted with your account.
      </p>

      <h3>Bramble for Mac (ended November 25, 2026)</h3>
      <p>
        Bramble for Mac has ended. Its last version shows only that, with a link to the iPhone app:
        it reads none of your messages or contacts and sends nothing. Our servers no longer accept
        earlier versions, so they can&rsquo;t send anything either. Stories it made stay with your
        account (on iPhone too) until you delete them or your account. The rest of this section, and
        the two after it, describe what it did while it was in use.
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
        reports (what the app was doing when it crashed, your Mac or iPhone model, its system
        version and Bramble version) to Sentry. Our server also records a few events, such as that a
        story finished being written and how long it took, or that you played a scene and whether
        the story came from ChatGPT or from our own stories (never which one). These are tied to a
        random account ID, not your name or email, and never include your messages, the names of
        people in them, or your stories. On iPhone they start before you sign up, under your guest
        account&rsquo;s random ID; for a guest, the server records which opening you saw, who the
        person you named is to you (for example, an ex), whether you chose pronouns, and how many
        scenes you played &mdash; never the name or the pronouns themselves. Turn them off in
        Bramble&rsquo;s Settings, with &ldquo;Share anonymous usage data and crash reports&rdquo;;
        that stops both the app and our server from sending them.
      </p>

      <h3>Notifications</h3>
      <p>
        If you allow notifications, Bramble shows them on your Mac when a story you imported is
        ready, and on your Mac when your energy is back after running out. Those are created on your
        device, say they&rsquo;re from Bramble, never name the people in your stories, and send
        nothing to us or anyone else. Turn energy reminders off in Bramble&rsquo;s Settings, or all
        of them in your device&rsquo;s Settings.
      </p>
      <p>
        On iPhone, if you have an account and allow notifications, we can also send them from our
        servers through Apple&rsquo;s push notification service. For that we store the push token
        Apple gives your installation of the app, which build type issued it, your time zone and
        when we last heard from the app, so we can reach you at a reasonable hour. Push
        notifications say they&rsquo;re from Bramble and never name the people in your stories or
        quote them. We delete the token when you sign out, when you delete your account, or when
        Apple tells us it no longer works. We also record when we sent each one and what kind it
        was: that your battery is back, or that your story is waiting (and which of two wordings it
        used; one of them says how many new texts are waiting, never who sent them). When a story
        you asked for in ChatGPT is ready, we send one notification saying so, and record only that
        it was sent in our usage data, if you share it. Sometimes someone in a story replies later,
        in real time: we store when that reply is due, write it then, and may send a notification
        when it arrives, saying how many new texts are waiting and never who sent them. Turn them
        off in Bramble&rsquo;s Settings or your device&rsquo;s Settings at any time.
      </p>

      <h3>Updates and downloads</h3>
      <p>
        Bramble for Mac is downloaded from, and checks for updates at, GitHub. Like any website,
        GitHub receives your IP address and the version of Bramble you have when it does.
      </p>
      <p>
        The iPhone beta is installed through Apple&rsquo;s TestFlight. Apple shares with us what
        TestFlight collects from beta testers: your device model and iOS version, when you install
        and open the beta, crash reports, and any feedback or screenshots you choose to send through
        TestFlight. Apple&rsquo;s TestFlight privacy notice in the TestFlight app describes what
        Apple itself keeps.
      </p>

      <h3>Our website</h3>
      <p>
        brambleworld.com doesn&rsquo;t use analytics or advertising cookies. We use PostHog to count
        visits and see which links on the site are pressed, without cookies and without recognising
        you from one visit to the next. Each visit tells PostHog the page, the site you came from,
        your browser and device type and, as with any web request, your IP address, which it may use
        to estimate your approximate location. We don&rsquo;t record what you type on the site, or
        your screen. Our hosting providers keep standard server logs, including IP addresses. If
        something breaks on the site, we record the error, without your IP address.
      </p>

      <h2>Who else handles your data</h2>
      <p>We use these providers to run Bramble. Each gets only what it needs:</p>
      <ul>
        <li>
          <strong>OpenAI</strong>: writes stories. It receives the conversations you send (to create
          a story) and the story so far, including the names and pronouns you give people, to write
          each scene; and your answers to the questions about your last life, to check them with its
          moderation service and to write stories from them; and what ChatGPT sends us when you ask
          it for a story, or what a Bramble link from ChatGPT holds when you tap it, to sort it,
          check it and write the stories. Under OpenAI&rsquo;s terms for its API, it doesn&rsquo;t
          train its models on this data; it may keep it for up to 30 days to detect abuse.
        </li>
        <li>
          <strong>Clerk</strong>: sign-in and account security.
        </li>
        <li>
          <strong>Apple</strong>: App Attest, on iPhone, as described above. Apple certifies the key
          the app creates; we don&rsquo;t send Apple anything about you or your story. Apple also
          runs TestFlight, which installs the iPhone beta, as described above. If you signed in with
          Apple and delete your account, we also ask Apple to revoke Bramble&rsquo;s Sign in with
          Apple for your Apple ID, as described below. Apple delivers iPhone push notifications, so
          it receives the push token and the notification&rsquo;s text.
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
        We never receive their phone numbers or email addresses. The same goes for someone you name
        when playing on iPhone: we keep the name and pronouns you give them, with your story, and
        nothing else about them. And for the people ChatGPT names when you ask it for a story, or in
        a link: their first names, who they are to you and the little it says about them, kept as
        part of your story. Stories are only shown to the account that created them. If you think
        you&rsquo;re in someone&rsquo;s Bramble story and want something removed, email <Mail />.
        Because we never receive phone numbers or email addresses, we may need help from the person
        who imported the conversation to find it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Conversations you send: at most 30 minutes.</li>
        <li>
          A guest account on iPhone and its story, if you don&rsquo;t sign up: 7 days, then deleted
          automatically.
        </li>
        <li>Counts of guest accounts created per IP address: 1 hour.</li>
        <li>
          Answers to the questions about your last life: with your account, until you delete them or
          your account. An answer the safety check flags is never kept.
        </li>
        <li>
          What ChatGPT sends to write a story, and the situations we keep from a Bramble link: until
          the story is written, or we decide we can&rsquo;t write one from it, usually a few
          minutes. If moderation flags it, it&rsquo;s never kept. The rest of what a link held is
          never kept.
        </li>
        <li>Your account and stories: until you delete them, or ask us to.</li>
        <li>Your story reports: until you delete your account.</li>
        <li>Download-page IP addresses: 15 minutes.</li>
        <li>
          Usage data and crash reports: for as long as our providers keep them for us, after which
          they&rsquo;re deleted automatically.
        </li>
        <li>Database backups: deleted on a rolling schedule, within 35 days.</li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        In the iPhone app, go to Settings and tap &ldquo;delete my account&rdquo;. You confirm with
        Face ID or your sign-in first, so nobody else can do it from your phone. It happens straight
        away: we delete your account, your stories, the people you added, your answers to the
        questions about your last life and everything else we hold about you in our database, your
        Clerk account and passkeys, and your usage data in PostHog. If you signed in with Apple, we
        also revoke Bramble&rsquo;s Sign in with Apple, so Bramble no longer appears under your
        Apple ID. Passkeys saved in your iCloud Keychain or password manager stay there until you
        delete them yourself.
      </p>
      <p>
        You can also email <Mail /> from the address you use for Bramble and ask us to delete your
        account, for example if you no longer have the app or can&rsquo;t sign in. We&rsquo;ll do
        the same within 30 days and confirm when it&rsquo;s done.
      </p>
      <p>
        Either way, copies in our database backups disappear as those backups expire. Deleting your
        account does not delete anything on your Mac; to remove that, delete the app.
      </p>
      <p>
        A guest account has no email address, so we can&rsquo;t find one from an email. You
        don&rsquo;t need to ask: it&rsquo;s deleted automatically, with its story, 7 days after it
        was created. Once you sign up, your account is deleted like any other.
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

      <h2 id="contact">Contact</h2>
      <p>
        {LEGAL_ENTITY}, <Mail />. See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalPage>
  );
}
