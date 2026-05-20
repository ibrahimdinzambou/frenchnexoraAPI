/**
 * Provider Health Monitor
 * Tests all providers against a curated set of titles.
 * Outputs structured JSON for CI/aggregation.
 *
 * Usage:
 *   node monitor.js                          # test all providers
 *   node monitor.js --providers voiranime,sekai  # test specific
 *   node monitor.js --json                   # JSON output only
 *   node monitor.js --quick                  # fewer test cases
 *
 * Exit codes:
 *   0 - all providers healthy
 *   1 - some providers degraded
 *   2 - critical failures
 */

const PROVIDERS = [
    'sekai', 'voiranime', 'vostfree', 'animevostfr', 'anime-sama',
    'animesultra', 'animoflix', 'animesite', 'french-anime', 'frenchstream',
    'jetanimes', 'movix', 'mugiwarastream', 'dulourd'
];

const TV_CASES = [
    { tmdbId: 64196, mediaType: 'tv', season: 1, episode: 1, label: 'Overlord S1E1' },
    { tmdbId: 64196, mediaType: 'tv', season: 3, episode: 1, label: 'Overlord S3E1' },
    { tmdbId: 1429, mediaType: 'tv', season: 1, episode: 1, label: 'AOT S1E1' },
    { tmdbId: 76479, mediaType: 'tv', season: 1, episode: 1, label: 'JJK S1E1' },
    { tmdbId: 65930, mediaType: 'tv', season: 1, episode: 1, label: 'MHA S1E1' },
    { tmdbId: 85937, mediaType: 'tv', season: 1, episode: 1, label: 'Demon Slayer S1E1' },
];

const MOVIE_CASES = [
    { tmdbId: 129, mediaType: 'movie', label: 'Spirited Away' },
    { tmdbId: 372058, mediaType: 'movie', label: 'Your Name' },
];

const QUICK_CASES = [
    { tmdbId: 64196, mediaType: 'tv', season: 1, episode: 1, label: 'Overlord S1E1' },
    { tmdbId: 1429, mediaType: 'tv', season: 1, episode: 1, label: 'AOT S1E1' },
];

const TIMEOUT_PER_CASE = 60000;

const args = process.argv.slice(2);
const FLAG_JSON = args.includes('--json');
const FLAG_QUICK = args.includes('--quick');
const flagProviders = args.find(a => a.startsWith('--providers='));
const toTest = flagProviders
    ? flagProviders.split('=')[1].split(',').filter(p => PROVIDERS.includes(p))
    : PROVIDERS;

const testCases = FLAG_QUICK ? QUICK_CASES : [...TV_CASES, ...MOVIE_CASES];

function fmt(ms) {
    return (ms / 1000).toFixed(1) + 's';
}

async function main() {
    const results = {};

    for (const name of toTest) {
        let mod;
        try {
            mod = require(`./providers/${name}.js`);
        } catch (e) {
            results[name] = { status: 'error', error: `LOAD_FAILED: ${e.message}`, cases: [] };
            continue;
        }
        if (typeof mod.getStreams !== 'function') {
            results[name] = { status: 'error', error: 'NO_GETSTREAMS', cases: [] };
            continue;
        }

        const caseResults = [];
        for (const tc of testCases) {
            const start = Date.now();
            let streams, error;
            try {
                const promise = mod.getStreams(tc.tmdbId, tc.mediaType, tc.season, tc.episode);
                const timer = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_PER_CASE)
                );
                streams = await Promise.race([promise, timer]);
            } catch (e) {
                error = e.message || String(e);
            }
            const elapsed = Date.now() - start;
            const direct = (streams || []).filter(s => s && s.isDirect).length;
            const total = (streams || []).length;

            const ok = total > 0 && direct > 0;
            caseResults.push({
                label: tc.label,
                ok,
                total,
                direct,
                elapsed,
                error: error || null,
                firstUrl: total > 0 ? ((streams[0]?.url || '').slice(0, 60)) : null,
            });
        }

        const totalOk = caseResults.filter(c => c.ok).length;
        const totalCases = caseResults.length;
        let status = 'healthy';
        if (totalOk === 0) status = 'dead';
        else if (totalOk < totalCases) status = 'degraded';

        results[name] = { status, cases: caseResults, okRate: `${totalOk}/${totalCases}` };
    }

    // Summary
    const healthy = Object.values(results).filter(r => r.status === 'healthy').length;
    const degraded = Object.values(results).filter(r => r.status === 'degraded').length;
    const dead = Object.values(results).filter(r => r.status === 'dead').length;
    const errors = Object.values(results).filter(r => r.status === 'error').length;

    const summary = {
        timestamp: new Date().toISOString(),
        totalProviders: toTest.length,
        healthy,
        degraded,
        dead,
        errors,
        results,
    };

    // Always write artifacts for CI
    const fs = require('fs');
    fs.writeFileSync('monitor-results.json', JSON.stringify(summary, null, 2));

    if (FLAG_JSON) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(`\n=== Provider Health Monitor ===`);
        console.log(`Tested: ${testCases.length} cases x ${toTest.length} providers`);
        console.log(`Timestamp: ${summary.timestamp}\n`);

        for (const [name, r] of Object.entries(results)) {
            const icon = r.status === 'healthy' ? '✓' : r.status === 'degraded' ? '~' : r.status === 'dead' ? '✗' : '!';
            console.log(`${icon} ${name}: ${r.status} (${r.okRate})`);
            if (!FLAG_JSON) {
                for (const c of r.cases) {
                    const ci = c.ok ? '✓' : '✗';
                    const t = c.error ? ` ERROR=${c.error}` : ` ${c.direct}/${c.total} direct`;
                    console.log(`   ${ci} ${c.label}${t} ${fmt(c.elapsed)}`);
                }
            }
        }

        console.log(`\nSummary: ${healthy} healthy, ${degraded} degraded, ${dead} dead, ${errors} errors`);

        const exitCode = dead > 0 ? 2 : degraded > 0 ? 1 : 0;
        process.exit(exitCode);
    }
}

main().catch(e => {
    console.error('Monitor crashed:', e.message);
    process.exit(2);
});
