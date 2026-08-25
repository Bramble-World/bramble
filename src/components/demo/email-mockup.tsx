"use client"

import { MAIN_CHARACTER, type SeedMessage } from "@/lib/demo/scenarios"
import type { StoryEmail } from "@/lib/demo/story-beats"
import { PortraitCircle } from "./portrait-circle"

// A mail client thread, drawn rather than dropped in as an image, so the thread
// accretes as the story advances.
//
// The counterpart to the phone's lock screen, and deliberately not a second
// version of it. A lock screen shows the newest few notifications and forgets
// the rest; a mail thread keeps everything and collapses what has been read, so
// the weight of the exchange stays visible above the message you are answering.
//
// Sized in `cqw` against the window's own width, clamped so the body copy stays
// readable when the column is narrow.

const TYPE = {
  chrome: "clamp(10px, 1.9cqw, 13px)",
  subject: "clamp(15px, 3.3cqw, 22px)",
  sender: "clamp(12px, 2.5cqw, 15px)",
  meta: "clamp(10px, 2cqw, 12.5px)",
  body: "clamp(11px, 2.4cqw, 15px)",
}

const PAD = "clamp(12px, 3.4cqw, 22px)"

/** Thread titles keep their "Re:" on each message; the window itself shows the
 *  subject the thread started with. */
function threadTitle(emails: StoryEmail[]): string {
  const first = emails[0]?.subject ?? ""
  return first.replace(/^(re|fwd):\s*/i, "")
}

export function EmailMockup({
  personaName,
  portrait,
  history,
  emails,
  isReceiving,
}: {
  personaName: string
  portrait?: string | null
  /** The thread before the story starts. Always collapsed. */
  history: SeedMessage[]
  /** Newest last. Everything but the newest collapses, as in a real client. */
  emails: StoryEmail[]
  isReceiving: boolean
}) {
  const latest = emails.at(-1)
  const earlier = emails.slice(0, -1)
  const messageCount = history.length + emails.length

  return (
    <div className="@container w-full">
      <div
        className="flex w-full flex-col overflow-hidden bg-white"
        style={{
          borderRadius: "clamp(8px, 1.8cqw, 14px)",
          border: "1px solid rgba(0,0,0,0.10)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.13), 0 2px 6px rgba(0,0,0,0.06)",
        }}
      >
        <TitleBar title={threadTitle(emails)} />

        <div style={{ padding: PAD, paddingBottom: 0 }}>
          <h2
            className="font-semibold leading-tight text-black"
            style={{ fontSize: TYPE.subject }}
          >
            {threadTitle(emails)}
          </h2>
          <div className="mt-1.5 flex items-center" style={{ gap: "0.6em" }}>
            <span
              className="rounded bg-black/[0.06] px-1.5 py-0.5 text-black/55"
              style={{ fontSize: TYPE.meta }}
            >
              Inbox
            </span>
            <span className="text-black/45" style={{ fontSize: TYPE.meta }}>
              {messageCount} {messageCount === 1 ? "message" : "messages"}
            </span>
          </div>
        </div>

        <div style={{ padding: PAD, display: "flex", flexDirection: "column" }}>
          {history.map((entry, index) => (
            <CollapsedRow
              key={`history-${index}`}
              name={entry.isFromMe ? "me" : personaName}
              // The player's own replies carry the same face as the centre of
              // the life graph, so the thread reads as theirs.
              portrait={entry.isFromMe ? MAIN_CHARACTER.portrait : portrait}
              preview={entry.text}
              timestamp={entry.timestamp}
            />
          ))}

          {earlier.map((email, index) => (
            <CollapsedRow
              key={`email-${index}`}
              name={personaName}
              portrait={portrait}
              preview={email.body[0] ?? ""}
              timestamp={email.sentAt}
            />
          ))}

          {latest && (
            <ExpandedEmail personaName={personaName} portrait={portrait} email={latest} />
          )}

          {isReceiving && <ReceivingRow />}
        </div>
      </div>
    </div>
  )
}

function TitleBar({ title }: { title: string }) {
  return (
    <div
      className="relative flex shrink-0 items-center border-b border-black/[0.08] bg-[#f1f0ed]"
      style={{ padding: "clamp(7px, 1.8cqw, 12px) clamp(10px, 2.4cqw, 16px)" }}
    >
      <div className="flex items-center" style={{ gap: "clamp(4px, 1.1cqw, 8px)" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
          <span
            key={color}
            className="rounded-full"
            style={{
              width: "clamp(7px, 1.7cqw, 12px)",
              aspectRatio: "1",
              backgroundColor: color,
            }}
          />
        ))}
      </div>
      <span
        className="pointer-events-none absolute inset-x-0 truncate px-16 text-center font-medium text-black/45"
        style={{ fontSize: TYPE.chrome }}
      >
        {title}
      </span>
    </div>
  )
}

