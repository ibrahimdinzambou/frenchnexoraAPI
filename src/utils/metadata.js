/**
 * Shared Metadata Utilities
 * Uses the TMDB JSON API (much more reliable than HTML scraping in apps)
 */

const TMDB_API_KEY = "8265bd1679663a7ea12ac168da84d2e8";
const TMDB_API_BASE = "https://api.themoviedb.org/3";

import { safeFetch } from './resolvers.js';

const SEASON_SUFFIXES = [
    (s) => `Season ${s}`,
    (s) => `Saison ${s}`,
    (s) => `S${s}`,
];

function isLatinText(str) {
    return /^[\x00-\x7F\u00C0-\u024F\s\-,:!.'?&()0-9]+$/.test(str);
}

/**
 * Check if the given ID is in Kitsu format: kitsu:{id}:{season?}
 * @param {string|number} id
 * @returns {RegExpMatchArray|null} Match groups [fullMatch, kitsuId, seasonFromId] or null
 */
function parseKitsuId(id) {
    const strId = String(id);
    return strId.match(/^kitsu:(\d+)(?::(\d+))?$/);
}

/**
 * Get multiple titles for an anime from Kitsu ID.
 * Uses Kitsu API to get canonical title, English title, Japanese title, and abbreviated titles.
 * Generates season-aware variants if season is provided.
 * 
 * @param {string|number} kitsuId
 * @param {'tv'|'movie'} mediaType
 * @param {object} [opts]
 * @param {number} [opts.season] - If provided, generates "Title Season N" variants
 * @returns {Promise<string[]>}
 */
async function getKitsuTitles(kitsuId, mediaType, opts = {}) {
    // Fetch anime details from Kitsu API
    const url = `https://kitsu.io/api/edge/anime/${kitsuId}`;
    const res = await safeFetch(url);
    if (!res) {
        console.log(`[Metadata] Kitsu API error: failed to fetch ${kitsuId}`);
        return [];
    }
    
    let data;
    try {
        data = await res.json();
    } catch (e) {
        console.log(`[Metadata] Kitsu API error: invalid JSON for ${kitsuId}`);
        return [];
    }
    
    const anime = data?.data?.attributes;
    if (!anime) {
        console.log(`[Metadata] Kitsu API error: no anime data for ${kitsuId}`);
        return [];
    }
    
    const titles = [];
    
    // Canonical title (often the Romaji title)
    const canonicalTitle = anime.canonicalTitle?.trim();
    if (canonicalTitle) titles.push(canonicalTitle);
    
    // English title
    const enTitle = anime.titles?.en?.trim();
    if (enTitle && !titles.some(t => t.toLowerCase() === enTitle.toLowerCase())) {
        titles.push(enTitle);
    }
    
    // Japanese title
    const jaTitle = anime.titles?.ja_jp?.trim();
    if (jaTitle && !titles.some(t => t.toLowerCase() === jaTitle.toLowerCase()) && isLatinText(jaTitle)) {
        titles.push(jaTitle);
    }
    
    // Abbreviated titles
    const abbrTitles = anime.abbreviatedTitles || [];
    for (const t of abbrTitles) {
        const trimmed = t?.trim();
        if (trimmed && !titles.some(existing => existing.toLowerCase() === trimmed.toLowerCase()) && isLatinText(trimmed)) {
            titles.push(trimmed);
        }
    }
    
    // Season-aware variants
    const season = opts.season ? parseInt(opts.season, 10) : null;
    if (season && season > 0) {
        const baseTitles = [canonicalTitle, enTitle].filter(Boolean);
        for (const baseTitle of baseTitles) {
            for (const suffix of SEASON_SUFFIXES) {
                const variant = `${baseTitle} ${suffix(season)}`;
                if (!titles.some(t => t.toLowerCase() === variant.toLowerCase())) {
                    titles.push(variant);
                }
            }
        }
    }
    
    console.log(`[Metadata] Kitsu titles for ${kitsuId}: ${titles.join(' | ')}`);
    return titles;
}

/**
 * Get multiple titles for an anime from TMDB ID.
 * Returns an array with [English title, French title, Original title (romaji)]
 * All unique values, ordered by priority for searching.
 * Generates season-aware variants (e.g. "Overlord Season 1") for TV.
 *
 * @param {string|number} tmdbId
 * @param {'tv'|'movie'} mediaType
 * @param {object} [opts]
 * @param {number} [opts.season] - If provided, generates "Title Season N" variants
 * @returns {Promise<string[]>}
 */
export async function getTmdbTitles(tmdbId, mediaType, opts = {}) {
    // Handle Kitsu ID format: kitsu:{id}:{season?}
    const kitsuMatch = parseKitsuId(tmdbId);
    if (kitsuMatch) {
        const kitsuId = kitsuMatch[1];
        const seasonFromId = kitsuMatch[2] ? parseInt(kitsuMatch[2], 10) : null;
        // Use season from opts if provided, otherwise from the ID string
        const finalSeason = opts.season !== undefined ? opts.season : seasonFromId;
        return await getKitsuTitles(kitsuId, mediaType, { ...opts, season: finalSeason });
    }

    const type = mediaType === 'movie' ? 'movie' : 'tv';
    const titles = [];

    try {
        // 1. Main API call — English title + original title
        const mainUrl = `${TMDB_API_BASE}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const mainRes = await safeFetch(mainUrl);
        if (mainRes) {
            const data = await mainRes.json();
            const titleEn = (type === 'movie' ? data.title : data.name)?.trim();
            const titleOriginal = (type === 'movie' ? data.original_title : data.original_name)?.trim();
            const numberOfSeasons = data.number_of_seasons;

            if (titleEn) titles.push(titleEn);
            // Only add original if it differs and uses latin chars (romaji)
            if (titleOriginal && titleOriginal !== titleEn && isLatinText(titleOriginal)) {
                titles.push(titleOriginal);
            }

            // Generate season-aware variants
            if (mediaType === 'tv' && opts.season) {
                const s = parseInt(opts.season, 10);
                if (s > 0 && titleEn) {
                    for (const suffix of SEASON_SUFFIXES) {
                        const variant = `${titleEn} ${suffix(s)}`;
                        if (!titles.includes(variant)) titles.push(variant);
                    }
                }
                if (s > 0 && titleOriginal && titleOriginal !== titleEn && isLatinText(titleOriginal)) {
                    for (const suffix of SEASON_SUFFIXES) {
                        const variant = `${titleOriginal} ${suffix(s)}`;
                        if (!titles.includes(variant)) titles.push(variant);
                    }
                }
            }
        }

        // 2. French title via translations
        const transUrl = `${TMDB_API_BASE}/${type}/${tmdbId}/translations?api_key=${TMDB_API_KEY}`;
        const transRes = await safeFetch(transUrl);
        if (transRes) {
            const transData = await transRes.json();
            const frTrans = (transData.translations || []).find(t => t.iso_639_1 === 'fr');
            const titleFr = frTrans?.data?.name?.trim() || frTrans?.data?.title?.trim();
            if (titleFr && !titles.includes(titleFr)) {
                titles.push(titleFr);
            }
            // Season-aware French variants
            if (mediaType === 'tv' && opts.season && titleFr) {
                const s = parseInt(opts.season, 10);
                if (s > 0) {
                    const frVar = `${titleFr} Saison ${s}`;
                    if (!titles.includes(frVar)) titles.push(frVar);
                }
            }
        }

        // 3. Alternative titles (covers Romaji, English aliases, etc.)
        const altUrl = `${TMDB_API_BASE}/${type}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
        const altRes = await safeFetch(altUrl);
        if (altRes) {
            const altData = await altRes.json();
            const altList = type === 'movie' ? altData.titles : altData.results;
            if (altList && Array.isArray(altList)) {
                altList.forEach(alt => {
                    const t = alt.title?.trim();
                    if (t && !titles.some(existing => existing.toLowerCase() === t.toLowerCase()) && isLatinText(t)) {
                        if (alt.type === 'Romaji' || alt.iso_3166_1 === 'US' || alt.iso_3166_1 === 'FR' || alt.type === 'Search Tag') {
                            titles.splice(1, 0, t);
                        } else {
                            titles.push(t);
                        }
                    }
                });
            }
        }


    } catch (e) {
        console.error(`[Metadata] TMDB API error: ${e.message}`);
    }

    // Deduplicate array completely, preserving order
    const seen = new Set();
    const uniqueTitles = titles.filter(t => {
        const key = t.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`[Metadata] Titles for ${tmdbId}: ${uniqueTitles.join(' | ')}`);
    return uniqueTitles;
}
