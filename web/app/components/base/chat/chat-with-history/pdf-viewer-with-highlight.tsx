import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { Highlight, PdfHighlighter, PdfLoader } from 'react-pdf-highlighter'
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'
import Loading from '@/app/components/base/loading'

// CSS override for highlight color (yellow instead of red)
const highlightColorStyle = `
  .Highlight__part { background-color: rgba(255, 226, 143, 0.6) !important; }
  .Highlight--scrolledTo .Highlight__part { background-color: rgba(255, 200, 0, 0.7) !important; }
`

type PdfViewerWithHighlightProps = {
  url: string
  searchText?: string
  pageNumber?: string
  chunkId?: string
  onFullTextExtracted?: (fullText: string) => void
}

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// ============ Token-based matching types and functions ============
interface PDFToken {
  text: string
  raw: string  // original text, no changes
  lowercase: string  // lowercase with punctuation
  normalized: string  // lowercase without punctuation
  x: number
  y: number
  width: number
  height: number
  itemIndex: number
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\w]/g, '').trim()
}

interface ChunkToken {
  raw: string  // original text, no changes
  lowercase: string  // lowercase with punctuation
  normalized: string  // lowercase without punctuation
}

function tokenizeChunk(text: string): ChunkToken[] {
  return text.split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => ({
      raw: w.trim(),
      lowercase: w.toLowerCase().trim(),
      normalized: normalizeToken(w),
    }))
    .filter(t => t.raw.length > 0)  // Keep all tokens that have raw content
}

function tokenizePDF(items: any[]): PDFToken[] {
  const tokens: PDFToken[] = []
  items.forEach((item, idx) => {
    if (!item.str) return
    const words = item.str.split(/\s+/).filter((w: string) => w.length > 0)
    const charWidth = item.str.length > 0 ? item.width / item.str.length : 0
    let currentX = item.transform[4]

    words.forEach((word: string) => {
      const normalized = normalizeToken(word)
      if (normalized.length === 0) return
      tokens.push({
        text: word,
        raw: word.trim(),
        lowercase: word.toLowerCase().trim(),
        normalized,
        x: currentX,
        y: item.transform[5],
        width: word.length * charWidth,
        height: item.height || Math.abs(item.transform[3]),
        itemIndex: idx,
      })
      currentX += (word.length + 1) * charWidth
    })
  })
  return tokens
}

function tokensMatch(a: string, b: string, similarityFn: (s1: string, s2: string) => number): boolean {
  if (a === b) return true
  if (a.length >= 3 && b.length >= 3) {
    if (a.includes(b) || b.includes(a)) return true
    if (a.length >= 4 && b.length >= 4) {
      return similarityFn(a, b) >= 0.8
    }
  }
  return false
}

// Proximity matching for short blocks (titles/headings) - finds tokens on same line regardless of order
function findProximityMatches(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  if (chunkTokens.length === 0 || pdfTokens.length === 0) return []

  // Find first token to get anchor Y position
  let anchorY = -1
  let anchorIdx = -1
  for (let i = 0; i < pdfTokens.length; i++) {
    if (tokensMatch(chunkTokens[0], pdfTokens[i].normalized, similarityFn)) {
      anchorY = pdfTokens[i].y
      anchorIdx = i
      break
    }
  }

  if (anchorIdx === -1) return []

  // Find all matching tokens within Y-range of anchor (same line ± tolerance)
  const yTolerance = 20
  const matched: number[] = []
  const usedChunkTokens = new Set<number>()

  for (let i = 0; i < pdfTokens.length; i++) {
    if (Math.abs(pdfTokens[i].y - anchorY) > yTolerance) continue

    // Find best matching chunk token
    for (let j = 0; j < chunkTokens.length; j++) {
      if (usedChunkTokens.has(j)) continue
      if (tokensMatch(chunkTokens[j], pdfTokens[i].normalized, similarityFn)) {
        matched.push(i)
        usedChunkTokens.add(j)
        break
      }
    }
  }

  return matched
}

// Helper: Count gaps in matched token indices
function countGaps(indices: number[]): number {
  if (indices.length <= 1) return 0
  let gaps = 0
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1)
      gaps++
  }
  return gaps
}

