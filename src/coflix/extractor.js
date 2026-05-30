import cheerio from 'cheerio-without-node-native'
import { fetchText, fetchJson, BASE_URL } from './http.js'
import { resolveStream } from '../utils/resolvers.js'
import { getTmdbTitles } from '../utils/metadata.js'

const SUGGEST_URL = `${BASE_URL}/ajax/search/suggest?keyword=`
const FILTER_URL = `${BASE_URL}/filter?keyword=`
const EPISODE_LIST_URL = `${BASE_URL}/ajax/episode/list-episode?movieId=`
const PLAYER_URL = `${BASE_URL}/ajax/episode/player?episode_id=`

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[':!.,?()[\]]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function scoreMatch(resultTitle, tmdbTitles) {
  const nr = normalize(resultTitle)
  let best = 0

  for (const t of tmdbTitles) {
    const nt = normalize(t)
    if (!nt || !nr) continue

    const nrWords = nr.split(/\s+/).filter(Boolean)
    const ntWords = new Set(nt.split(/\s+/).filter(Boolean))

    if (nr === nt) return 100

    const matched = nrWords.filter(w => ntWords.has(w)).length
    const unmatched = nrWords.filter(w => !ntWords.has(w))

    const onlySeasonAndLang = unmatched.every(w =>
      /^saisons?$/.test(w) || /^\d+$/.test(w) || /^v[feo]$/.test(w) || w === 'vostfr'
    )

    if (nr.includes(nt) || nt.includes(nr)) {
      const lenDiff = Math.abs(nr.length - nt.length)
      if (lenDiff <= 3) return 95
      if (onlySeasonAndLang) return 85 + (matched / nrWords.length) * 10
      if (lenDiff <= 8) return 70
      return 45
    }

    if (nr.startsWith(nt) || nt.startsWith(nr)) return 80

    if (matched > 1 && ntWords.size > 1) {
      const ratio = matched / Math.max(nrWords.length, ntWords.size)
      if (onlySeasonAndLang && ratio > 0.6) {
        best = Math.max(best, Math.round(ratio * 60) + 10)
      } else if (ratio > 0.75) {
        best = Math.max(best, Math.round(ratio * 50))
      }
    }
  }

  return best
}

function extractEpisodeId(url) {
  const m = url.match(/\/ep-(\d+)/)
  return m ? m[1] : null
}

function extractBaseUrl(url) {
  return url.replace(/\/ep-\d+$/, '')
}

function extractSeasonFromTitle(title) {
  const m = (title || '').match(/saisons?\s*(\d+)/i)
  return m ? parseInt(m[1]) : null
}

function detectVersion(url, name) {
  const lower = (url + ' ' + (name || '')).toLowerCase()
  if (lower.includes('-vf') || lower.includes('(vf)') || lower.includes('[vf]')) return 'VF'
  if (lower.includes('-vostfr') || lower.includes('(vostfr)') || lower.includes('[vostfr]')) return 'VOSTFR'
  if (lower.includes('-vo') || lower.includes('(vo)')) return 'VO'
  return 'VF'
}

function parseSuggestResults(json) {
  if (!json || !json.status || !json.html) return []
  const $ = cheerio.load(json.html)
  const results = []

  $('a.item').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href) return
    const episodeId = extractEpisodeId(href)
    const name = $(el).find('.name').text().trim() || $(el).find('.name').attr('data-jp') || ''
    const metaSpans = $(el).find('.meta .dot')
    const type = metaSpans.eq(0).text().trim()
    const year = metaSpans.eq(1).text().trim()
    const isSeries = type.toLowerCase() === 'series'
    const version = detectVersion(href, name)

    results.push({
      url: href,
      pageUrl: extractBaseUrl(href),
      episodeId,
      name,
      type: isSeries ? 'tv' : 'movie',
      year,
      version,
      seasonNum: isSeries ? extractSeasonFromTitle(name) : null,
    })
  })

  return results
}

function parseFilterResults(html) {
  if (!html) return []
  const $ = cheerio.load(html)
  const results = []

  $('.item').each((_, el) => {
    const posterLink = $(el).find('.ani.poster').first().attr('href') || ''
    const nameLink = $(el).find('.name.d-title').first()
    const name = nameLink.text().trim() || nameLink.attr('data-jp') || ''
    const version = $(el).find('.version').first().text().trim()
    if (!posterLink || !name) return

    const episodeId = extractEpisodeId(posterLink)
    const pageUrl = nameLink.attr('href') || extractBaseUrl(posterLink)
    const meta = $(el).find('.meta') || $(el).closest('.inner').find('.meta')
    const versionBadge = $(el).find('.version').first().text().trim() || 'VF'

    results.push({
      url: posterLink.startsWith('http') ? posterLink : `${BASE_URL}${posterLink}`,
      pageUrl: pageUrl.startsWith('http') ? pageUrl : `${BASE_URL}${pageUrl}`,
      episodeId,
      name: nameLink.text().trim(),
      version: versionBadge,
      seasonNum: extractSeasonFromTitle(name),
    })
  })

  return results
}

function bestResult(results, titles, mediaType, targetSeason) {
  let bestScore = 0
  let best = null

  for (const r of results) {
    if (mediaType === 'movie' && r.type === 'tv') continue
    if (mediaType === 'tv' && r.type === 'movie') continue

    let score = scoreMatch(r.name, titles)
    if (mediaType === 'tv' && targetSeason) {
      const ts = parseInt(targetSeason)
      const rs = r.seasonNum
      if (rs === ts) score += 30
      else if (rs && ts && Math.abs(rs - ts) === 1) score += 10
      else if (rs && ts && rs !== ts) score -= 20
    }

    if (r.version === 'VF') score += 5
    else if (r.version === 'VOSTFR') score -= 2

    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }

  return bestScore >= 50 ? best : null
}

