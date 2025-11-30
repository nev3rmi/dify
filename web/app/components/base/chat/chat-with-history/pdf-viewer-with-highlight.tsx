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
      const raw = word.trim()
      if (raw.length === 0) return  // Filter by raw, not normalized
      tokens.push({
        text: word,
        raw,
        lowercase: word.toLowerCase().trim(),
        normalized: normalizeToken(word),  // Keep even if empty
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

// Try to match a chunk token against one or more consecutive PDF tokens (handles split words)
function tryMatchWithMerge(
  chunkToken: string,
  pdfTokens: PDFToken[],
  startIdx: number,
  field: TokenField,
  similarityFn: (s1: string, s2: string) => number,
): { matched: boolean; consumedCount: number } {
  // Try single token match first
  if (startIdx < pdfTokens.length && tokensMatch(chunkToken, pdfTokens[startIdx][field], similarityFn)) {
    return { matched: true, consumedCount: 1 }
  }

  // Try merging 2-3 consecutive PDF tokens
  for (let mergeCount = 2; mergeCount <= 3 && startIdx + mergeCount <= pdfTokens.length; mergeCount++) {
    const merged = pdfTokens.slice(startIdx, startIdx + mergeCount).map(t => t[field]).join('')
    if (tokensMatch(chunkToken, merged, similarityFn)) {
      return { matched: true, consumedCount: mergeCount }
    }
  }

  return { matched: false, consumedCount: 0 }
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
    // Also check if merging first few tokens matches
    const result = tryMatchWithMerge(chunkTokenValues[0], pdfTokens, i, pdfField, similarityFn)
    if (result.matched) startCandidates.push(i)
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
      // Try to match with potential merge of split words
      const result = tryMatchWithMerge(chunkTokenValues[chunkIdx], pdfTokens, pdfIdx, pdfField, similarityFn)

      if (result.matched) {
        // Add all consumed PDF token indices
        for (let k = 0; k < result.consumedCount; k++) {
          matched.push(pdfIdx + k)
        }
        pdfIdx += result.consumedCount
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

  // Try all 3 passes and pick the best
  const passes = [
    { name: 'raw', values: chunkTokens.map(t => t.raw), field: 'raw' as TokenField },
    { name: 'lowercase', values: chunkTokens.map(t => t.lowercase), field: 'lowercase' as TokenField },
    { name: 'normalized', values: chunkTokens.map(t => t.normalized), field: 'normalized' as TokenField },
  ]

  let best = { name: '', result: { indices: [] as number[], score: 0 } }

  for (const pass of passes) {
    const result = doSequentialMatch(pass.values, pdfTokens, pass.field, similarityFn)
    const rate = result.indices.length / chunkTokens.length

    if (rate >= threshold) {
      // Good enough match, use it
      console.log(`[PDF]       ✓ ${pass.name}: ${result.indices.length}/${chunkTokens.length} (${(rate * 100).toFixed(0)}%)`)
      return result.indices
    }

    if (result.score > best.result.score) {
      best = { name: pass.name, result }
    }
  }

  // No pass reached threshold, use best
  const rate = best.result.indices.length / chunkTokens.length
  console.log(`[PDF]       Best: ${best.name} ${best.result.indices.length}/${chunkTokens.length} (${(rate * 100).toFixed(0)}%)`)
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
  const [apiPageNumber, setApiPageNumber] = useState<number | null>(null)
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
    setFullChunkContext(null)
    setApiPageNumber(null)
    const fetchChunkContext = async () => {
      console.log(`[PDF] Fetching chunk ${chunkId}...`)
      try {
        const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
        const text = await response.text()
        console.log(`[PDF] Response: ${text.substring(0, 200)}`)

        if (text) {
          const data = JSON.parse(text)
          console.log(`[PDF] API data:`, data)

          if (data.chunk_context) {
            // Handle double-encoded JSON string
            let chunkText = data.chunk_context
            if (typeof chunkText === 'string' && chunkText.startsWith('"') && chunkText.endsWith('"')) {
              chunkText = JSON.parse(chunkText) // Parse the inner JSON string
            }
            setFullChunkContext(chunkText)
            console.log(`[PDF] Got context: ${chunkText.length} chars`)
            if (onFullTextExtractedRef.current)
              onFullTextExtractedRef.current(chunkText)
          }
          if (data.page_numbers && data.page_numbers.length > 0) {
            setApiPageNumber(data.page_numbers[0])
            console.log(`[PDF] API page number: ${data.page_numbers[0]}`)
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
              apiPageNumber={apiPageNumber}
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
  apiPageNumber: number | null
}

const PdfHighlighterStable: FC<PdfHighlighterStableProps> = ({ pdfDocument, onReady, containerWidth, chunkContext, isFullyReady, apiPageNumber }) => {
  const hasCalledReady = useRef(false)
  const hasRendered = useRef(false)
  const hasHighlightedRef = useRef(false)
  const hasExtractedPageRef = useRef<number | null>(null)
  const scrollToRef = useRef<((highlight: IHighlight) => void) | null>(null)
  const [scale, setScale] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [viewerReady, setViewerReady] = useState(false)

  // Page text map with line boxes
  interface LineGroup {
    y: number
    text: string
    box: { x1: number; y1: number; x2: number; y2: number }
  }

  const [pageTextMap, setPageTextMap] = useState<{
    items: Array<{
      text: string
      x: number
      y: number
      width: number
      height: number
    }>
    lines: LineGroup[]
    fullText: string
  } | null>(null)

  console.log('[PDF] PdfHighlighterStable render:', {
    hasRendered: hasRendered.current,
    scale,
    highlightsCount: highlights.length,
    hasPageTextMap: !!pageTextMap,
  })

  // Reset highlights when chunkContext changes (new citation clicked)
  useEffect(() => {
    console.log('[PDF] ChunkContext changed, resetting highlights')
    hasHighlightedRef.current = false
    hasExtractedPageRef.current = null
    setViewerReady(false)
    setHighlights([])
    setPageTextMap(null)
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
  const hasCalculatedScaleRef = useRef(false)
  useEffect(() => {
    if (!pdfDocument || hasCalculatedScaleRef.current) return

    const calculateScale = async () => {
      try {
        const page = await pdfDocument.getPage(1)
        const viewport = page.getViewport({ scale: 1.0 })
        // Calculate scale to fit width, with margin for scrollbar + padding
        const calculatedScale = (containerWidth - 40) / viewport.width
        // Round DOWN to 2 decimal places to prevent overflow
        const roundedScale = Math.floor(calculatedScale * 100) / 100
        setScale(roundedScale.toString())
        hasCalculatedScaleRef.current = true
        console.log(`[PDF] ✅ Scale calculated ONCE: ${roundedScale} (container: ${containerWidth}px, page: ${viewport.width}px)`)
      }
      catch (e) {
        console.log('[PDF] Scale calculation failed, using default')
        setScale('1.0')
        hasCalculatedScaleRef.current = true
      }
    }

    calculateScale()
  }, [pdfDocument, containerWidth])

  // Reset scale calculation when chunk changes
  useEffect(() => {
    hasCalculatedScaleRef.current = false
  }, [chunkContext])

  useEffect(() => {
    if (!hasCalledReady.current && scale !== null) {
      hasCalledReady.current = true
      onReady()
    }
  }, [onReady, scale])

  // Normalization helpers for sentence matching
  const normalizeWithSpaces = useCallback((text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim(), [])
  const normalizeNoSpaces = useCallback((text: string) => text.toLowerCase().replace(/\s+/g, '').trim(), [])

  // Build full text map with position tracking
  interface TextPosition {
    text: string
    transform: number[]
    width: number
    height: number
    startIndexWithSpaces: number
    startIndexNoSpaces: number
  }

  const buildFullTextMap = useCallback((items: any[]) => {
    let fullTextWithSpaces = ''
    let fullTextNoSpaces = ''
    const textPositions: TextPosition[] = []

    items.forEach((item: any) => {
      if (!item.str) return

      textPositions.push({
        text: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height || Math.abs(item.transform[3]),
        startIndexWithSpaces: fullTextWithSpaces.length,
        startIndexNoSpaces: fullTextNoSpaces.length,
      })

      fullTextWithSpaces += item.str + ' '
      fullTextNoSpaces += item.str.toLowerCase().replace(/\s+/g, '')
    })

    return {
      fullTextWithSpaces: normalizeWithSpaces(fullTextWithSpaces),
      fullTextNoSpaces,
      textPositions,
    }
  }, [normalizeWithSpaces])

  // Create rect from text position
  const createRectFromPosition = useCallback((pos: TextPosition, pageNumber: number) => {
    const [, , , scaleY, x, y] = pos.transform
    const height = pos.height
    const yOffset = height * 0.15

    return {
      x1: x,
      y1: y - yOffset,
      x2: x + pos.width,
      y2: y + height - yOffset,
      width: pos.width,
      height,
      pageNumber,
    }
  }, [])

  // Find and create highlights when everything is ready
  useEffect(() => {
    console.log('[PDF] Highlight check:', {
      isFullyReady,
      hasChunkContext: !!chunkContext,
      hasPdfDoc: !!pdfDocument,
      hasPageTextMap: !!pageTextMap,
      hasRendered: hasRendered.current,
      viewerReady,
      hasHighlighted: hasHighlightedRef.current,
    })

    // Don't wait for viewerReady - set highlights early so they're ready when textlayerrendered fires
    if (!isFullyReady || !chunkContext || !pdfDocument || !pageTextMap || !hasRendered.current || hasHighlightedRef.current) return

    console.log('[PDF] ✅ All dependencies ready, starting highlighting...')
    hasHighlightedRef.current = true

    const findHighlights = async () => {
      console.log('[PDF] 🚀 Starting simple fuzzy matching...')
      console.log('[PDF] Chunk context:', chunkContext.substring(0, 200))

      try {
        const pageNum = apiPageNumber || 1

        // Split chunk into blocks
        const chunkBlocks = chunkContext
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 10)

        console.log(`[PDF] 📝 ${chunkBlocks.length} chunk blocks to match`)

        const allMatchedRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []

        // Match each chunk block against PDF lines using fuzzy matching
        for (let i = 0; i < chunkBlocks.length; i++) {
          const block = chunkBlocks[i]
          const blockNormalized = normalizeWithSpaces(block)

          console.log(`[PDF]   Block ${i + 1}: "${block.substring(0, 60)}..."`)

          let matchedLines: typeof pageTextMap.lines = []

          // Try finding matching lines using similarity
          for (const line of pageTextMap.lines) {
            const lineNormalized = normalizeWithSpaces(line.text)

            // Check 1: Exact substring
            if (blockNormalized.includes(lineNormalized) && lineNormalized.length >= 10) {
              matchedLines.push(line)
              continue
            }

            // Check 2: Line is substring of block
            if (lineNormalized.includes(blockNormalized) && blockNormalized.length >= 10) {
              matchedLines.push(line)
              continue
            }

            // Check 3: High similarity (using our bigram function)
            if (lineNormalized.length >= 20 && blockNormalized.length >= 20) {
              const similarity = calculateSimilarity(lineNormalized, blockNormalized)
              if (similarity >= 0.7) {
                matchedLines.push(line)
                continue
              }
            }

            // Check 4: Many shared words
            const blockWords = blockNormalized.split(' ').filter(w => w.length >= 5)
            const lineWords = lineNormalized.split(' ').filter(w => w.length >= 5)
            const sharedWords = blockWords.filter(w => lineWords.includes(w))
            if (sharedWords.length >= 3 && sharedWords.length >= blockWords.length * 0.5) {
              matchedLines.push(line)
            }
          }

          if (matchedLines.length > 0) {
            console.log(`[PDF]       ✓ Matched ${matchedLines.length} lines:`)
            // Create rects from matched lines (full line box)
            for (const line of matchedLines) {
              const lineIdx = pageTextMap.lines.indexOf(line)
              console.log(`[PDF]           Line ${lineIdx + 1}: "${line.text.substring(0, 60)}..."`)

              const yOffset = (line.box.y2 - line.box.y1) * 0.15
              allMatchedRects.push({
                x1: line.box.x1,
                y1: line.box.y1 - yOffset,
                x2: line.box.x2,
                y2: line.box.y2 - yOffset,
                width: line.box.x2 - line.box.x1,
                height: line.box.y2 - line.box.y1,
                pageNumber: pageNum,
              })
            }
          }
          else {
            console.log(`[PDF]       ✗ No matching lines found`)
          }
        }

        if (allMatchedRects.length === 0) {
          console.log('[PDF] ⚠️ No matches found')
          return
        }

        console.log(`[PDF] ✅ Matched ${allMatchedRects.length} rects`)

        // Create highlight
        const boundingRect = {
          x1: Math.min(...allMatchedRects.map(r => r.x1)),
          y1: Math.min(...allMatchedRects.map(r => r.y1)),
          x2: Math.max(...allMatchedRects.map(r => r.x2)),
          y2: Math.max(...allMatchedRects.map(r => r.y2)),
          width: 612,
          height: 792,
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
        console.log(`[PDF] 🎉 Created highlight with ${allMatchedRects.length} rects`)
        console.log(`[PDF] Highlight object:`, newHighlight)

        // Manually scroll to the highlight to trigger textLayer creation on that page
        if (scrollToRef.current) {
          console.log(`[PDF] 📜 Scrolling to highlight page ${apiPageNumber}...`)
          scrollToRef.current(newHighlight)
        } else {
          console.log(`[PDF] ⚠️ scrollTo function not available yet`)
        }
      }
      catch (error: any) {
        console.error('[PDF] ❌ Highlight error:', error)
      }
    }

    findHighlights()
  }, [isFullyReady, chunkContext, pdfDocument, apiPageNumber, pageTextMap, normalizeWithSpaces, calculateSimilarity])

  // Extract full text from API page WITH positions
  useEffect(() => {
    if (!apiPageNumber || !pdfDocument || !scale) return

    // Skip if already extracted for this page
    if (hasExtractedPageRef.current === apiPageNumber) {
      console.log(`[PDF] ⏭️ Already extracted page ${apiPageNumber}, skipping`)
      return
    }

    const extractPageText = async () => {
      try {
        console.log(`[PDF] 📄 Extracting text from page ${apiPageNumber}...`)

        const page = await pdfDocument.getPage(apiPageNumber)
        const textContent = await page.getTextContent()
        const items = textContent.items as any[]

        console.log(`[PDF] 📄 Page ${apiPageNumber}: ${items.length} text items`)

        // Store each text item with its position (deduplicate by position)
        const textItemsMap = new Map<string, typeof textItems[0]>()

        for (const item of items) {
          if (!item.str || !item.str.trim()) continue

          const x = item.transform[4]
          const y = item.transform[5]
          const key = `${x.toFixed(1)},${y.toFixed(1)},${item.str}` // Unique key

          // Skip if duplicate at same position
          if (textItemsMap.has(key)) continue

          textItemsMap.set(key, {
            text: item.str,
            x,
            y,
            width: item.width,
            height: item.height || Math.abs(item.transform[3]),
          })
        }

        const textItems = Array.from(textItemsMap.values())

        // Sort by Y (top to bottom), then X (left to right)
        const sortedItems = [...textItems].sort((a, b) => {
          const yDiff = b.y - a.y
          if (Math.abs(yDiff) < 5) return a.x - b.x
          return yDiff
        })

        // Build full text with line breaks
        let fullText = ''
        let lastY = -1

        for (const item of sortedItems) {
          if (lastY >= 0 && Math.abs(item.y - lastY) > 5) {
            fullText += '\n'
          }
          fullText += item.text + ' '
          lastY = item.y
        }

        // Clean up text
        fullText = fullText.replace(/\b([a-zA-Z])\s+([a-z]+)/g, '$1$2') // Merge split words
        fullText = fullText.replace(/ {2,}/g, ' ').trim()

        // Group text items by line (Y position) to create sentence boxes
        const lineGroups: Array<{
          y: number
          items: typeof textItems
          text: string
          box: { x1: number; y1: number; x2: number; y2: number }
        }> = []

        for (const item of sortedItems) {
          // Find existing line group (within 5px Y)
          const existingLine = lineGroups.find(line => Math.abs(line.y - item.y) < 5)

          if (existingLine) {
            existingLine.items.push(item)
          }
          else {
            lineGroups.push({
              y: item.y,
              items: [item],
              text: '',
              box: { x1: 0, y1: 0, x2: 0, y2: 0 },
            })
          }
        }

        // Calculate bounding box and normalized text for each line
        for (const line of lineGroups) {
          // Sort items by X position (left to right)
          const sortedLineItems = [...line.items].sort((a, b) => a.x - b.x)

          // Keep it simple: join with spaces, rely on fuzzy matching later
          let lineText = sortedLineItems.map(i => i.text).join(' ')

          // Only fix obvious single-letter splits: "o wner" → "owner"
          lineText = lineText.replace(/\b([a-zA-Z])\s+([a-z]+\w*)/g, '$1$2')

          // Clean up spacing
          lineText = lineText.replace(/\s+/g, ' ').trim()

          line.text = lineText
          line.box = {
            x1: Math.min(...line.items.map(i => i.x)),
            y1: Math.min(...line.items.map(i => i.y)),
            x2: Math.max(...line.items.map(i => i.x + i.width)),
            y2: Math.max(...line.items.map(i => i.y + i.height)),
          }
        }

        // Store text map with lines
        const textMap = {
          items: textItems,
          lines: lineGroups.map(lg => ({ y: lg.y, text: lg.text, box: lg.box })),
          fullText,
        }

        setPageTextMap(textMap)
        hasExtractedPageRef.current = apiPageNumber

        console.log(`[PDF] 📝 Page ${apiPageNumber} text map: ${textItems.length} items, ${lineGroups.length} lines`)
        console.log(`[PDF] ✅ pageTextMap state updated - this should trigger highlighting now`)
        console.log(`[PDF] 📦 ALL sentence boxes with positions (${lineGroups.length} lines):`)
        lineGroups.forEach((line, idx) => {
          const box = line.box
          console.log(`[PDF]   Line ${idx + 1}: [${box.x1.toFixed(0)},${box.y1.toFixed(0)} → ${box.x2.toFixed(0)},${box.y2.toFixed(0)}]`)
          console.log(`[PDF]           "${line.text}"`)
        })
        console.log(`[PDF] 📝 Full text (${fullText.length} chars):`)
        console.log(fullText)
      }
      catch (error: any) {
        console.log(`[PDF] ❌ Text extraction error: ${error.message}`)
      }
    }

    extractPageText()
  }, [apiPageNumber, pdfDocument, scale])

  // Note: When highlights are enabled, PdfHighlighter auto-scrolls to show highlights
  // No manual scrolling needed - the highlight's pageNumber triggers auto-scroll

  // Memoize callbacks to prevent PdfHighlighter re-renders
  const enableAreaSelection = useCallback(() => false, [])
  const scrollRef = useCallback((scrollTo: (highlight: IHighlight) => void) => {
    // Store the scrollTo function so we can use it later
    scrollToRef.current = scrollTo
    setViewerReady(true)
    console.log('[PDF] ✅ PdfHighlighter viewer is ready, scrollTo function received')
  }, [])
  const onScrollChange = useCallback(() => {}, [])
  const onSelectionFinished = useCallback(() => null, [])

  // Render highlights using built-in Highlight component
  const highlightTransform = useCallback(
    (highlight: any, _index: number, _setTip: any, _hideTip: any, _viewportToScaled: any, _screenshot: any, isScrolledTo: boolean) => {
      console.log('[PDF] highlightTransform called:', {
        id: highlight.id,
        isScrolledTo,
        rectsCount: highlight.position.rects.length,
        pageNumber: highlight.position.pageNumber,
      })

      // Add test styling to make highlight more visible
      return (
        <div
          style={{
            background: 'rgba(255, 226, 143, 0.8)',
            border: '2px solid red',
            position: 'absolute',
          }}
          onClick={() => console.log('[PDF] Highlight clicked!')}
        >
          <Highlight
            key={highlight.id}
            isScrolledTo={isScrolledTo}
            position={highlight.position}
            comment={highlight.comment}
          />
        </div>
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