// Helper: Find continuous spans in matched indices
function findContinuousSpans(indices: number[]): number[][] {
  if (indices.length === 0) return []
  const spans: number[][] = []
  let currentSpan: number[] = [indices[0]]

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) {
      currentSpan.push(indices[i])
    }
    else {
      spans.push(currentSpan)
      currentSpan = [indices[i]]
    }
  }
  spans.push(currentSpan)
  return spans
}

// Helper: Calculate match quality score
function calculateMatchScore(matchedIndices: number[], totalTokens: number): number {
  if (matchedIndices.length === 0) return 0

  // Base score: match percentage
  const baseScore = (matchedIndices.length / totalTokens) * 100

  // Penalty for gaps (discontinuity)
  const gaps = countGaps(matchedIndices)
  const gapPenalty = gaps * 5

  // Bonus for continuous spans
  const spans = findContinuousSpans(matchedIndices)
  let continuousBonus = 0
  const longestSpan = Math.max(...spans.map(s => s.length))

  for (const span of spans) {
    if (span.length >= 10) continuousBonus += 10
    if (span.length >= 20) continuousBonus += 10
  }

  // Extra bonus if longest span is >50% of total
  if (longestSpan >= totalTokens * 0.5) continuousBonus += 20

  return baseScore - gapPenalty + continuousBonus
}

// Core matching logic - tries to match tokens from a given field
type TokenField = 'raw' | 'lowercase' | 'normalized'

function doSequentialMatch(
  chunkTokenValues: string[],
  pdfTokens: PDFToken[],
  pdfField: TokenField,
  similarityFn: (s1: string, s2: string) => number,
): { indices: number[]; score: number } {
  const startCandidates: number[] = []
  for (let i = 0; i < pdfTokens.length; i++) {
    if (tokensMatch(chunkTokenValues[0], pdfTokens[i][pdfField], similarityFn))
      startCandidates.push(i)
  }

  if (startCandidates.length === 0) return { indices: [], score: 0 }

  let bestMatch = { indices: [] as number[], score: 0 }

  for (const startIdx of startCandidates) {
    const matched: number[] = []
    let pdfIdx = startIdx
    let chunkIdx = 0
    let pdfGaps = 0
    let chunkSkips = 0
    const maxPdfGap = 20
    const maxChunkSkip = 20

    while (chunkIdx < chunkTokenValues.length && pdfIdx < pdfTokens.length) {
      if (tokensMatch(chunkTokenValues[chunkIdx], pdfTokens[pdfIdx][pdfField], similarityFn)) {
        matched.push(pdfIdx)
        pdfIdx++
        chunkIdx++
        pdfGaps = 0
        chunkSkips = 0
      }
      else {
        pdfGaps++
        if (pdfGaps <= maxPdfGap) {
          pdfIdx++
        }
        else {
          pdfGaps = 0
          chunkSkips++
          if (chunkSkips > maxChunkSkip) break
          chunkIdx++
        }
      }
    }

    const score = calculateMatchScore(matched, chunkTokenValues.length)
    if (score > bestMatch.score) {
      bestMatch = { indices: matched, score }
    }
  }

  return bestMatch
}

