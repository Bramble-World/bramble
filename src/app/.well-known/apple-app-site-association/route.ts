/**
 * Universal links for the iPhone app: `/open` and everything under it open
 * Bramble on the desk when it's installed (`OPEN_APP_URL`). Apple fetches this
 * from www.brambleworld.com through its CDN, so it must be JSON at exactly this
 * path, with no redirect. Nothing else on the site opens the app.
 */
const APP_ID = 'K555FJZF47.com.brambleworld.BrambleMobile';

export function GET(): Response {
  return Response.json(
    {
      applinks: {
        details: [
          {
            appIDs: [APP_ID],
            components: [{ '/': '/open' }, { '/': '/open/*' }],
          },
        ],
      },
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
