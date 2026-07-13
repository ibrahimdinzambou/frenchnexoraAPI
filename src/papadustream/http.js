/**
 * HTTP Utilities for Papadustream
 */

import { safeFetch, createProviderRateLimiter } from '../utils/resolvers.js';

const rateLimit = createProviderRateLimiter();
const DOMAIN = 'papadustream.club';

export const BASE_URL = 'https://papadustream.club';
export const BASE_URL_WWW = 'https://www.papadustream.club';
export const GLOBAL_TIMEOUT_MS = 15000;

export const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
    'Origin': BASE_URL,
    'Connection': 'keep-alive'
};

export async function fetchText(url, options = {}) {
    await rateLimit(DOMAIN);
    console.log(`[Papadustream] Fetching: ${url}`);
    const origin = options.origin || BASE_URL;
    const timeout = options.timeout || GLOBAL_TIMEOUT_MS;
    const mergedHeaders = {
        ...HEADERS,
        Referer: `${origin}/`,
        Origin: origin,
        ...(options.headers || {})
    };

    const res = await safeFetch(url, { headers: mergedHeaders, timeout });
    if (!res || !res.ok) {
        const status = res && typeof res.status === 'number' ? res.status : 'no-response';
        console.warn(`[Papadustream] HTTP error ${status} for ${url}`);
        return null;
    }

    return await res.text();
}
