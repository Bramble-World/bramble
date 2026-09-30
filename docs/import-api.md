# Conversation import API

The macOS app sends up to three conversations per account to the backend,
which turns each one into a storyline. Extraction runs as a background job.
The messages wait in Redis, encrypted, only until the job has read them.

Status: **proposed**. The backend endpoints don't exist yet. The Mac client
(`BrambleWorld/Networking/API/ImportAPI.swift`) still expects the earlier
synchronous shape and will be updated to this one.

## Principles

1. **Messages never reach a long-term store.** Postgres holds only the
   model's retelling (storylines, people, events) and an `imports` row with
   no message content. The transcript exists as ciphertext in Redis with a
   30-minute expiry, and as plaintext only in the memory of the worker
   extracting it.
2. **Encrypted everywhere it rests.** Nothing on the platform can read a
   transcript without both Redis access _and_ the master key. The job queue
   only ever carries an ID.
3. **The server enforces the limit.** An account may import **3
   conversations, ever**. The client mirrors this for its UI. The server is
   the authority.
4. **No real contact details arrive.** The Mac replaces phone numbers and
   emails with keyed pseudonyms (`c_…`) before sending. The backend hashes
   these with `hashContactHandle` as it would a real handle, so continuity
   across a reader's storylines still works.
5. **The Mac is the durable copy.** If a transcript expires or an import
   fails, the client re-sends it. `conversationKey` makes that idempotent.

## Flow

```
Mac                         API                              Redis            Queue / worker
 │ POST /imports ──────────▶ validate, reserve slot
 │                           imports row: status=queued
 │                           encrypt transcript ─────────▶ SET import:{id}
 │                                                          EX 1800
 │                           enqueue { importId } ─────────────────────────▶
 │ ◀────────── 202 { import }
 │                                                                           GET import:{id}, decrypt
 │ GET /imports/{id} (poll)                                                  status=reading → writing
 │ ◀────────── { status, stage }                                             stream Claude call
 │                                                                           persist storyline +
 │                                                                           consume slot (one tx)
 │                                                          DEL import:{id} ◀ status=ready
 │ GET /imports/{id} ◀──── { status: ready, storylineId }
```

## Endpoints

All require Bearer auth.

### `GET /api/v1/imports`

This returns the account's allowance and imports.

```json
200 {
  "limit": 3,
  "used": 1,
  "imports": [ImportView, …]
}
```

- **`used`** counts imports that are `ready`.
- **`pending`** (optional, computed by the client) counts `queued`/`running`
  imports.
- **Remaining slots** are `limit - used - pending`.

### `POST /api/v1/imports`

```json
{
  "conversationKey": "conv_3fa29b0c1d7e4a55",
  "transcript": {
    "surface": "imessage",
    "messages": [
      {
        "isFromMe": false,
        "handle": "c_9b1e04a7d2f3c611",
        "sender": "Maya",
        "text": "…",
        "sentAt": "2026-03-02T19:04:00.000Z"
      },
      {
        "isFromMe": true,
        "handle": "me",
        "sender": "me",
        "text": "…",
        "sentAt": "2026-03-02T19:41:00.000Z"
      }
    ]
  }
}
```

The transcript is exactly `Transcript` / `TranscriptMessage` from
`extraction.prompt.ts`:

- **`handle`** is a sender pseudonym (`c_` + 16 hex characters) or `"me"`. It
  is never a phone number or email.
- **`sender`** is the name from the reader's Contacts. With no match it is
  `"Person A"`, `"Person B"`, and so on.
- **Filtering:** messages are oldest first. Reactions, tapbacks and system rows
  are already removed.
- **Size:** at most `MAX_TRANSCRIPT_CHARS` (400,000) characters of text. The
  client keeps the newest messages that fit.
- **Minimum length:** at least `MIN_THREAD_MESSAGES` (50) messages.

**Responses:**

- **`202 { "import": ImportView }`:** accepted and queued. The server
  returns quickly and does no extraction in the request.
- **`200 { "import": ImportView }`:** an import with this `conversationKey`
  already exists and is `queued`, `running` or `ready`. It is returned as-is:
  no new job, no new slot.
- **A `failed` import with the same key is replaced:** it gets a new job and
  fresh ciphertext. This is how the client re-sends.

### `GET /api/v1/imports/{importId}`

```json
200 { "import": ImportView }
```

The client polls this every ~5 s while an import is `queued` or `running`.
It is cheap: one row read, no Redis.

### `ImportView`

