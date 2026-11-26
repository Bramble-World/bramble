import { describe, expect, it } from 'vitest';
import { OPEN_APP_URL } from '@/lib/links';
import { GET } from './route';

describe('/.well-known/apple-app-site-association', () => {
  it('lets the iPhone app open /open links and invites, and nothing else', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json();
    expect(body.applinks.details).toEqual([
      {
        appIDs: ['K555FJZF47.com.brambleworld.BrambleMobile'],
        components: [{ '/': '/open' }, { '/': '/open/*' }, { '/': '/invite/*' }],
      },
    ]);
    expect(new URL(OPEN_APP_URL).pathname.startsWith('/open/')).toBe(true);
  });
});
