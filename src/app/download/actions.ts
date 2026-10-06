'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { checkBetaCode } from './beta-access';

/**
 * Exchanges a beta code for the download link.
 *
 * A Server Action is a POST endpoint against this page, reachable by anyone who
 * can send the request — the form that renders it is not a boundary. So the
 * check lives here and the URL is read here, rather than being handed to the
 * page and hidden with CSS.
 *
 * The return is narrow on purpose: a URL or a reason, never the configured code
 * and never a hint about which part was wrong.
 */

const schema = z.object({
  code: z.string().min(1).max(64),
});

export type DownloadState = {
  url?: string;
  label?: string | null;
  error?: string;
};

/**
 * Who is guessing, for throttling.
 *
 * `x-forwarded-for` is set by whatever proxy terminates TLS; the left-most entry
 * is the client. It is spoofable by anyone talking to the origin directly, which
 * is why the throttle is a speed bump rather than a control — behind Porter's
 * load balancer the header is rewritten and this holds for ordinary traffic.
 */
async function fingerprint(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

export async function requestDownload(
  _previous: DownloadState,
  formData: FormData
): Promise<DownloadState> {
  const parsed = schema.safeParse({ code: formData.get('code') });
  if (!parsed.success) return { error: 'Enter your code.' };

  const result = await checkBetaCode(parsed.data.code, await fingerprint());

  if (result.ok) return { url: result.url, label: result.label };

  switch (result.reason) {
    case 'closed':
      return { error: 'The beta is not open yet. Join the Discord and we will send a code.' };
    case 'throttled':
      return { error: 'Too many attempts. Try again in a few minutes.' };
    default:
      // Deliberately the same wording whether the code was wrong or malformed.
      return { error: "That code doesn't work. Check it and try again." };
  }
}
