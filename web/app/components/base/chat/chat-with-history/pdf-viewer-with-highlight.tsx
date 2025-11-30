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
  const [scale, setScale] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<IHighlight[]>([])

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

  console.log('[PDF] PdfHighlighterStable render, hasRendered:', hasRendered.current)

  // Reset highlights when chunkContext changes (new citation clicked)
  useEffect(() => {
    console.log('[PDF] ChunkContext changed, resetting highlights')
    hasHighlightedRef.current = false
    hasExtractedPageRef.current = null
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
    if (!isFullyReady || !chunkContext || !pdfDocument || !pageTextMap || hasHighlightedRef.current) return
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
      }
      catch (error: any) {
        console.error('[PDF] ❌ Highlight error:', error)
      }
    }

    findHighlights()
    // if (!isFullyReady || !chunkContext || !pdfDocument || hasHighlightedRef.current) return
    // hasHighlightedRef.current = true

    // const findHighlights = async () => {
    //   console.log('[PDF] 🚀 Starting hybrid sentence + token matching...')
    //   console.log('[PDF] Source text from n8n API:', chunkContext.substring(0, 200))
    //
    //   try {
    //     // Use API page number if available, otherwise default to page 1
    //     const pageNum = apiPageNumber || 1
    //     console.log(`[PDF] 📄 Using page ${pageNum} (API: ${apiPageNumber || 'not set'})`)
    //
    //     const page = await pdfDocument.getPage(pageNum)
    //     const viewport = page.getViewport({ scale: 1.0 })
    //     const textContent = await page.getTextContent()
    //     const items = textContent.items as any[]
    //
    //     console.log(`[PDF] 📄 Page ${pageNum}: ${items.length} text items`)
    //
    //     // Build full text map for sentence matching
    //     const { fullTextWithSpaces, fullTextNoSpaces, textPositions } = buildFullTextMap(items)
    //     console.log(`[PDF] 📝 Full text length: ${fullTextWithSpaces.length} chars`)

    //     // Also build token array for fallback
    //     const pdfTokens = tokenizePDF(items)
    //     console.log(`[PDF] 📄 PDF has ${pdfTokens.length} tokens`)

    //     // Split by newlines to get individual blocks/areas
    //     const allBlocks = chunkContext
    //       .split('\n')
    //       .map(s => s.trim())
    //       .filter(s => s.length > 10)

    //     // Remove duplicate blocks
    //     const uniqueBlocks = [...new Set(allBlocks)]
    //     console.log(`[PDF] 📝 ${allBlocks.length} blocks → ${uniqueBlocks.length} unique blocks`)

    //     // Match each block independently and accumulate ALL rects with metadata
    //     interface MatchedBlock {
    //       blockIndex: number
    //       blockText: string
    //       rects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }>
    //       method: string
    //       yRange: { min: number; max: number }
    //     }

    //     const allMatchedRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []
    //     const matchedBlocks: MatchedBlock[] = []
    //     let totalMatched = 0
    //     let totalTokens = 0

    //     for (let i = 0; i < uniqueBlocks.length; i++) {
    //       const block = uniqueBlocks[i]
    //       const blockTokens = tokenizeChunk(block)
    //       totalTokens += blockTokens.length

    //       if (blockTokens.length < 1) continue

    //       // Debug: Show Block 1 info and find content location
    //       if (i === 0) {
    //         console.log(`[PDF]   Block 1: ${blockTokens.length} tokens →`, blockTokens.map(t => t.raw).join(' '))

    //         // Find cluster where multiple unique tokens appear together
    //         const uniqueTokens = blockTokens.filter(t => t.normalized.length >= 5).slice(0, 5)
    //         const allPositions: { token: string; positions: number[] }[] = []

    //         for (const ut of uniqueTokens) {
    //           const positions = pdfTokens
    //             .map((pt, idx) => pt.normalized === ut.normalized ? idx : -1)
    //             .filter(idx => idx >= 0)
    //           if (positions.length > 0) {
    //             allPositions.push({ token: ut.raw, positions })
    //           }
    //         }

    //         // Find the best cluster (positions where multiple tokens are within 50 of each other)
    //         let bestClusterStart = -1
    //         let bestClusterCount = 0

    //         if (allPositions.length > 0) {
    //           // Try each position as a potential cluster start
    //           for (const { positions } of allPositions) {
    //             for (const pos of positions) {
    //               // Count how many unique tokens appear within 50 positions of this
    //               const count = allPositions.filter(ap =>
    //                 ap.positions.some(p => Math.abs(p - pos) <= 50)
    //               ).length
    //               if (count > bestClusterCount) {
    //                 bestClusterCount = count
    //                 bestClusterStart = pos
    //               }
    //             }
    //           }
    //         }

    //         if (bestClusterStart >= 0) {
    //           const startArea = Math.max(0, bestClusterStart - 10)
    //           console.log(`[PDF]   Content cluster at ~${bestClusterStart} (${bestClusterCount} unique tokens nearby)`)
    //           console.log(`[PDF]   PDF tokens ${startArea}-${startArea + 60}:`, pdfTokens.slice(startArea, startArea + 60).map((t, i) => `${startArea + i}:${t.raw}`).join(' '))
    //         }
    //       }

    //       // ========== PHASE 1: ACCUMULATIVE MATCHING ==========
    //       let blockRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []
    //       let matchMethod = ''

    //       // PASS 1a: Sentence with spaces
    //       const normalizedBlock = normalizeWithSpaces(block)
    //       let sentenceIndex = fullTextWithSpaces.indexOf(normalizedBlock)

    //       if (sentenceIndex !== -1) {
    //         matchMethod = 'sentence'
    //         const sentenceEnd = sentenceIndex + normalizedBlock.length

    //         for (const pos of textPositions) {
    //           const posNormalized = normalizeWithSpaces(pos.text)
    //           const posStart = pos.startIndexWithSpaces
    //           const posEnd = posStart + posNormalized.length + 1

    //           if (posStart < sentenceEnd + 5 && posEnd > sentenceIndex - 2) {
    //             blockRects.push(createRectFromPosition(pos, pageNum))
    //           }
    //         }
    //         console.log(`[PDF]       ✓ Sentence (spaces): +${blockRects.length} rects`)
    //       }

    //       // PASS 1b: Sentence without spaces (ACCUMULATE - may add more rects)
    //       const normalizedBlockNoSpaces = normalizeNoSpaces(block)
    //       const sentenceIndexNoSpaces = fullTextNoSpaces.indexOf(normalizedBlockNoSpaces)

    //       if (sentenceIndexNoSpaces !== -1) {
    //         const sentenceRectsNoSpaces: typeof blockRects = []
    //         const sentenceEnd = sentenceIndexNoSpaces + normalizedBlockNoSpaces.length

    //         for (const pos of textPositions) {
    //           const posNormalized = normalizeNoSpaces(pos.text)
    //           const posStart = pos.startIndexNoSpaces
    //           const posEnd = posStart + posNormalized.length

    //           if (posStart < sentenceEnd + 3 && posEnd > sentenceIndexNoSpaces - 1) {
    //             sentenceRectsNoSpaces.push(createRectFromPosition(pos, pageNum))
    //           }
    //         }

    //         if (sentenceRectsNoSpaces.length > 0) {
    //           console.log(`[PDF]       ✓ Sentence (no spaces): +${sentenceRectsNoSpaces.length} rects`)
    //           blockRects.push(...sentenceRectsNoSpaces)
    //           if (matchMethod === '') matchMethod = 'sentence'
    //           else if (!matchMethod.includes('sentence')) matchMethod += '+sentence'
    //         }
    //       }

    //       // PASS 2: Multi-word anchor search (ACCUMULATE)
    //       const anchorRects: typeof blockRects = []
    //       {
    //         const anchorMethod = 'anchor'
    //         const normalizedBlock = normalizeWithSpaces(block)
    //         const words = normalizedBlock.split(' ').filter(w => w.length > 0)

    //         // Extract 4-5 word anchor phrases
    //         const anchorSize = 4
    //         const anchors: string[] = []
    //         for (let j = 0; j <= words.length - anchorSize; j++) {
    //           anchors.push(words.slice(j, j + anchorSize).join(' '))
    //         }

    //         // Search for any anchor in full text
    //         let anchorFound = false
    //         for (const anchor of anchors) {
    //           const anchorIndex = fullTextWithSpaces.indexOf(anchor)
    //           if (anchorIndex !== -1) {
    //             console.log(`[PDF]       Found anchor: "${anchor}" at position ${anchorIndex}`)
    //             anchorFound = true

    //             // Get Y range from positions near this anchor
    //             const anchorEnd = anchorIndex + anchor.length
    //             const anchorPositions = textPositions.filter(pos => {
    //               const posStart = pos.startIndexWithSpaces
    //               const posEnd = posStart + normalizeWithSpaces(pos.text).length
    //               return posStart < anchorEnd + 50 && posEnd > anchorIndex - 50
    //             })

    //             if (anchorPositions.length > 0) {
    //               const minY = Math.min(...anchorPositions.map(p => p.transform[5]))
    //               const maxY = Math.max(...anchorPositions.map(p => p.transform[5]))
    //               const yTolerance = 100

    //               // Try matching full block text in this Y area
    //               for (const pos of textPositions) {
    //                 const posY = pos.transform[5]
    //                 if (posY < minY - yTolerance || posY > maxY + yTolerance) continue

    //                 const posNormalized = normalizeWithSpaces(pos.text)

    //                 // Check if this text is part of the block
    //                 if (posNormalized.length >= 5 && normalizedBlock.includes(posNormalized)) {
    //                   anchorRects.push(createRectFromPosition(pos, pageNum))
    //                 }
    //               }
    //             }

    //             // If we found matches, stop searching other anchors
    //             if (anchorRects.length > 0) {
    //               break
    //             }
    //           }
    //         }

    //         if (anchorRects.length > 0) {
    //           console.log(`[PDF]       ✓ Anchor: +${anchorRects.length} rects`)
    //           blockRects.push(...anchorRects)
    //           if (matchMethod === '') matchMethod = 'anchor'
    //           else matchMethod += '+anchor'
    //         }
    //       }

    //       // PASS 2.5: Fuzzy fragment matching (ACCUMULATE)
    //       const fragmentRects: typeof blockRects = []
    //       {
    //         const normalizedBlock = normalizeWithSpaces(block)
    //         const blockWords = normalizedBlock.split(' ').filter(w => w.length >= 6)

    //         for (const pos of textPositions) {
    //           const posNormalized = normalizeWithSpaces(pos.text)

    //           if (posNormalized.length < 3) continue

    //           let isMatch = false

    //           // Check 1: Position text is substring of block
    //           if (posNormalized.length >= 5 && normalizedBlock.includes(posNormalized))
    //             isMatch = true

    //           // Check 2: Position text has high similarity with block
    //           if (!isMatch && posNormalized.length >= 15) {
    //             const similarity = calculateSimilarity(posNormalized, normalizedBlock)
    //             if (similarity >= 0.80)
    //               isMatch = true
    //           }

    //           // Check 3: Position contains 2+ words from block
    //           if (!isMatch && blockWords.length >= 2) {
    //             const matchingWords = blockWords.filter(word => posNormalized.includes(word))
    //             if (matchingWords.length >= 2)
    //               isMatch = true
    //           }

    //           if (isMatch) {
    //             fragmentRects.push(createRectFromPosition(pos, pageNum))
    //           }
    //         }

    //         if (fragmentRects.length > 0) {
    //           console.log(`[PDF]       ✓ Fragment: +${fragmentRects.length} rects`)
    //           blockRects.push(...fragmentRects)
    //           if (matchMethod === '') matchMethod = 'fragment'
    //           else matchMethod += '+fragment'
    //         }
    //       }

    //       // PASS 3: Token matching (ACCUMULATE)
    //       const tokenRects: typeof blockRects = []
    //       {
    //         const matchedIndices = findSequentialMatches(blockTokens, pdfTokens, calculateSimilarity)

    //         if (matchedIndices.length > 0) {
    //           tokenRects.push(...generateMatchedRects(matchedIndices, pdfTokens, pageNum))

    //           // PASS 3.5: Sentence refinement - if token match is poor, try full sentences at that location
    //           if (matchedIndices.length < blockTokens.length * 0.8) {
    //             const refinementRects: typeof blockRects = []

    //             // Get Y range from matched tokens
    //             const minMatchY = Math.min(...matchedIndices.map(idx => pdfTokens[idx].y))
    //             const maxMatchY = Math.max(...matchedIndices.map(idx => pdfTokens[idx].y))
    //             const yTolerance = 50

    //             // Try sentence matching in this Y range
    //             const normalizedBlock = normalizeWithSpaces(block)

    //             for (const pos of textPositions) {
    //               const posY = pos.transform[5]
    //               if (posY < minMatchY - yTolerance || posY > maxMatchY + yTolerance) continue

    //               const posNormalized = normalizeWithSpaces(pos.text)

    //               // Check if this text matches the block
    //               if (posNormalized.length >= 5 && normalizedBlock.includes(posNormalized)) {
    //                 refinementRects.push(createRectFromPosition(pos, pageNum))
    //               }
    //             }

    //             if (refinementRects.length > 0) {
    //               console.log(`[PDF]       ✓ Refinement: +${refinementRects.length} rects (upgrading ${matchedIndices.length} token matches)`)
    //               tokenRects.push(...refinementRects)
    //             }
    //           }
    //         }

    //         if (tokenRects.length > 0) {
    //           console.log(`[PDF]       ✓ Token: +${tokenRects.length} rects`)
    //           blockRects.push(...tokenRects)
    //           if (matchMethod === '') matchMethod = 'token'
    //           else matchMethod += '+token'
    //         }
    //       }

    //       // Count total matched for statistics
    //       if (blockRects.length > 0) {
    //         totalMatched += blockTokens.length
    //       }

    //       if (blockRects.length > 0) {
    //         // PASS 4: Per-block gap filling if many rects matched (indicates continuous text)
    //         if (blockRects.length >= 10) {
    //           const blockMinY = Math.min(...blockRects.map(r => r.y1))
    //           const blockMaxY = Math.max(...blockRects.map(r => r.y2))
    //           let blockGapsFilled = 0

    //           for (const pos of textPositions) {
    //             const posNormalized = normalizeWithSpaces(pos.text)
    //             if (posNormalized.length < 2) continue

    //             const y = pos.transform[5]
    //             const height = pos.height
    //             const posTop = y - height * 0.15
    //             const posBottom = y + height - height * 0.15

    //             // Check if within this block's Y range
    //             if (posTop >= blockMinY - 5 && posBottom <= blockMaxY + 5) {
    //               // Check if not already added
    //               const exists = blockRects.some(r =>
    //                 Math.abs(r.x1 - pos.transform[4]) < 1 && Math.abs(r.y1 - (y - height * 0.15)) < 1
    //               )
    //               if (!exists) {
    //                 blockRects.push(createRectFromPosition(pos, pageNum))
    //                 blockGapsFilled++
    //               }
    //             }
    //           }

    //           if (blockGapsFilled > 0) {
    //             console.log(`[PDF]       Gap-filled: +${blockGapsFilled} rects in Y range ${blockMinY.toFixed(0)}-${blockMaxY.toFixed(0)}`)
    //           }
    //         }

    //         console.log(`[PDF]   ✓ Block ${i + 1}: ${matchMethod} → ${blockRects.length} rects (${block.substring(0, 30)}...)`)

    //         // Store matched block metadata
    //         matchedBlocks.push({
    //           blockIndex: i,
    //           blockText: block,
    //           rects: blockRects,
    //           method: matchMethod,
    //           yRange: {
    //             min: Math.min(...blockRects.map(r => r.y1)),
    //             max: Math.max(...blockRects.map(r => r.y2)),
    //           },
    //         })

    //         allMatchedRects.push(...blockRects)
    //       }
    //       else {
    //         console.log(`[PDF]   ✗ Block ${i + 1}: no matches (${block.substring(0, 30)}...)`)
    //       }
    //     }

    //     if (allMatchedRects.length === 0) {
    //       console.log('[PDF] ⚠️ No matches found in any block')
    //       return
    //     }

    //     console.log(`[PDF] ✅ Phase 1 complete: ${totalMatched}/${totalTokens} tokens (${(totalMatched / totalTokens * 100).toFixed(0)}%)`)

    //     // ========== PHASE 1.5: RECONSTRUCT PDF BLOCKS BY LOCATION ==========
    //     console.log(`[PDF] 🧩 Phase 1.5: Reconstructing PDF blocks from ${matchedBlocks.length} matched areas...`)

    //     // Group rects by Y proximity to reconstruct actual PDF blocks
    //     interface ReconstructedBlock {
    //       sourceBlockIndices: number[]
    //       yRange: { min: number; max: number }
    //       rects: typeof allMatchedRects
    //       pdfText: string
    //     }

    //     const reconstructedBlocks: ReconstructedBlock[] = []

    //     // Sort all matched blocks by Y position
    //     const sortedBlocks = [...matchedBlocks].sort((a, b) => a.yRange.min - b.yRange.min)

    //     for (const mb of sortedBlocks) {
    //       // Try to find existing reconstructed block that overlaps
    //       const overlappingBlock = reconstructedBlocks.find(rb => {
    //         const gap = Math.max(mb.yRange.min - rb.yRange.max, rb.yRange.min - mb.yRange.max)
    //         return gap < 30 // Within 30px = same PDF block
    //       })

    //       if (overlappingBlock) {
    //         // Merge into existing reconstructed block
    //         overlappingBlock.sourceBlockIndices.push(mb.blockIndex)
    //         overlappingBlock.rects.push(...mb.rects)
    //         overlappingBlock.yRange.min = Math.min(overlappingBlock.yRange.min, mb.yRange.min)
    //         overlappingBlock.yRange.max = Math.max(overlappingBlock.yRange.max, mb.yRange.max)
    //       }
    //       else {
    //         // Create new reconstructed block
    //         reconstructedBlocks.push({
    //           sourceBlockIndices: [mb.blockIndex],
    //           yRange: { ...mb.yRange },
    //           rects: [...mb.rects],
    //           pdfText: '',
    //         })
    //       }
    //     }

    //     // Extract PDF text for each reconstructed block with proper formatting
    //     for (const rb of reconstructedBlocks) {
    //       const textsInRange = textPositions
    //         .filter(pos => {
    //           const y = pos.transform[5]
    //           return y >= rb.yRange.min - 10 && y <= rb.yRange.max + 10
    //         })
    //         .sort((a, b) => {
    //           const yDiff = a.transform[5] - b.transform[5]
    //           if (Math.abs(yDiff) < 5) return a.transform[4] - b.transform[4] // Same line, sort by X
    //           return yDiff
    //         })

    //       // Build text with line breaks and merge split words
    //       let formattedText = ''
    //       let lastY = -1
    //       let currentLine = ''

    //       for (const pos of textsInRange) {
    //         const y = pos.transform[5]
    //         const text = pos.text.trim()
    //         if (!text) continue

    //         // New line if Y changed significantly (>5px)
    //         if (lastY >= 0 && Math.abs(y - lastY) > 5) {
    //           formattedText += currentLine.trim() + '\n'
    //           currentLine = text
    //         }
    //         else {
    //           // Same line - add with space
    //           if (currentLine.length > 0) {
    //             currentLine += ' ' + text
    //           }
    //           else {
    //             currentLine = text
    //           }
    //         }

    //         lastY = y
    //       }

    //       // Add final line
    //       if (currentLine.length > 0) {
    //         formattedText += currentLine.trim()
    //       }

    //       // Post-process: merge split words (e.g., "o wner" → "owner", "K eys" → "Keys")
    //       // Pattern: single letter followed by space and lowercase word
    //       formattedText = formattedText.replace(/\b([a-zA-Z])\s+([a-z]+)/g, '$1$2')

    //       // Clean up excessive spaces
    //       formattedText = formattedText.replace(/ {2,}/g, ' ')

    //       rb.pdfText = formattedText
    //     }

    //     console.log(`[PDF] 🧩 Reconstructed ${reconstructedBlocks.length} PDF blocks from ${matchedBlocks.length} source blocks`)
    //     for (let i = 0; i < reconstructedBlocks.length; i++) {
    //       const rb = reconstructedBlocks[i]
    //       console.log(`[PDF]   PDF Block ${i + 1}: Y ${rb.yRange.min.toFixed(0)}-${rb.yRange.max.toFixed(0)}, combines source blocks [${rb.sourceBlockIndices.map(idx => idx + 1).join(', ')}], ${rb.rects.length} rects`)
    //       console.log(`[PDF]       Reconstructed paragraph (${rb.pdfText.length} chars):`)
    //       console.log(`[PDF]       "${rb.pdfText}"`)

    //       // Show which source blocks this corresponds to
    //       const sourceBlocks = rb.sourceBlockIndices.map(idx => uniqueBlocks[idx])
    //       console.log(`[PDF]       Source blocks:`)
    //       for (let j = 0; j < sourceBlocks.length; j++) {
    //         const srcIdx = rb.sourceBlockIndices[j]
    //         console.log(`[PDF]         [${srcIdx + 1}] ${sourceBlocks[j].substring(0, 60)}...`)
    //       }
    //     }

    //     // ========== PHASE 2: QUALITY ANALYSIS & FILTERING (COMMENTED OUT FOR TESTING) ==========
    //     // console.log(`[PDF] 🔍 Phase 2: Validating and filtering ${matchedBlocks.length} matched blocks...`)

    //     // // Filter rects per block: Keep only rects that contain block keywords
    //     // const filteredBlocks: MatchedBlock[] = []

    //     // for (const mb of matchedBlocks) {
    //     //   // Extract key words from block (filter common words)
    //     //   const blockWords = normalizeWithSpaces(mb.blockText)
    //     //     .split(' ')
    //     //     .filter(w => w.length >= 5 && !['where', 'there', 'these', 'those', 'their', 'which', 'would', 'could', 'should'].includes(w))

    //     //   if (blockWords.length === 0) {
    //     //     console.log(`[PDF]   ⚠️  Block ${mb.blockIndex + 1}: No keywords to validate, keeping all rects`)
    //     //     filteredBlocks.push(mb)
    //     //     continue
    //     //   }

    //     //   // Check each rect: does it contain any block keywords?
    //     //   const validRects = mb.rects.filter(rect => {
    //     //     // Find text items that overlap with this rect
    //     //     const overlappingTexts = textPositions.filter(pos => {
    //     //       const posY = pos.transform[5]
    //     //       const posX = pos.transform[4]
    //     //       return Math.abs(posY - rect.y1) < 10 && posX >= rect.x1 - 5 && posX <= rect.x2 + 5
    //     //     })

    //     //     // Check if any overlapping text contains block keywords
    //     //     for (const pos of overlappingTexts) {
    //     //       const posNormalized = normalizeWithSpaces(pos.text)
    //     //       const hasKeyword = blockWords.some(kw => posNormalized.includes(kw))
    //     //       if (hasKeyword) return true
    //     //     }

    //     //     return false
    //     //   })

    //     //   const removedCount = mb.rects.length - validRects.length
    //     //   if (removedCount > 0) {
    //     //     console.log(`[PDF]   🧹 Block ${mb.blockIndex + 1}: Removed ${removedCount} irrelevant rects (${validRects.length} kept)`)
    //     //   }

    //     //   if (validRects.length > 0) {
    //     //     filteredBlocks.push({
    //     //       ...mb,
    //     //       rects: validRects,
    //     //       yRange: {
    //     //         min: Math.min(...validRects.map(r => r.y1)),
    //     //         max: Math.max(...validRects.map(r => r.y2)),
    //     //       },
    //     //     })
    //     //   }
    //     //   else {
    //     //     console.log(`[PDF]   ❌ Block ${mb.blockIndex + 1}: All rects removed (no keywords matched)`)
    //     //   }
    //     // }

    //     // console.log(`[PDF] ✅ Phase 2 complete: ${filteredBlocks.length}/${matchedBlocks.length} blocks kept after filtering`)

    //     // // Update allMatchedRects with filtered results
    //     // allMatchedRects.length = 0
    //     // for (const fb of filteredBlocks) {
    //     //   allMatchedRects.push(...fb.rects)
    //     // }

    //     // // Check for overlapping Y ranges (diagnostic info)
    //     // for (let i = 0; i < filteredBlocks.length; i++) {
    //     //   for (let j = i + 1; j < filteredBlocks.length; j++) {
    //     //     const blockA = filteredBlocks[i]
    //     //     const blockB = filteredBlocks[j]

    //     //     const overlapY = Math.max(0,
    //     //       Math.min(blockA.yRange.max, blockB.yRange.max) -
    //     //       Math.max(blockA.yRange.min, blockB.yRange.min)
    //     //     )
    //     //     const rangeA = blockA.yRange.max - blockA.yRange.min
    //     //     const rangeB = blockB.yRange.max - blockB.yRange.min
    //     //     const overlapPercent = overlapY / Math.min(rangeA, rangeB)

    //     //     if (overlapPercent > 0.5) {
    //     //       console.log(`[PDF]   ℹ️  Blocks ${blockA.blockIndex + 1} & ${blockB.blockIndex + 1} overlap ${(overlapPercent * 100).toFixed(0)}% in Y range`)
    //     //     }
    //     //   }
    //     // }

    //     // // PASS 6: Global gap filling (commented out - using per-block instead)
    //     // const minY = Math.min(...allMatchedRects.map(r => r.y1))
    //     // const maxY = Math.max(...allMatchedRects.map(r => r.y2))
    //     // let gapsFilled = 0

    //     // for (const pos of textPositions) {
    //     //   const posNormalized = normalizeWithSpaces(pos.text)
    //     //   if (posNormalized.length < 2) continue

    //     //   const y = pos.transform[5]
    //     //   const height = pos.height
    //     //   const posTop = y - height * 0.15
    //     //   const posBottom = y + height - height * 0.15

    //     //   // Check if this position is within Y range
    //     //   if (posTop >= minY - 5 && posBottom <= maxY + 5) {
    //     //     // Check if not already added
    //     //     const exists = allMatchedRects.some(r =>
    //     //       Math.abs(r.x1 - pos.transform[4]) < 1 && Math.abs(r.y1 - (y - height * 0.15)) < 1
    //     //     )
    //     //     if (!exists) {
    //     //       allMatchedRects.push(createRectFromPosition(pos, pageNum))
    //     //       gapsFilled++
    //     //     }
    //     //   }
    //     // }

    //     // if (gapsFilled > 0) {
    //     //   console.log(`[PDF] 🔧 Filled ${gapsFilled} gaps within Y range ${minY.toFixed(0)}-${maxY.toFixed(0)}`)
    //     // }

    //     // Create ONE highlight from ALL matched rects
    //     const boundingRect = {
    //       x1: Math.min(...allMatchedRects.map(r => r.x1)),
    //       y1: Math.min(...allMatchedRects.map(r => r.y1)),
    //       x2: Math.max(...allMatchedRects.map(r => r.x2)),
    //       y2: Math.max(...allMatchedRects.map(r => r.y2)),
    //       width: viewport.width,
    //       height: viewport.height,
    //       pageNumber: pageNum,
    //     }

    //     const newHighlight: IHighlight = {
    //       id: `highlight-${Date.now()}`,
    //       position: {
    //         boundingRect,
    //         rects: allMatchedRects,
    //         pageNumber: pageNum,
    //         usePdfCoordinates: true,
    //       } as ScaledPosition,
    //       content: { text: chunkContext },
    //       comment: { text: '', emoji: '' },
    //     }

    //     setHighlights([newHighlight])
    //     console.log(`[PDF] 🎉 Created highlight with ${allMatchedRects.length} rects from ${uniqueBlocks.length} blocks`)
    //   }
    //   catch (error: any) {
    //     console.error('[PDF] ❌ Highlight error:', error)
    //   }
    // }
    //
    // findHighlights()
  }, [isFullyReady, chunkContext, pdfDocument, apiPageNumber, pageTextMap, normalizeWithSpaces])

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
        setPageTextMap({
          items: textItems,
          lines: lineGroups.map(lg => ({ y: lg.y, text: lg.text, box: lg.box })),
          fullText,
        })

        hasExtractedPageRef.current = apiPageNumber

        console.log(`[PDF] 📝 Page ${apiPageNumber} text map: ${textItems.length} items, ${lineGroups.length} lines`)
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

  // Note: When highlights are enabled, PdfHighlighter auto-scrolls to show highlights
  // No manual scrolling needed - the highlight's pageNumber triggers auto-scroll

  // Memoize callbacks to prevent PdfHighlighter re-renders
  const enableAreaSelection = useCallback(() => false, [])
  const scrollRef = useCallback(() => {
    // No-op: we're using temporary highlights for scrolling instead
  }, [])
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