function findSequentialMatches(
  chunkTokens: ChunkToken[],
  pdfTokens: PDFToken[],
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  if (chunkTokens.length === 0 || pdfTokens.length === 0) return []

  // For short blocks (titles), use proximity matching instead of sequential
  if (chunkTokens.length <= 15) {
    const proximityResult = findProximityMatches(chunkTokens.map(t => t.normalized), pdfTokens, similarityFn)
    if (proximityResult.length >= chunkTokens.length * 0.6) {
      console.log(`[PDF]       Using proximity matching (short block): ${proximityResult.length}/${chunkTokens.length} tokens`)
      return proximityResult
    }
  }

  const threshold = 0.4  // 40% match rate to accept

  // PASS 1: Try matching with RAW tokens (original case, with punctuation)
  const rawValues = chunkTokens.map(t => t.raw)
  const rawResult = doSequentialMatch(rawValues, pdfTokens, 'raw', similarityFn)
  const rawRate = rawResult.indices.length / chunkTokens.length
  console.log(`[PDF]       Pass 1 (raw): ${rawResult.indices.length}/${chunkTokens.length} tokens (${(rawRate * 100).toFixed(0)}%), score ${rawResult.score.toFixed(1)}`)

  if (rawRate >= threshold) {
    const gaps = countGaps(rawResult.indices)
    const spans = findContinuousSpans(rawResult.indices)
    const longestSpan = spans.length > 0 ? Math.max(...spans.map(s => s.length)) : 0
    console.log(`[PDF]       ✓ Using raw: ${gaps} gaps, longest span ${longestSpan}`)
    return rawResult.indices
  }

  // PASS 2: Try matching with LOWERCASE tokens (lowercase, with punctuation)
  const lowercaseValues = chunkTokens.map(t => t.lowercase)
  const lowercaseResult = doSequentialMatch(lowercaseValues, pdfTokens, 'lowercase', similarityFn)
  const lowercaseRate = lowercaseResult.indices.length / chunkTokens.length
  console.log(`[PDF]       Pass 2 (lowercase): ${lowercaseResult.indices.length}/${chunkTokens.length} tokens (${(lowercaseRate * 100).toFixed(0)}%), score ${lowercaseResult.score.toFixed(1)}`)

  if (lowercaseRate >= threshold) {
    const gaps = countGaps(lowercaseResult.indices)
    const spans = findContinuousSpans(lowercaseResult.indices)
    const longestSpan = spans.length > 0 ? Math.max(...spans.map(s => s.length)) : 0
    console.log(`[PDF]       ✓ Using lowercase: ${gaps} gaps, longest span ${longestSpan}`)
    return lowercaseResult.indices
  }

  // PASS 3: Try matching with NORMALIZED tokens (lowercase, no punctuation)
  const normalizedValues = chunkTokens.map(t => t.normalized)
  const normalizedResult = doSequentialMatch(normalizedValues, pdfTokens, 'normalized', similarityFn)
  const normalizedRate = normalizedResult.indices.length / chunkTokens.length
  console.log(`[PDF]       Pass 3 (normalized): ${normalizedResult.indices.length}/${chunkTokens.length} tokens (${(normalizedRate * 100).toFixed(0)}%), score ${normalizedResult.score.toFixed(1)}`)

  // Pick the best result from all 3 passes
  const results = [
    { name: 'raw', result: rawResult },
    { name: 'lowercase', result: lowercaseResult },
    { name: 'normalized', result: normalizedResult },
  ]
  const best = results.reduce((a, b) => a.result.score > b.result.score ? a : b)

  if (best.result.indices.length > 0) {
    const gaps = countGaps(best.result.indices)
    const spans = findContinuousSpans(best.result.indices)
    const longestSpan = spans.length > 0 ? Math.max(...spans.map(s => s.length)) : 0
    console.log(`[PDF]       ✓ Best: ${best.name} with ${gaps} gaps, longest span ${longestSpan}`)
  }

  return best.result.indices
}

function generateMatchedRects(
  matchedIndices: number[],
  pdfTokens: PDFToken[],
  pageNumber: number,
): Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> {
  const rects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []

  for (const idx of matchedIndices) {
    const token = pdfTokens[idx]
    const yOffset = token.height * 0.15
    rects.push({
      x1: token.x,
      y1: token.y - yOffset,
      x2: token.x + token.width,
      y2: token.y + token.height - yOffset,
      width: token.width,
      height: token.height,
      pageNumber,
    })
  }

  if (rects.length === 0) return []

  const sorted = [...rects].sort((a, b) => {
    const yDiff = a.y1 - b.y1
    if (Math.abs(yDiff) < 5) return a.x1 - b.x1
    return yDiff
  })

  const lines: Array<typeof rects> = []
  let currentLine: typeof rects = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const sameLine = Math.abs(sorted[i].y1 - currentLine[0].y1) < 5
    if (sameLine) {
      currentLine.push(sorted[i])
    }
    else {
      lines.push(currentLine)
      currentLine = [sorted[i]]
    }
  }
  lines.push(currentLine)

  const merged: typeof rects = []
  for (const line of lines) {
    const minX = Math.min(...line.map(r => r.x1))
    const maxX = Math.max(...line.map(r => r.x2))
    const avgY1 = line.reduce((sum, r) => sum + r.y1, 0) / line.length
    const avgY2 = line.reduce((sum, r) => sum + r.y2, 0) / line.length
    const avgHeight = line.reduce((sum, r) => sum + r.height, 0) / line.length

    merged.push({
      x1: minX,
      y1: avgY1,
      x2: maxX,
      y2: avgY2,
      width: maxX - minX,
      height: avgHeight,
      pageNumber,
    })
    console.log(`[PDF]     Line: ${line.length} tokens merged → rect from x:${minX.toFixed(1)} to x:${maxX.toFixed(1)} (width: ${(maxX - minX).toFixed(1)})`)
  }

  return merged
}

