import { NextResponse } from 'next/server';
import { handleError } from '@/lib/utils/api.handler-errors';

// Liveness only — deliberately does not touch the database, so a slow or
// unreachable database can't make the app look dead to an uptime check or a
// deploy gate. Add a separate /api/ready if you need dependency checks.
export async function GET() {
  try {
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    return handleError(error);
  }
}
