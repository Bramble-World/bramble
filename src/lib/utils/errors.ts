/**
 * Typed application errors.
 *
 * Throw these from services and readers/writers. Route handlers catch them in
 * `handleError`, which maps `statusCode` and `code` onto the HTTP response — so
 * a service never needs to know it is being called over HTTP.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
    // `new.target` is the subclass actually constructed, so logs and Sentry
    // show "NotFoundError" rather than a uniform "AppError".
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} not found: ${id}` : `${resource} not found`, 'NOT_FOUND', 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(message, 'FORBIDDEN', 403);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public fields?: Record<string, string>
  ) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

export class RateLimitError extends AppError {
  constructor(public retryAfter: number) {
    super('Rate limit exceeded', 'RATE_LIMITED', 429);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'An unexpected error occurred') {
    super(message, 'INTERNAL_SERVER_ERROR', 500);
  }
}

/**
 * Generation failures, split by what the client should do about them.
 *
 * They were one error until now — `generator.openai.ts` mapped both "the model
 * answered but not against the schema" and "the provider blew up" onto a generic
 * InternalServerError. That is fine for a page and wrong for a client, because
 * the two want opposite retry policies: a schema mismatch is usually
 * deterministic and retrying burns money for the same failure, while a provider
 * blip usually clears.
 */
export class GenerationUnusableError extends AppError {
  constructor(message = 'The model returned no usable output') {
    super(message, 'GENERATION_UNUSABLE', 500);
  }
}

export class GenerationFailedError extends AppError {
  constructor(message = 'Generation failed') {
    super(message, 'GENERATION_FAILED', 503);
  }
}

/**
 * Our own deadline fired, not the provider's.
 *
 * 504 rather than 500 because the work may well have succeeded on their side;
 * we simply stopped waiting. Safe to retry: every generation in this app is
 * get-or-create against database state, so a retry either finds the finished
 * work or redoes it exactly once.
 */
export class GenerationTimeoutError extends AppError {
  constructor(public retryAfter = 5) {
    super('Generation took too long', 'GENERATION_TIMEOUT', 504);
  }
}

/**
 * The provider throttled us — distinct from our own quota.
 *
 * Kept apart from RateLimitError on purpose. They would otherwise be
 * indistinguishable on the wire while needing opposite client behaviour: this
 * one clears on its own and should be retried after `retryAfter`, whereas our
 * quota means stop and tell the user.
 */
export class UpstreamBusyError extends AppError {
  constructor(public retryAfter = 60) {
    super('The model provider is busy', 'UPSTREAM_BUSY', 429);
  }
}

/**
 * A storyline that is not playable yet, or never will be.
 *
 * 409 rather than 400: nothing is wrong with the request, the resource is in the
 * wrong state. The client shows "still preparing" and polls, which is a
 * different screen from "you sent something bad".
 */
export class StorylineNotReadyError extends AppError {
  constructor(public storylineStatus: string) {
    super(
      `This storyline is not ready to play (status: ${storylineStatus})`,
      'STORYLINE_NOT_READY',
      409
    );
  }
}

/** A generation is already running for this session. Wait and re-call. */
export class GenerationInProgressError extends AppError {
  constructor(public retryAfter = 2) {
    super('A turn is already being generated for this session', 'GENERATION_IN_PROGRESS', 409);
  }
}

/**
 * The account has spent its conversation allowance.
 *
 * 409 rather than 403: nothing about the caller is unauthorised, the resource
 * simply cannot be created in the state the account is currently in. A client
 * that treated this as an auth failure would sign the reader out.
 */
export class ImportLimitReachedError extends AppError {
  constructor(public limit: number) {
    super(`This account can import ${limit} conversations.`, 'IMPORT_LIMIT_REACHED', 409);
  }
}

/**
 * The transcript is past what a single extraction can carry.
 *
 * 413 rather than 400, because the request is well-formed — it is only too big,
 * and the remedy is to send less of it rather than to fix its shape. The Mac
 * already trims to the newest messages that fit; reaching this means the two
 * ceilings have drifted apart.
 */
export class TranscriptTooLargeError extends AppError {
  constructor(public maxChars: number) {
    super(
      `That transcript is past the ${maxChars} character ceiling.`,
      'TRANSCRIPT_TOO_LARGE',
      413
    );
  }
}

/**
 * The transcript was gone before the worker read it.
 *
 * Retryable, and the client already holds the only durable copy: expiry,
 * eviction and a crash between enqueue and read all land here, and the remedy
 * for each is the same re-send.
 */
export class TranscriptExpiredError extends AppError {
  constructor() {
    super('That transcript is no longer being held.', 'TRANSCRIPT_EXPIRED', 410);
  }
}

/**
 * The client is older than this server supports.
 *
 * 426 Upgrade Required, which is the one status that means exactly this. A 400
 * would read as "you sent something malformed" and a 403 as "you are not
 * allowed" — both send a reader looking in the wrong place, and the client
 * cannot act on either.
 *
 * The message is written to be shown to a person, because it is the one error
 * here whose remedy the reader performs themselves.
 */
export class ClientTooOldError extends AppError {
  constructor() {
    super('This version of Bramble is too old. Please update.', 'CLIENT_TOO_OLD', 426);
  }
}
