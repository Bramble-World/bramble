import { describe, expect, it } from 'vitest';
import { handleError } from './api.handler-errors';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from './errors';
import { parseApiError } from './parse-api-error';

describe('AppError hierarchy', () => {
  it('maps each error to its status and code', () => {
    expect([new NotFoundError('User').statusCode, new NotFoundError('User').code]).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(new UnauthorizedError().statusCode).toBe(401);
    expect(new ForbiddenError().statusCode).toBe(403);
    expect(new ValidationError('bad').statusCode).toBe(400);
    expect(new ConflictError('dupe').statusCode).toBe(409);
    expect(new RateLimitError(30).statusCode).toBe(429);
  });

  it('includes the id in a NotFoundError message when given', () => {
    expect(new NotFoundError('User', 'abc').message).toBe('User not found: abc');
    expect(new NotFoundError('User').message).toBe('User not found');
  });

  it('reports the subclass name, not the base name', () => {
    expect(new NotFoundError('User').name).toBe('NotFoundError');
    expect(new AppError('boom', 'BOOM').name).toBe('AppError');
  });

  it('stays an instanceof Error and AppError', () => {
    const err = new ConflictError('dupe');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('handleError', () => {
  it('serialises an AppError to its status and body', async () => {
    const res = handleError(new NotFoundError('User', 'abc'));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'User not found: abc' },
    });
  });

  it('includes field errors for a ValidationError', async () => {
    const res = handleError(new ValidationError('Invalid', { email: 'required' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid',
        fields: { email: 'required' },
      },
    });
  });

  it('sets Retry-After for a RateLimitError', async () => {
    const res = handleError(new RateLimitError(30));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    await expect(res.json()).resolves.toMatchObject({ error: { retryAfter: 30 } });
  });

  it('never leaks details from an unexpected error', async () => {
    const res = handleError(new Error('SELECT * FROM users failed: password=hunter2'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

describe('parseApiError', () => {
  it('reads the structured shape handleError emits', () => {
    expect(parseApiError({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404)).toEqual(
      {
        message: 'User not found',
        code: 'NOT_FOUND',
      }
    );
  });

  it('reads a bare string error', () => {
    expect(parseApiError({ error: 'Nope' }, 400)).toEqual({ message: 'Nope', code: null });
  });

  it('falls back to the status for unrecognised bodies', () => {
    expect(parseApiError(null, 503)).toEqual({ message: 'Request failed (503)', code: null });
    expect(parseApiError({ nope: 1 }, 500)).toEqual({
      message: 'Request failed (500)',
      code: null,
    });
  });

  it('round-trips with handleError', async () => {
    const body = await handleError(new ForbiddenError()).json();
    expect(parseApiError(body, 403)).toEqual({
      message: "You don't have permission to do this",
      code: 'FORBIDDEN',
    });
  });
});