async function searchSuggest(query) {
  const url = `${SUGGEST_URL}${encodeURIComponent(query)}`
  const json = await fetchJson(url, { timeout: 10000 })
  return parseSuggestResults(json)
}

async function searchFilter(query) {
  const url = `${FILTER_URL}${encodeURIComponent(query)}`
  const html = await fetchText(url, { timeout: 15000 })
  return parseFilterResults(html)
}

async function searchAll(titles, mediaType, season) {
  const suggestResults = await Promise.allSettled(
    titles.slice(0, 5).map(title => searchSuggest(title))
  )
  for (const r of suggestResults) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      const match = bestResult(r.value, titles, mediaType, season)
      if (match) return match
    }
  }

  const filterResults = await Promise.allSettled(
    titles.slice(0, 3).map(title => searchFilter(title))
  )
  for (const r of filterResults) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      const match = bestResult(r.value, titles, mediaType, season)
      if (match) return match
    }
  }

  return null
}

function parseEpisodeList(json) {
  if (!json || !json.status || !json.html) return []
  const $ = cheerio.load(json.html)
  const episodes = []

  $('.ep-item').each((_, el) => {
    const id = $(el).attr('data-id')
    const num = parseInt($(el).attr('data-num'))
    const href = $(el).attr('href') || ''
    if (id && num) {
      episodes.push({ id, num, url: href })
    }
  })

  episodes.sort((a, b) => a.num - b.num)
  return episodes
}

function parsePlayerResponse(json) {
  if (!json || !json.status || !json.message) return []

  const servers = Array.isArray(json.message) ? json.message : []
  return servers.map(s => {
    const link = s.server_link && typeof s.server_link === 'object' ? s.server_link.url || '' : s.server_link || ''
    return {
      url: link,
      name: s.server_name || 'Serveur',
      type: s.server_type || 'embed',
      version: s.version || 'VF',
    }
  }).filter(s => s.url)
}

async function getPlayerStreams(episodeId) {
  const url = `${PLAYER_URL}${episodeId}`
  const json = await fetchJson(url, { method: 'POST', timeout: 15000 })
  return parsePlayerResponse(json)
}

async function resolveStreamOrFallback(server) {
  const streamObj = {
    name: `Coflix (${server.version})`,
    title: `[${server.version}] ${server.name || 'Serveur'}`,
    url: server.url,
    quality: 'HD',
    headers: { Referer: `${BASE_URL}/`, Origin: BASE_URL },
  }

  try {
    const resolved = await resolveStream(streamObj)
    if (resolved && resolved.url && resolved.isDirect) {
      return { ...resolved, provider: 'coflix' }
    }
  } catch (e) {}

  return { ...streamObj, type: 'embed', provider: 'coflix' }
}

export async function extractStreams(tmdbId, mediaType, season, episode) {
  const titles = await getTmdbTitles(tmdbId, mediaType, { season })
  if (!titles || titles.length === 0) return []

  const effectiveSeason = titles.effectiveSeason != null ? titles.effectiveSeason : season
  console.log(`[Coflix] Titles: ${titles.join(' | ')}`)

  const match = await searchAll(titles, mediaType, effectiveSeason)
  if (!match) {
    console.log(`[Coflix] No match found for ${tmdbId} (${mediaType})`)
    return []
  }
  console.log(`[Coflix] Matched: ${match.name} -> ${match.url}`)

  if (mediaType === 'movie') {
    return await handleMovie(match)
  }

  return await handleSeries(match, effectiveSeason, episode)
}

async function handleMovie(match) {
  const players = await getPlayerStreams(match.episodeId)
  if (players.length === 0) return []

  const results = await Promise.allSettled(players.map(resolveStreamOrFallback))
  const streams = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.url) {
      streams.push(r.value)
    }
  }

  console.log(`[Coflix] Movie: ${streams.length} streams`)
  return streams
}

async function handleSeries(match, season, episode) {
  const pageUrl = match.pageUrl
  const pageHtml = await fetchText(pageUrl, { timeout: 10000 })
  if (!pageHtml) {
    console.log(`[Coflix] Failed to fetch series page: ${pageUrl}`)
    return []
  }

  const movieIdMatch = pageHtml.match(/var movie\s*=\s*\{[^}]*id\s*:\s*["'](\d+)["']/)
  if (!movieIdMatch) {
    console.log(`[Coflix] No movieId found on page`)
    return []
  }
  const movieId = movieIdMatch[1]
  console.log(`[Coflix] Series movieId: ${movieId}`)

  const epJson = await fetchJson(`${EPISODE_LIST_URL}${movieId}`, { timeout: 10000 })
  const episodes = parseEpisodeList(epJson)
  if (episodes.length === 0) {
    console.log(`[Coflix] No episodes found`)
    return []
  }

  const targetEp = parseInt(episode) || 1
  let ep = episodes.find(e => e.num === targetEp)
  if (!ep) ep = episodes[0]
  console.log(`[Coflix] Episode: S${season}E${ep.num} (id: ${ep.id})`)

  const players = await getPlayerStreams(ep.id)
  if (players.length === 0) return []

  const results = await Promise.allSettled(players.map(resolveStreamOrFallback))
  const streams = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.url) {
      streams.push(r.value)
    }
  }

  console.log(`[Coflix] Series: ${streams.length} streams`)
  return streams
}
