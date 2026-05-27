import { extractStreams } from './extractor.js';
import { expandStreamQualities, withTimeout, safeConfig } from '../utils/resolvers.js';

const PROVIDER_TIMEOUT = safeConfig('NUVIO_TIMEOUT_COFLIX', 60000);

async function getStreams(tmdbId, mediaType, season, episode) {
    const label = `Coflix ${mediaType} ${tmdbId} S${season}E${episode}`;
    console.log(`[Coflix] Request: ${label}`);

    try {
        const streams = await withTimeout(
            extractStreams(tmdbId, mediaType, season, episode),
            PROVIDER_TIMEOUT,
            label
        );
        return await expandStreamQualities(streams, {
            includeCodec: true,
        });
    } catch (error) {
        if (error.message?.includes('[Timeout]')) {
            console.warn(`[Coflix] ${error.message}`);
        } else {
            console.error(`[Coflix] Error:`, error);
        }
        return [];
    }
}

module.exports = { getStreams };