const PdfViewerWithHighlight: FC<PdfViewerWithHighlightProps> = ({
  url,
  chunkId,
  onFullTextExtracted,
}) => {
  const [pdfLoaded, setPdfLoaded] = useState(false)
  const [apiLoaded, setApiLoaded] = useState(false)
  const [fullChunkContext, setFullChunkContext] = useState<string | null>(null)
  const hasFetchedRef = useRef<string | null>(null)
  const onFullTextExtractedRef = useRef(onFullTextExtracted)
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep callback ref updated
  useEffect(() => {
    onFullTextExtractedRef.current = onFullTextExtracted
  }, [onFullTextExtracted])

  // Reset PDF loaded state when URL changes
  useEffect(() => {
    setPdfLoaded(false)
  }, [url])

  // Check if everything is ready
  const isReady = pdfLoaded && (apiLoaded || !chunkId)

  // Fetch full content from API - only once per chunkId
  useEffect(() => {
    if (!chunkId) {
      setApiLoaded(true)
      return
    }

    // Skip if already fetched for this chunkId
    if (hasFetchedRef.current === chunkId) return
    hasFetchedRef.current = chunkId

    setApiLoaded(false)
    const fetchChunkContext = async () => {
      console.log(`[PDF] Fetching chunk ${chunkId}...`)
      try {
        const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
        const text = await response.text()
        console.log(`[PDF] Response: ${text.substring(0, 200)}`)

        if (text) {
          const data = JSON.parse(text)
          if (data.chunk_context) {
            setFullChunkContext(data.chunk_context)
            console.log(`[PDF] Got context: ${data.chunk_context.length} chars`)
            if (onFullTextExtractedRef.current)
              onFullTextExtractedRef.current(data.chunk_context)
          }
        }
      }
      catch (error: any) {
        console.log(`[PDF] Error: ${error.message}`)
      }
      finally {
        setApiLoaded(true)
      }
    }

    fetchChunkContext()
  }, [chunkId])

  // Handle PDF document ready - delayed to ensure viewer is initialized
  const handlePdfReady = useCallback(() => {
    setTimeout(() => {
      console.log('[PDF] PDF viewer ready')
      setPdfLoaded(true)
    }, 500)
  }, [])

  return (
    <div
      ref={containerRef}
      className='relative h-full w-full overflow-hidden'
      style={{ contain: 'layout' }}
    >
      {/* Loading overlay */}
      {!isReady && (
        <div className='absolute inset-0 z-50 flex flex-col items-center justify-center bg-white'>
          <Loading type='app' />
          <div className='mt-4 text-sm text-gray-500'>
            {!pdfLoaded && !apiLoaded && 'Loading PDF and source text...'}
            {!pdfLoaded && apiLoaded && 'Loading PDF...'}
            {pdfLoaded && !apiLoaded && 'Loading source text...'}
          </div>
        </div>
      )}

      {/* PDF Viewer */}
      <div
        className='h-full w-full overflow-x-hidden overflow-y-auto'
      >
        <PdfLoader
          key={url}
          workerSrc='/pdf.worker.min.mjs'
          url={url}
          beforeLoad={<div />}
        >
          {pdfDocument => (
            <PdfHighlighterStable
              pdfDocument={pdfDocument}
              onReady={handlePdfReady}
              containerWidth={containerRef.current?.clientWidth || 600}
              chunkContext={fullChunkContext}
              isFullyReady={isReady}
            />
          )}
        </PdfLoader>
      </div>
    </div>
  )
}

// PDF renderer component
type PdfHighlighterStableProps = {
  pdfDocument: any
  onReady: () => void
  containerWidth: number
  chunkContext: string | null
  isFullyReady: boolean
}

