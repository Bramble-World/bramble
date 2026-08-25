"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  sequenceFor,
  FREEFORM_CHOICE,
  type StoryChoice,
  type StoryEmail,
} from "@/lib/demo/story-beats"
import type { Scenario } from "@/lib/demo/scenarios"
import { EmailMockup } from "./email-mockup"
import { PhoneMockup } from "./phone-mockup"

// Playing a scenario. The surface the thread actually lives on sits on the left
// — a phone lock screen for iMessage, a mail client for email — and the story
// and its branches sit on the right.
//
// Note the type shift from the rest of the demo: onboarding and the graph are
// set in a grotesque, and this screen is a serif. The graph is a product
// surface; this is a story, and it should read like one.

const CANVAS = "rgb(245, 244, 242)"
/** Purely for feel. Advancing instantly would land the next message before the
 *  player has finished reading their own choice. */
const BEAT_DELAY_MS = 1100

export function StoryView({ scenario, onBack }: { scenario: Scenario; onBack: () => void }) {
  const script = useMemo(
    () => sequenceFor(scenario.id, scenario.history.at(-1)?.text),
    [scenario],
  )

  const [index, setIndex] = useState(0)
  const [isAdvancing, setIsAdvancing] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [draft, setDraft] = useState("")
  const [, setChoicesMade] = useState<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const beat = script[index]
  const isFinal = beat.choices.length === 0
  const seen = script.slice(0, index + 1)
  const incoming = seen
    .map((entry) => entry.incomingMessage)
    .filter((message): message is string => Boolean(message))
  const incomingEmails = seen
    .map((entry) => entry.incomingEmail)
    .filter((email): email is StoryEmail => Boolean(email))
  const isEmail = scenario.surface === "email"

  function commit(choice: StoryChoice, freeText?: string) {
    if (isAdvancing || index + 1 >= script.length) return
    const action = freeText?.trim() || choice.text
    setChoicesMade((made) => [...made, action])
    setIsAdvancing(true)
    timer.current = setTimeout(() => {
      setIndex((current) => current + 1)
      setIsAdvancing(false)
    }, BEAT_DELAY_MS)
  }

  function select(choice: StoryChoice) {
    if (choice.isFreeform) {
      setIsComposing(true)
      return
    }
    setIsComposing(false)
    commit(choice)
  }

  function sendFreeform() {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    setIsComposing(false)
    commit(FREEFORM_CHOICE, text)
  }

  function restart() {
    if (timer.current) clearTimeout(timer.current)
    setIndex(0)
    setChoicesMade([])
    setIsAdvancing(false)
    setIsComposing(false)
    setDraft("")
  }

  return (
    <div
      className="font-grotesque relative flex h-full w-full flex-col overflow-hidden md:flex-row"
      style={{ backgroundColor: CANVAS }}
    >
      {/* Chrome */}
      <div className="absolute left-0 top-0 z-20 flex items-center gap-3 p-5 md:gap-[1.2vw] md:p-[2.8vw]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to your world"
          className="cursor-pointer text-black/75 transition-opacity hover:opacity-60 md:[font-size:1.6vw]"
        >
          ←
        </button>
        <button
          type="button"
          onClick={restart}
          className="cursor-pointer text-xs text-black/35 transition-opacity hover:opacity-70 md:[font-size:0.92vw]"
        >
          restart
        </button>
      </div>

      {/* Left — the surface. Deliberately taller than the column and cropped at
          the bottom, so it reads as a real object sitting in the frame rather
          than an icon that happens to be phone- or window-shaped. */}
      <div
        className={`relative flex shrink-0 justify-center overflow-hidden pt-16 md:h-full md:w-[44%] md:justify-center ${
          isEmail ? "md:pt-[9vh]" : "md:pt-[13vh]"
        }`}
      >
        <div
          className={
            isEmail
              ? "w-[92vw] max-w-[520px] md:w-[36vw] md:max-w-none"
              : "w-[54vw] max-w-[300px] md:w-[23.5vw] md:max-w-none"
          }
        >
          {isEmail ? (
            <EmailMockup
              personaName={scenario.personaName}
              portrait={scenario.portrait}
              history={scenario.history}
              emails={incomingEmails}
              isReceiving={isAdvancing}
            />
          ) : (
            <PhoneMockup
              contactName={scenario.personaName}
              portrait={scenario.portrait}
              notifications={incoming}
              isTyping={isAdvancing}
            />
          )}
        </div>
        <div
          className="pointer-events-none absolute bottom-0 left-0 h-24 w-full md:h-[14%]"
          style={{ background: `linear-gradient(to bottom, rgba(245,244,242,0), ${CANVAS})` }}
        />
      </div>

      {/* Right — the story */}
      <div
        className="flex-1 overflow-y-auto px-6 pb-10 transition-opacity duration-250 md:h-full md:w-[56%] md:py-[5vw] md:pl-0 md:pr-[5.5vw]"
        style={{ opacity: isAdvancing ? 0.45 : 1, pointerEvents: isAdvancing ? "none" : "auto" }}
      >
        <div className="flex flex-col gap-4 md:gap-[1.6vw]">
          <p className="font-story text-xl leading-snug text-black md:[font-size:2.25vw]">
            {beat.narration}
          </p>

          {beat.incomingMessage && (
            <div className="flex flex-col gap-1.5 pl-2 md:gap-[0.7vw] md:pl-[0.8vw]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-black/45 md:[font-size:0.92vw]">
                {scenario.personaName}
              </span>
              {isEmail ? (
                <p className="border-l-2 border-black/20 pl-3 text-sm italic text-black/75 md:[font-size:1.35vw] md:[padding-left:1.1vw]">
                  {beat.incomingMessage}
                </p>
              ) : (
                <p className="w-fit rounded-lg bg-[#e0e0e0] px-3 py-2 text-sm text-black/85 md:[font-size:1.35vw] md:[border-radius:1.1vw] md:[padding:0.9vw_1.2vw]">
                  {beat.incomingMessage}
                </p>
              )}
            </div>
          )}

          <p className="font-story text-xl leading-snug text-black md:[font-size:2.25vw]">
            {beat.reaction}
          </p>

          <div className="mt-1 md:mt-[1vw]">
            {isFinal ? (
              <EndOfChapter onBack={onBack} onReplay={restart} />
            ) : (
              <div key={index} className="flex flex-col gap-2 md:gap-[0.85vw]">
                {beat.choices.map((choice) => (
                  <ChoiceRow key={choice.letter} choice={choice} onSelect={() => select(choice)} />
                ))}

                {isComposing && (
                  <div className="flex items-center gap-2 rounded-full border border-black/15 bg-white px-4 py-2 md:gap-[0.8vw] md:[padding:1vw_1.8vw]">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") sendFreeform()
                      }}
                      placeholder="what do you actually say?"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-black/35 md:[font-size:1.25vw]"
                    />
                    <button
                      type="button"
                      onClick={sendFreeform}
                      disabled={!draft.trim()}
                      aria-label="Send"
                      className="cursor-pointer text-lg leading-none text-black transition-opacity disabled:cursor-default disabled:opacity-20 md:[font-size:1.9vw]"
                    >
                      ↑
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChoiceRow({ choice, onSelect }: { choice: StoryChoice; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full cursor-pointer items-center gap-2 rounded-full border border-black/15 px-4 py-2.5 text-left text-sm text-black/80 transition-colors duration-150 hover:border-black hover:bg-black hover:text-white md:gap-[0.8vw] md:[font-size:1.25vw] md:[height:3.6vw] md:[padding:0_1.8vw]"
    >
      <span className="font-bold">{choice.letter}.</span>
      {choice.isFreeform && <span aria-hidden>✦</span>}
      <span className="truncate group-hover:font-semibold">{choice.text}</span>
      <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
        →
      </span>
    </button>
  )
}

/** The chain has run out. Rather than leaving the player on a dead beat with no
 *  affordance, close the chapter and point back to the graph. */
function EndOfChapter({ onBack, onReplay }: { onBack: () => void; onReplay: () => void }) {
  return (
    <div className="flex flex-col gap-3 md:gap-[1.2vw]">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-black/40 md:[font-size:1.05vw]">
        end of chapter
      </span>
      <div className="flex flex-wrap gap-2 md:gap-[1vw]">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer rounded-full bg-black px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 md:[font-size:1.25vw] md:[height:3.6vw] md:[padding:0_2vw]"
        >
          Back to your world
        </button>
        <button
          type="button"
          onClick={onReplay}
          className="cursor-pointer rounded-full border border-black/15 px-5 py-2.5 text-sm text-black/80 transition-colors hover:border-black/40 md:[font-size:1.25vw] md:[height:3.6vw] md:[padding:0_2vw]"
        >
          Play again
        </button>
      </div>
    </div>
  )
}
