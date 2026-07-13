/**
 * Cache intelligent partagé — withCache(namespace)
 *
 * Élimine la duplication du système de cache entre les providers.
 * Chaque provider crée sa propre instance avec son namespace :
 *
 *   const withCache = createCache('nk'); // Nakios → clés "nk_..."
 *   const withCache = createCache('pd'); // Papadustream → clés "pd_..."
 *
 * Fonctionnalités :
 * - TTL séparé pour succès (5 min) et échec (30s)
 * - Limite de taille (150 entrées) avec éviction LRU
 * - Nettoyage périodique des entrées expirées (toutes les 60s)
 * - Cache clé sécurisé (normalisation des caractères)
 * - Pas d'erreur mise en cache (l'appel pourra être retenté)
 *
 * Compatible QuickJS : Map, Date.now, async/await, pas de setTimeout/setInterval.
 */

// ─── Defaults ───────────────────────────────────────────────────────────────
const CACHE_SUCCESS_TTL = 300_000;  // 5 min pour les résultats positifs
const CACHE_FAILURE_TTL = 30_000;   // 30s pour les échecs (évite de spammer)
const CACHE_MAX_SIZE = 150;         // Nombre max d'entrées avant éviction
const CLEANUP_INTERVAL = 60_000;    // Nettoyage auto toutes les 60s

// ─── Global Cache Store ─────────────────────────────────────────────────────
// Un seul Map partagé entre tous les providers — le namespace dans la clé
// évite les collisions et le size limit global (150) est plus efficace.
const cache = new Map();
let lastCleanup = Date.now();

/**
 * Nettoie les entrées expirées du cache et limite la taille si nécessaire.
 * @param {string} tag - Tag de log (ex: "Nakios", "Papadustream")
 */
function cleanCache(tag) {
    const now = Date.now();
    const expired = [];

    // 1. Supprimer les entrées expirées
    for (const [key, entry] of cache) {
        if (now - entry.ts >= entry.ttl) {
            expired.push(key);
        }
    }
    for (const key of expired) {
        cache.delete(key);
    }

    // 2. Si le cache dépasse la limite, supprimer les plus vieilles
    if (cache.size > CACHE_MAX_SIZE) {
        const sorted = [...cache.entries()]
            .sort((a, b) => a[1].ts - b[1].ts);
        const toRemove = sorted.slice(0, cache.size - CACHE_MAX_SIZE);
        for (const [key] of toRemove) {
            cache.delete(key);
        }
    }

    if (expired.length > 0) {
        console.log(`[${tag}] Cache: ${expired.length} expirées supprimées, ${cache.size} entrées restantes`);
    }

    lastCleanup = now;
}

/**
 * Crée une instance de cache associée à un namespace.
 *
 * @param {string} namespace - Préfixe de clé (ex: 'nk', 'pd')
 * @param {string} [tag] - Tag pour les logs (défaut = namespace en majuscule)
 * @returns {Function} withCache(rawKey, fn, opts?) → Promise
 */
export function createCache(namespace, tag) {
    const logTag = tag || namespace.toUpperCase();
    const prefix = `${namespace}_`;

    /**
     * Génère une clé de cache déterministe avec le namespace.
     */
    function cacheKey(raw) {
        return `${prefix}${String(raw).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
    }

    /**
     * Récupère une valeur du cache.
     */
    function cacheGet(key) {
        const entry = cache.get(key);
        if (!entry) return undefined;

        const now = Date.now();
        if (now - entry.ts >= entry.ttl) {
            cache.delete(key);
            return undefined;
        }
        return entry.data;
    }

    /**
     * Définit une valeur dans le cache.
     */
    function cacheSet(key, data, success = true) {
        // Nettoyage périodique
        if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
            cleanCache(logTag);
        }

        // Si le cache est plein, faire de la place (supprimer la plus vieille)
        if (cache.size >= CACHE_MAX_SIZE) {
            const oldest = [...cache.entries()]
                .sort((a, b) => a[1].ts - b[1].ts)[0];
            if (oldest) cache.delete(oldest[0]);
        }

        cache.set(key, {
            data,
            ts: Date.now(),
            ttl: success ? CACHE_SUCCESS_TTL : CACHE_FAILURE_TTL,
            success,
        });
    }

    /**
     * Exécute une fonction avec mise en cache intelligente.
     *
     * @param {string} rawKey - Clé brute descriptive (ex: "imdb_1399", "page_tt0944947")
     * @param {Function} fn - Fonction async à exécuter en cas de cache miss
     * @param {object} [opts]
     * @param {boolean} [opts.bypass] - Ignorer le cache
     * @returns {Promise<*>} Résultat de fn (ou valeur en cache)
     */
    return async function withCache(rawKey, fn, opts = {}) {
        const key = cacheKey(rawKey);

        // Cache hit
        if (!opts.bypass) {
            const cached = cacheGet(key);
            if (cached !== undefined) {
                console.log(`[${logTag}] Cache HIT: ${rawKey.slice(0, 60)}`);
                return cached;
            }
        }

        console.log(`[${logTag}] Cache MISS: ${rawKey.slice(0, 60)}`);

        try {
            const result = await fn();
            const isSuccess = result != null;
            cacheSet(key, result, isSuccess);
            if (!isSuccess) {
                console.log(`[${logTag}] Cache: negative result cached (30s TTL)`);
            }
            return result;
        } catch (error) {
            // En cas d'erreur, on ne cache rien — l'appel pourra être retenté
            console.warn(`[${logTag}] Cache: error, not caching: ${error?.message}`);
            throw error;
        }
    };
}