const PdfHighlighterStable: FC<PdfHighlighterStableProps> = ({ pdfDocument, onReady, containerWidth, chunkContext, isFullyReady }) => {
  const hasCalledReady = useRef(false)
  const hasRendered = useRef(false)
  const hasHighlightedRef = useRef(false)
  const [scale, setScale] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<IHighlight[]>([])

  console.log('[PDF] PdfHighlighterStable render, hasRendered:', hasRendered.current)

  // Reset highlights when chunkContext changes (new citation clicked)
  useEffect(() => {
    console.log('[PDF] ChunkContext changed, resetting highlights')
    hasHighlightedRef.current = false
    setHighlights([])
  }, [chunkContext])

  // Similarity scoring function (bigram)
  const calculateSimilarity = useCallback((str1: string, str2: string): number => {
    if (str1 === str2) return 1
    if (str1.length === 0 || str2.length === 0) return 0

    const bigrams1 = new Set<string>()
    const bigrams2 = new Set<string>()

    for (let i = 0; i < str1.length - 1; i++)
      bigrams1.add(str1.substring(i, i + 2))

    for (let i = 0; i < str2.length - 1; i++)
      bigrams2.add(str2.substring(i, i + 2))

    let intersection = 0
    bigrams1.forEach((bigram) => {
      if (bigrams2.has(bigram)) intersection++
    })

    return (2 * intersection) / (bigrams1.size + bigrams2.size)
  }, [])

  // Calculate fixed scale once on mount to prevent feedback loop
  useEffect(() => {
    if (!pdfDocument) return

    const calculateScale = async () => {
      try {
        const page = await pdfDocument.getPage(1)
        const viewport = page.getViewport({ scale: 1.0 })
        // Calculate scale to fit width, with margin for scrollbar + padding
        const calculatedScale = (containerWidth - 40) / viewport.width
        // Round DOWN to 2 decimal places to prevent overflow
        const roundedScale = Math.floor(calculatedScale * 100) / 100
        setScale(roundedScale.toString())
        console.log(`[PDF] Fixed scale: ${roundedScale} (container: ${containerWidth}px, page: ${viewport.width}px)`)
      }
      catch (e) {
        console.log('[PDF] Scale calculation failed, using default')
        setScale('1.0')
      }
    }

    calculateScale()
  }, [pdfDocument, containerWidth])

  useEffect(() => {
    if (!hasCalledReady.current && scale !== null) {
      hasCalledReady.current = true
      onReady()
    }
  }, [onReady, scale])

  // Find and create highlights when everything is ready
  useEffect(() => {
    if (!isFullyReady || !chunkContext || !pdfDocument || hasHighlightedRef.current) return
    hasHighlightedRef.current = true

    const findHighlights = async () => {
      console.log('[PDF] 🚀 Starting token-based block matching...')
      console.log('[PDF] Source text from n8n API:', chunkContext.substring(0, 200))

      try {
        const pageNum = 1 // Start with page 1
        const page = await pdfDocument.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.0 })
        const textContent = await page.getTextContent()
        const items = textContent.items as any[]

        console.log(`[PDF] 📄 Page ${pageNum}: ${items.length} text items`)

        // Tokenize PDF once (reused for all blocks)
        const pdfTokens = tokenizePDF(items)
        console.log(`[PDF] 📄 PDF has ${pdfTokens.length} tokens`)

        // Split by newlines to get individual blocks/areas
        const allBlocks = chunkContext
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 10)

        // Remove duplicate blocks
        const uniqueBlocks = [...new Set(allBlocks)]
        console.log(`[PDF] 📝 ${allBlocks.length} blocks → ${uniqueBlocks.length} unique blocks`)

        // Match each block independently and accumulate ALL rects
        const allMatchedRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []
        let totalMatched = 0
        let totalTokens = 0

        for (let i = 0; i < uniqueBlocks.length; i++) {
          const block = uniqueBlocks[i]
          const blockTokens = tokenizeChunk(block)
          totalTokens += blockTokens.length

          if (blockTokens.length < 1) continue

          // Debug: Show what we're searching for
          if (i === 0) {
            console.log(`[PDF]   Block 1 has ${blockTokens.length} tokens:`)
            console.log(`[PDF]     raw:`, blockTokens.map(t => t.raw))
            console.log(`[PDF]     lowercase:`, blockTokens.map(t => t.lowercase))
            console.log(`[PDF]     normalized:`, blockTokens.map(t => t.normalized))
            console.log(`[PDF]   PDF has ${pdfTokens.length} tokens, first 50 (raw):`, pdfTokens.slice(0, 50).map(t => t.raw))
          }

          // Find matches for this block using token-based sequential matching
          const matchedIndices = findSequentialMatches(blockTokens, pdfTokens, calculateSimilarity)

          if (matchedIndices.length > 0) {
            totalMatched += matchedIndices.length
            const blockRects = generateMatchedRects(matchedIndices, pdfTokens, pageNum)
            console.log(`[PDF]   ✓ Block ${i + 1}: ${matchedIndices.length}/${blockTokens.length} tokens → ${blockRects.length} rects (${block.substring(0, 30)}...)`)
            allMatchedRects.push(...blockRects)
          }
          else {
            console.log(`[PDF]   ✗ Block ${i + 1}: no matches (${block.substring(0, 30)}...)`)
          }
        }

        if (allMatchedRects.length === 0) {
          console.log('[PDF] ⚠️ No matches found in any block')
          return
        }

        console.log(`[PDF] ✅ Total: ${totalMatched}/${totalTokens} tokens (${(totalMatched / totalTokens * 100).toFixed(0)}%)`)

        // Create ONE highlight from ALL matched rects
        const boundingRect = {
          x1: Math.min(...allMatchedRects.map(r => r.x1)),
          y1: Math.min(...allMatchedRects.map(r => r.y1)),
          x2: Math.max(...allMatchedRects.map(r => r.x2)),
          y2: Math.max(...allMatchedRects.map(r => r.y2)),
          width: viewport.width,
          height: viewport.height,
          pageNumber: pageNum,
        }

        const newHighlight: IHighlight = {
          id: `highlight-${Date.now()}`,
          position: {
            boundingRect,
            rects: allMatchedRects,
            pageNumber: pageNum,
            usePdfCoordinates: true,
          } as ScaledPosition,
          content: { text: chunkContext },
          comment: { text: '', emoji: '' },
        }

        setHighlights([newHighlight])
        console.log(`[PDF] 🎉 Created highlight with ${allMatchedRects.length} rects from ${uniqueBlocks.length} blocks`)
      }
      catch (error: any) {
        console.error('[PDF] ❌ Highlight error:', error)
      }
    }

    findHighlights()
  }, [isFullyReady, chunkContext, pdfDocument, calculateSimilarity])

  // Memoize callbacks to prevent PdfHighlighter re-renders
  const enableAreaSelection = useCallback(() => false, [])
  const scrollRef = useCallback(() => {}, [])
  const onScrollChange = useCallback(() => {}, [])
  const onSelectionFinished = useCallback(() => null, [])

  // Render highlights using built-in Highlight component
  const highlightTransform = useCallback(
    (highlight: any, _index: number, _setTip: any, _hideTip: any, _viewportToScaled: any, _screenshot: any, isScrolledTo: boolean) => {
      console.log('[PDF] Rendering highlight:', highlight.id, 'isScrolledTo:', isScrolledTo)
      return (
        <Highlight
          key={highlight.id}
          isScrolledTo={isScrolledTo}
          position={highlight.position}
          comment={highlight.comment}
        />
      )
    },
    []
  )

  // Don't render PDF until scale is calculated - prevents initial render at wrong scale
  if (scale === null) {
    return <div className="h-full w-full" />
  }

  if (!hasRendered.current) {
    hasRendered.current = true
    console.log('[PDF] First render of PdfHighlighter with scale:', scale)
  }

  // Direct rendering without useMemo - allows highlights to update via normal React re-renders
  return (
    <>
      {/* Inject CSS for yellow highlights */}
      <style dangerouslySetInnerHTML={{ __html: highlightColorStyle }} />
      <PdfHighlighter
        pdfDocument={pdfDocument}
        enableAreaSelection={enableAreaSelection}
        scrollRef={scrollRef}
        onScrollChange={onScrollChange}
        pdfScaleValue={scale}
        onSelectionFinished={onSelectionFinished}
        highlightTransform={highlightTransform}
        highlights={highlights}
      />
    </>
  )
}

export default PdfViewerWithHighlight
