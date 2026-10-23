// Shared settings with no npm imports, so scripts/check-deps.mjs can load them before `npm install`.

export const BRAVE_PATH =
  process.env.BRAVE_PATH ||
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

// AdsPower Local API, tried in order.
export const ADSPOWER_API_URLS = [
  process.env.ADSPOWER_API_URL,
  "http://127.0.0.1:50325",
  "http://local.adspower.net:50325",
].filter(Boolean);
