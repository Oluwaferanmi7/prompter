// Cloud library + Claude connector server (Cloudflare Worker). Empty = cloud features
// hidden; the app works exactly as before.
const LIVE = 'https://lim-prompter.josephfatile8.workers.dev';

// Local testing only: ?cloud=http://localhost:8787 points a dev copy at a local server.
// Ignored anywhere else, so a crafted link can't send someone's scripts elsewhere.
const dev = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('cloud');
export const CLOUD_URL = dev || LIVE;
