import { NextResponse } from 'next/server';
import { handleError } from '@/lib/utils/api.handler-errors';

// Liveness only — deliberately does not touch the database, so a slow or
// unreachable database can't make the app look dead to an uptime check or a
// deploy gate. Restarting every replica because Postgres blipped turns a brief
// outage into a cold start under load. Dependency checks live in /api/ready,
// which is what decides whether traffic is sent to this replica.
export async function GET() {
  try {
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    return handleError(error);
  }
}
