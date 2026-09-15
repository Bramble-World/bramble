import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/services/auth/auth.service';
import { handleError } from '@/lib/utils/api.handler-errors';

// The reference shape for every protected handler: call requireCurrentUser with
// the Request, and let the thrown AppError fall through to handleError. The auth
// layer never builds a Response, so the error envelope stays defined in one place.
export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    // clerkId is an internal join key and is deliberately not returned.
    return NextResponse.json({ id: user.id, email: user.email });
  } catch (error) {
    return handleError(error);
  }
}