```json
{
  "id": "uuid",
  "conversationKey": "conv_…",
  "status": "queued | running | ready | failed",
  "stage": "reading | writing | casting | null",
  "storylineId": "uuid | null",
  "failure": { "code": "string", "retryable": true } | null,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

- **`stage`** is only set while `running`. Extraction is one model call, so
  progress is reported as stages, not a percentage.
- **`failure.retryable`** tells the client whether to re-send
  (`TRANSCRIPT_EXPIRED`, `GENERATION_FAILED`, `GENERATION_TIMEOUT`) or to
  stop and show the error (`GENERATION_UNUSABLE`, `VALIDATION_ERROR`).
- **The response carries no message content,** ever.

## Errors (standard envelope)

| Status | Code                   | When                                                                                                |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| 409    | `IMPORT_LIMIT_REACHED` | `used + pending == limit` and the key is new                                                        |
| 413    | `TRANSCRIPT_TOO_LARGE` | Over 400,000 characters                                                                             |
| 400    | `VALIDATION_ERROR`     | Malformed transcript, fewer than 50 messages, or a `handle` that looks like a phone number or email |
| 404    | `NOT_FOUND`            | Unknown import, or someone else's                                                                   |

## Storage rules

### Postgres: `imports` table

- **Columns:** `id`, `userId`, `conversationKey`, `status`, `stage`,
  `storylineId`, `failureCode`, `createdAt`, `updatedAt`.
- **Nothing from the transcript.**
- **Unique index:** on (`userId`, `conversationKey`).

### Redis

- **Key:** `import:{importId}`, holding ciphertext only.
- **Expiry:** set on write, `EX 1800` (30 minutes).
- **Deletion:** the worker deletes the key when the job ends, on success or
  failure.
- **Saving to disk:** turn off RDB/AOF persistence if the provider allows
  it. Otherwise ciphertext reaches disk until it expires.
- **Eviction:** an evicted key behaves like an expired one (`failed`,
  retryable). The client re-sends.

### Encryption

This is envelope encryption.

- **Per-import key:** a random 256-bit data key, generated per import,
  encrypts the transcript with AES-256-GCM.
- **Wrapping:** the data key is encrypted with a master key held in a KMS,
  or at least in a secret separate from the Redis credentials. The wrapped
  data key is stored alongside the ciphertext.
- **Binding:** associated data is `importId:userId`, so a ciphertext can't be
  replayed into another import or account.
- **Master key location:** it never goes into Redis or the job payload.

### Job queue

- **Payload:** exactly `{ importId }`.
- **What the worker reads:** it fetches the ciphertext from Redis, decrypts
  it in memory, and never logs it.
- **Model call:** the Claude call streams. This removes the 300 s
  headers-timeout ceiling noted in `extraction.prompt.ts`.
- **Retries:** allowed while the Redis key exists. If the key is missing,
  mark the import `failed` with `TRANSCRIPT_EXPIRED` and `retryable: true`.
- **Stuck jobs:** a sweep marks imports `queued`/`running` for longer than
  30 minutes as `failed` (retryable).

### Logging

Never log request bodies on `/imports`, Redis values, decrypted transcripts,
or model prompts/outputs for extraction.

## Counting the limit

- **A slot is reserved** when an import is `queued` or `running`.
- **A slot is used** only when it becomes `ready`, in the same transaction
  that writes the storyline.
- **A failed import releases its slot.**
- **Races:** two concurrent POSTs for the last slot must not both succeed.
  Count inside the transaction that inserts the row, with a row lock or a
  serialisable check.

## What the privacy promise becomes

Update `invariants.md` §1 to say:

> Message content is never written to a long-term store. It is held
> encrypted in Redis for at most 30 minutes, readable only by the extraction
> worker, which deletes it when done. Anthropic receives the transcript to
> perform the extraction.

---

## Configuration

`.env.example` is gitignored in this repo, so the two new variables are recorded
here instead. Both must be set in Doppler for `dev`, `stg` and `prd` before the
endpoints work; without them the store throws a clear error rather than
degrading, because the degraded version of "we hold this privately" is "we hold
this".

| Variable            | What it is                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- |
| `REDIS_URL`         | Where ciphertext waits. `docker compose up -d redis` provides it locally.              |
| `IMPORT_MASTER_KEY` | Wraps every per-import data key. Exactly 32 bytes, base64 — `openssl rand -base64 32`. |

`IMPORT_MASTER_KEY` is deliberately a different secret from `REDIS_URL`.
Envelope encryption buys nothing if the key sits beside the credentials that
reach the ciphertext.

## Where this implementation departs from the spec above

Three places, each because following the text literally would have left a hole:

1. **Retrying a failed import still checks the allowance.** The error table says
   the 409 applies when "the key is new", which would let an account reach four
   ready imports: three ready plus one failed, whose slot was released and taken
   by a fourth, then re-sent. The retry is exempted from counting _its own_ row
   and nothing else, so a re-send never fails for a reader who is within their
   allowance and can never take them past it.
2. **A retryable failure leaves the ciphertext in Redis.** The storage rules say
   the worker deletes the key "on success or failure", and also that retries are
   allowed "while the Redis key exists". Deleting on every failure makes the
   second rule unreachable — every retry would fail on a missing transcript
   rather than on whatever actually went wrong. Terminal failures delete
   immediately; retryable ones leave it to the 30-minute expiry.
3. **The slot is consumed next to the storyline write, not inside the same
   transaction.** `extractStoryline` owns its own transaction boundaries and
   restructuring it was out of scope here. Instead the import records which
   storyline it is building _before_ the model call, so a crash in between is
   recoverable: the retry adopts the finished storyline rather than paying for a
   second extraction and leaving the reader the same conversation twice.
