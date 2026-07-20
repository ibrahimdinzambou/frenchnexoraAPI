'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const providers = new Map();

for (const entry of manifest.scrapers || []) {
    if (!entry.enabled) continue;

    const filename = path.join(__dirname, entry.filename);
    try {
        const implementation = require(filename);
        if (typeof implementation.getStreams === 'function') {
            providers.set(entry.id, { ...entry, implementation });
        }
    } catch (error) {
        console.warn(`[api] Provider ${entry.id} indisponible: ${error.message}`);
    }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.API_PROVIDER_TIMEOUT_MS || 55000);

function isUnsafeProxyHost(hostname) {
    const host = hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '0.0.0.0'
        || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function proxyUrl(baseUrl, target, headers = {}) {
    const params = new URLSearchParams({ url: target });
    if (Object.keys(headers).length) params.set('headers', JSON.stringify(headers));
    return `${baseUrl}/api/proxy?${params}`;
}

async function fetchRemote(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url, options);
            if (response.status < 500 || attempt === 2) return response;
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw lastError || new Error('Source distante indisponible');
}

async function handleProxyRequest(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/proxy') return false;

    let target;
    try {
        target = new URL(url.searchParams.get('url') || '');
        if (!['http:', 'https:'].includes(target.protocol) || isUnsafeProxyHost(target.hostname)) throw new Error('URL refusée');
    } catch (_) {
        return json(res, 400, { error: 'URL de source invalide.' });
    }

    let headers = {};
    try {
        headers = JSON.parse(url.searchParams.get('headers') || '{}');
        headers = Object.fromEntries(Object.entries(headers).filter(([key, value]) =>
            ['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'cookie'].includes(key.toLowerCase()) && typeof value === 'string'
        ));
    } catch (_) {
        headers = {};
    }
    headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0';
    if (req.headers.range) headers.Range = req.headers.range;

    try {
        const response = await fetchRemote(target, { headers, redirect: 'follow' });
        if (!response.ok) return json(res, response.status, { error: `Source distante: HTTP ${response.status}` });
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            return json(res, 502, { error: 'La source a renvoyé une page HTML au lieu d’un flux vidéo.' });
        }
        const isPlaylist = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(response.url || target.href);

        if (isPlaylist) {
            let playlist = await response.text();
            const base = new URL(response.url || target.href);
            playlist = playlist.split(/\r?\n/).map(line => {
                const uriMatch = line.match(/URI="([^"]+)"/);
                const raw = uriMatch ? uriMatch[1] : (!line.startsWith('#') && line.trim() ? line.trim() : null);
                if (!raw) return line;
                const absolute = new URL(raw, base).href;
                const rewritten = proxyUrl('', absolute, headers);
                return uriMatch ? line.replace(uriMatch[1], rewritten) : rewritten;
            }).join('\n');
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(playlist);
            return true;
        }

        const responseHeaders = {
            'Content-Type': contentType || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
        };
        for (const name of ['content-length', 'content-range', 'last-modified', 'etag']) {
            const value = response.headers.get(name);
            if (value) responseHeaders[name] = value;
        }
        res.writeHead(response.status === 206 ? 206 : 200, responseHeaders);
        if (response.body) Readable.fromWeb(response.body).pipe(res);
        else res.end();
        return true;
    } catch (error) {
        console.error(`[proxy] ${target.href}: ${error.message}`);
        return json(res, 502, { error: 'Impossible de joindre la source distante.' });
    }
}

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout après ${timeoutMs} ms`)), timeoutMs);
            timer.unref?.();
        }),
    ]);
}

function providerInfo(provider) {
    return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        supportedTypes: provider.supportedTypes,
        contentLanguage: provider.contentLanguage,
        formats: provider.formats,
        logo: provider.logo,
    };
}

function normalizeStream(stream, provider) {
    return {
        url: stream.url,
        title: stream.title || stream.name || `${provider.name} (FR)`,
        quality: stream.quality || null,
        type: stream.type || null,
        language: stream.language || 'fr',
        provider: provider.id,
        providerName: provider.name,
        headers: stream.headers || undefined,
    };
}

function validateQuery(url) {
    const tmdbId = url.searchParams.get('tmdbId');
    const mediaType = url.searchParams.get('mediaType') || 'movie';
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');

    if (!tmdbId || !/^[a-zA-Z0-9_-]+$/.test(tmdbId)) {
        return { error: 'Le paramètre tmdbId est obligatoire.' };
    }
    if (!['movie', 'tv'].includes(mediaType)) {
        return { error: 'mediaType doit être « movie » ou « tv ».' };
    }
    if (mediaType === 'tv' && (!/^\d+$/.test(season || '') || !/^\d+$/.test(episode || ''))) {
        return { error: 'season et episode sont obligatoires pour une série TV.' };
    }

    return { tmdbId, mediaType, season: season || undefined, episode: episode || undefined };
}

async function getProviderStreams(provider, query) {
    try {
        const streams = await withTimeout(
            provider.implementation.getStreams(query.tmdbId, query.mediaType, query.season, query.episode),
            DEFAULT_TIMEOUT_MS
        );
        return {
            provider: providerInfo(provider),
            status: 'ok',
            streams: Array.isArray(streams)
                ? streams.filter(stream => stream && typeof stream.url === 'string' && stream.url.trim())
                    .map(stream => normalizeStream(stream, provider))
                : [],
        };
    } catch (error) {
        return {
            provider: providerInfo(provider),
            status: 'error',
            error: error.message,
            streams: [],
        };
    }
}

async function handleApiRequest(req, res, url) {
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'Méthode non autorisée.' });
    }

    if (url.pathname === '/api/health') {
        return json(res, 200, {
            status: 'ok',
            language: 'fr',
            providers: providers.size,
            timestamp: new Date().toISOString(),
        });
    }

    if (url.pathname === '/api/providers') {
        return json(res, 200, {
            language: 'fr',
            count: providers.size,
            providers: [...providers.values()].map(providerInfo),
        });
    }

    const providerMatch = url.pathname.match(/^\/api\/streams\/([^/]+)$/);
    if (providerMatch || url.pathname === '/api/streams') {
        const query = validateQuery(url);
        if (query.error) return json(res, 400, { error: query.error });

        const requested = providerMatch ? providerMatch[1] : (url.searchParams.get('provider') || 'all');
        const selected = requested === 'all'
            ? [...providers.values()]
            : [providers.get(requested)].filter(Boolean);

        if (!selected.length) return json(res, 404, { error: `Provider inconnu: ${requested}` });

        const results = await Promise.all(selected.map(provider => getProviderStreams(provider, query)));
        const streams = results.flatMap(result => result.streams);
        return json(res, 200, {
            language: 'fr',
            query,
            provider: requested,
            total: streams.length,
            streams,
            providers: results.map(result => ({
                id: result.provider.id,
                name: result.provider.name,
                status: result.status,
                count: result.streams.length,
                error: result.error,
            })),
        });
    }

    return false;
}

module.exports = { handleApiRequest, handleProxyRequest, providers };
