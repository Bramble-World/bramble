/**
 * Outbound links that appear on more than one page.
 *
 * Here because the Discord invite was previously written out twice, and an
 * invite that expires has to be replaced everywhere at once or a page quietly
 * sends people to a dead door.
 */
export const DISCORD_INVITE_URL = 'https://discord.gg/WNRdvWu8M';

/**
 * Opens the iPhone app on the desk: a universal link (`/open/*` is claimed by
 * the app in `/.well-known/apple-app-site-association`). Without the app it's
 * a page on the website that points to it. Bramble in ChatGPT puts it in its
 * replies, so a player can get back from ChatGPT in one tap.
 */
export const OPEN_APP_URL = 'https://www.brambleworld.com/open/desk';