/** A message that has been read. One line, the way a real client folds them. */
function CollapsedRow({
  name,
  portrait,
  preview,
  timestamp,
}: {
  name: string
  portrait?: string | null
  preview: string
  timestamp: string
}) {
  return (
    <div
      className="flex items-center border-b border-black/[0.06]"
      style={{ gap: "clamp(7px, 1.9cqw, 12px)", paddingTop: "0.7em", paddingBottom: "0.7em" }}
    >
      <PortraitCircle
        src={portrait}
        fallback={name}
        sizes="40px"
        className="shrink-0 opacity-60"
        style={{ width: "clamp(16px, 4cqw, 26px)" }}
      />
      <span
        className="shrink-0 font-medium text-black/60"
        style={{ fontSize: TYPE.meta }}
      >
        {name}
      </span>
      <span className="min-w-0 flex-1 truncate text-black/35" style={{ fontSize: TYPE.meta }}>
        {preview}
      </span>
      <span className="shrink-0 text-black/30" style={{ fontSize: TYPE.meta }}>
        {timestamp}
      </span>
    </div>
  )
}

function ExpandedEmail({
  personaName,
  portrait,
  email,
}: {
  personaName: string
  portrait?: string | null
  email: StoryEmail
}) {
  return (
    <div style={{ paddingTop: "1.1em" }}>
      <div className="flex items-start" style={{ gap: "clamp(9px, 2.4cqw, 14px)" }}>
        <PortraitCircle
          src={portrait}
          fallback={personaName}
          sizes="60px"
          className="shrink-0"
          style={{ width: "clamp(28px, 6.6cqw, 44px)" }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline" style={{ gap: "0.5em" }}>
            {/* Unread, in the one place a mail client puts it. */}
            <span
              className="shrink-0 rounded-full bg-[#2f6fed]"
              style={{ width: "clamp(5px, 1.2cqw, 8px)", aspectRatio: "1" }}
            />
            <span className="truncate font-semibold text-black" style={{ fontSize: TYPE.sender }}>
              {personaName}
            </span>
            <span className="truncate text-black/40" style={{ fontSize: TYPE.meta }}>
              &lt;{email.fromAddress}&gt;
            </span>
            <span className="ml-auto shrink-0 text-black/40" style={{ fontSize: TYPE.meta }}>
              {email.sentAt}
            </span>
          </div>

          <div className="mt-0.5 text-black/40" style={{ fontSize: TYPE.meta }}>
            to {email.to.join(", ")}
            {email.cc?.length ? ` · cc ${email.cc.join(", ")}` : ""}
          </div>
        </div>
      </div>

      <div
        className="text-black/85"
        style={{ fontSize: TYPE.body, marginTop: "1em", lineHeight: 1.55 }}
      >
        {email.body.map((paragraph, index) => (
          <p key={index} style={{ marginTop: index === 0 ? 0 : "0.85em" }}>
            {paragraph}
          </p>
        ))}
      </div>

      {email.attachments?.length ? (
        <div className="flex flex-wrap" style={{ gap: "0.5em", marginTop: "1.1em" }}>
          {email.attachments.map((name) => (
            <span
              key={name}
              className="flex items-center rounded border border-black/10 bg-black/[0.02] text-black/60"
              style={{ fontSize: TYPE.meta, gap: "0.45em", padding: "0.45em 0.7em" }}
            >
              <span aria-hidden>📎</span>
              {name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The pause between beats, in-world: the client pulling something down. */
function ReceivingRow() {
  return (
    <div
      className="flex items-start"
      style={{ gap: "clamp(9px, 2.4cqw, 14px)", paddingTop: "1.4em" }}
    >
      <div
        className="shrink-0 animate-pulse rounded-full bg-black/10"
        style={{ width: "clamp(28px, 6.6cqw, 44px)", aspectRatio: "1" }}
      />
      <div className="flex-1 animate-pulse" style={{ paddingTop: "0.35em" }}>
        <div className="h-2 w-1/3 rounded-full bg-black/10" />
        <div className="mt-2.5 h-1.5 w-4/5 rounded-full bg-black/[0.07]" />
        <div className="mt-2 h-1.5 w-3/5 rounded-full bg-black/[0.07]" />
      </div>
    </div>
  )
}
