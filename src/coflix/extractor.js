/**
 * Extractor for Coflix (coflix.cymru)
 * WordPress-based site with episode URLs in format /episode/{slug}-{season}x{episode}/
 * Uses iframe embed from lecteurvideo.com for streaming
 */

import { fetchText } from './http.js'
import { resolveStream, sanitizeSearchQuery } from '../utils/resolvers.js'
import { getTmdbTitles } from '../utils/metadata.js'

const BASE_URL = 'https://coflix.cymru'

function toSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[':!.,?()[\]]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function extractIframeUrl(html) {
  if (!html) return null

  // Direct iframe src
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)
  if (iframeMatch) {
    let src = iframeMatch[1]
    if (src.startsWith('//')) src = 'https:' + src
    // Only return external embeds (not YouTube, not self-hosted)
    if (src.includes('lecteurvideo.com') || (src.startsWith('http') && !src.includes('youtube') && !src.includes('googlevideo'))) {
      return src
    }
  }

  // lecteurvideo.com get parameter URL pattern
  const lvMatch = html.match(/https:\/\/lecteurvideo\.com\/\?get=[^"'\s]+/)
  if (lvMatch) return lvMatch[0]

  return null
}

function generateSlugCandidates(title, season) {
  const base = toSlug(title)
  const candidates = []

  // Base slug
  candidates.push(base)

  // Remove leading "the-"
  if (base.startsWith('the-')) candidates.push(base.slice(4))

  // With season suffix
  if (season) {
    candidates.push(`${base}-s${season}`)
    candidates.push(`${base}-saison-${season}`)
    candidates.push(`${base}-season-${season}`)
  }

  // With number suffixes sometimes used
  candidates.push(base.replace(/-+/g, '_'))

  return [...new Set(candidates.filter(Boolean))]
}

async function probeEpisode(slug, season, episode) {
  const patterns = [
    `${slug}-${season}x${episode}`,
    `${slug}-s${season}e${episode}`,
    `${slug}-saison-${season}-episode-${episode}`,
    `${slug}-${season}-${episode}`,
  ]

  for (const pattern of [...new Set(patterns)]) {
    const url = `${BASE_URL}/episode/${pattern}/`
    try {
      const html = await fetchText(url, { timeout: 8000 })
      if (html && html.length > 100) {
        const iframeUrl = extractIframeUrl(html)
        if (iframeUrl) {
          console.log(`[Coflix] Found episode at: ${url}`)
          return { url: iframeUrl, headers: { Referer: `${BASE_URL}/`, Origin: BASE_URL } }
        }
      }
    } catch (e) {
      // 404 or timeout, try next pattern
    }
  }
  return null
}

function toStream(embedUrl) {
  return {
    name: 'Coflix',
    title: '[VF/VOSTFR] Coflix',
    url: embedUrl,
    quality: 'HD',
    headers: {
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }
}

export async function extractStreams(tmdbId, mediaType, season, episode) {
  const titles = await getTmdbTitles(tmdbId, mediaType, { season })
  if (!titles || titles.length === 0) return []

  const effectiveSeason = titles.effectiveSeason != null ? titles.effectiveSeason : season
  const targetSeason = parseInt(effectiveSeason) || 1
  const targetEpisode = parseInt(episode) || 1

  // Try WordPress REST API search first
  for (const title of titles.slice(0, 3)) {
    try {
      const searchQuery = sanitizeSearchQuery(title)
      const apiUrl = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(searchQuery)}&per_page=5`
      const json = await fetchText(apiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000,
      })
      if (json && json.startsWith('[')) {
        try {
          const posts = JSON.parse(json)
          if (Array.isArray(posts) && posts.length > 0) {
            const slug = toSlug(posts[0].title?.rendered || posts[0].slug || '')
            if (slug) {
              const result = await probeEpisode(slug, targetSeason, targetEpisode)
              if (result) {
                const stream = toStream(result.url)
                const resolved = await resolveStream(stream)
                if (resolved && resolved.url) {
                  return [{ ...resolved, provider: 'coflix' }]
                }
                return [{ ...stream, provider: 'coflix', type: 'embed' }]
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn(`[Coflix] REST search failed for "${title}": ${e.message}`)
    }
  }

  // Fallback: slug probing with TMDB titles
  for (const title of titles.slice(0, 3)) {
    const candidates = generateSlugCandidates(title, targetSeason)
    for (const slug of candidates) {
      const result = await probeEpisode(slug, targetSeason, targetEpisode)
      if (result) {
        const stream = toStream(result.url)
        const resolved = await resolveStream(stream)
        if (resolved && resolved.url) {
          return [{ ...resolved, provider: 'coflix' }]
        }
        return [{ ...stream, provider: 'coflix', type: 'embed' }]
      }
    }
  }

  console.log(`[Coflix] No match found for ${tmdbId} (${mediaType})`)
  return []
}
