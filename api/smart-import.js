// api/smart-import.js
// Vercel Serverless Function: Keeps GEMINI_API_KEY, TMDB_API_KEY, and OMDB_API_KEY 100% hidden from frontend

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body || {};

  try {
    // 1. AI PARSING ACTION (Using Gemini API if configured on Vercel)
    if (action === "parse") {
      const { rawText, existingTaxonomy } = req.body;
      if (!rawText || !rawText.trim()) {
        return res.status(400).json({ error: "Empty text provided" });
      }

      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        // Tell frontend to use its built-in smart local parser
        return res.status(200).json({ mode: "local_fallback", entries: null });
      }

      const systemPrompt = `You are a structured data extraction engine for a movie/web-series catalog.
Extract ALL movies or web series from the user's unstructured text into a strict JSON array.
Rules:
1. Return ONLY valid JSON (an array of objects). No markdown fences, no extra commentary.
2. Each object must have:
   - "title": string (clean movie/series title)
   - "year": string (4-digit release year if present, else "")
   - "imdbRating": string (ONLY if explicitly mentioned as IMDb rating in text; do NOT guess)
   - "categories": string[] (match against existing categories if possible: ${JSON.stringify(existingTaxonomy?.categories || [])})
   - "types": string[] (e.g. Movie, Web Series, TV Series, Anime Movie, Documentary; match against: ${JSON.stringify(existingTaxonomy?.types || [])})
   - "genres": string[] (e.g. Action, Crime, Thriller, Drama, Sci-Fi; match against: ${JSON.stringify(existingTaxonomy?.custom || [])})
   - "language": string (e.g. Hindi, English, Dual Audio)
   - "ott": string (e.g. Netflix, Prime Video, Disney+ Hotstar)
   - "desc": string (description/overview if present, else "")
   - "poster": string (image URL if explicitly given as poster, else "")
   - "backdrop": string (image URL if explicitly given as backdrop, else "")
   - "youtube": string (YouTube trailer URL if present, else "")
   - "downloadGroups": array of objects, each representing a distinct quality/file block:
       {
         "name": string (quality/resolution or file name, e.g. "1080p HEVC" or "Movie.2022.1080p.mkv"),
         "size": string (file size like "2.5 GB" or "650 MB", else ""),
         "links": [ { "label": string (button name if provided, else "Download"), "url": string } ]
       }
3. CRITICAL LINK GROUPING RULE: If multiple URLs appear under the SAME quality/file heading before the next quality/file heading, put ALL those URLs inside that SAME group's "links" array. If 10 separate quality/file headings exist, create 10 separate groups. Never mix sizes or URLs across groups.
4. Do not invent or guess missing data; leave unknown fields as empty strings or empty arrays.`;

      const geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUSER TEXT:\n${rawText}` }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json"
            }
          })
        }
      );

      if (!geminiResp.ok) {
        return res.status(200).json({ mode: "local_fallback", entries: null });
      }

      const geminiJson = await geminiResp.json();
      const candidateText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      let parsedEntries = [];
      try {
        parsedEntries = JSON.parse(candidateText);
        if (!Array.isArray(parsedEntries)) parsedEntries = [parsedEntries];
      } catch (e) {
        return res.status(200).json({ mode: "local_fallback", entries: null });
      }

      return res.status(200).json({ mode: "ai", entries: parsedEntries });
    }

    // 2. TMDB SEARCH & DISAMBIGUATION ACTION
    if (action === "tmdb_search") {
      const { query, year, contentType } = req.body;
      const tmdbKey = process.env.TMDB_API_KEY;
      if (!tmdbKey) {
        return res.status(200).json({ configured: false, results: [] });
      }
      if (!query || !query.trim()) {
        return res.status(200).json({ configured: true, results: [] });
      }

      const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(query.trim())}&include_adult=false`;
      const tmdbResp = await fetch(url);
      if (!tmdbResp.ok) {
        return res.status(502).json({ error: "TMDB search failed" });
      }
      const data = await tmdbResp.json();
      let items = (data.results || []).filter(r => r.media_type === "movie" || r.media_type === "tv");

      // Score matches by exact title, release year, and content type (movie vs tv)
      const qLower = query.trim().toLowerCase();
      const targetIsTv = /series|tv|show|drama|anime series/i.test(contentType || "");
      const targetIsMovie = /movie|film/i.test(contentType || "");

      const mapped = items.map(item => {
        const isTv = item.media_type === "tv";
        const title = isTv ? (item.name || item.original_name) : (item.title || item.original_title);
        const releaseDate = isTv ? (item.first_air_date || "") : (item.release_date || "");
        const itemYear = releaseDate ? releaseDate.slice(0, 4) : "";

        let score = 0;
        if ((title || "").toLowerCase() === qLower) score += 50;
        else if ((title || "").toLowerCase().includes(qLower)) score += 20;
        if (year && itemYear === String(year).trim()) score += 40;
        if (targetIsTv && isTv) score += 25;
        if (targetIsMovie && !isTv) score += 25;

        return {
          tmdbId: item.id,
          mediaType: item.media_type,
          title: title || "Untitled",
          year: itemYear,
          overview: item.overview || "",
          poster: item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : "",
          backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : "",
          originalLanguage: (item.original_language || "").toUpperCase(),
          score
        };
      });

      mapped.sort((a, b) => b.score - a.score);
      return res.status(200).json({ configured: true, results: mapped.slice(0, 8) });
    }

    // 3. TMDB FULL METADATA DETAILS (+ OPTIONAL OMDB TRUE IMDB RATING)
    if (action === "tmdb_details") {
      const { tmdbId, mediaType } = req.body;
      const tmdbKey = process.env.TMDB_API_KEY;
      if (!tmdbKey || !tmdbId) {
        return res.status(400).json({ error: "Missing TMDB key or ID" });
      }

      const typePath = mediaType === "tv" ? "tv" : "movie";
      const detailUrl = `https://api.themoviedb.org/3/${typePath}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=credits,external_ids,videos`;
      const detailResp = await fetch(detailUrl);
      if (!detailResp.ok) {
        return res.status(502).json({ error: "TMDB details fetch failed" });
      }
      const d = await detailResp.json();

      const title = typePath === "tv" ? (d.name || d.original_name) : (d.title || d.original_title);
      const releaseDate = typePath === "tv" ? (d.first_air_date || "") : (d.release_date || "");
      const year = releaseDate ? releaseDate.slice(0, 4) : "";
      const genres = (d.genres || []).map(g => g.name);
      const imdbId = d.external_ids?.imdb_id || "";
      const runtime = typePath === "tv"
        ? (d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min/ep` : (d.number_of_seasons ? `${d.number_of_seasons} Season(s)` : ""))
        : (d.runtime ? `${d.runtime} min` : "");

      const cast = (d.credits?.cast || []).slice(0, 5).map(c => c.name);
      const directors = typePath === "tv"
        ? (d.created_by || []).map(c => c.name)
        : (d.credits?.crew || []).filter(c => c.job === "Director").map(c => c.name);

      // Official YouTube Trailer if available
      const ytTrailer = (d.videos?.results || []).find(v => v.site === "YouTube" && v.type === "Trailer")
                     || (d.videos?.results || []).find(v => v.site === "YouTube");
      const youtubeUrl = ytTrailer ? `https://www.youtube.com/watch?v=${ytTrailer.key}` : "";

      // Fetch TRUE IMDb rating from OMDb ONLY if OMDB_API_KEY is configured (never use TMDB vote_average as IMDb rating)
      let trueImdbRating = "";
      const omdbKey = process.env.OMDB_API_KEY;
      if (omdbKey && imdbId) {
        try {
          const omdbResp = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbKey)}`);
          if (omdbResp.ok) {
            const omdbData = await omdbResp.json();
            if (omdbData.imdbRating && omdbData.imdbRating !== "N/A") {
              trueImdbRating = omdbData.imdbRating;
            }
          }
        } catch (e) {
          // Ignore OMDb network error; leave trueImdbRating blank
        }
      }

      return res.status(200).json({
        title: title || "",
        year,
        overview: d.overview || "",
        poster: d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : "",
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/original${d.backdrop_path}` : "",
        genres,
        originalLanguage: (d.original_language || "").toUpperCase(),
        runtime,
        imdbId,
        trueImdbRating,
        cast,
        directors,
        youtubeUrl
      });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
