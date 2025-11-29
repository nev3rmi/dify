import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { Highlight, PdfHighlighter, PdfLoader } from 'react-pdf-highlighter'

// CSS override for highlight color (yellow instead of red)
const highlightColorStyle = `
  .Highlight__part { background-color: rgba(255, 226, 143, 0.6) !important; }
  .Highlight--scrolledTo .Highlight__part { background-color: rgba(255, 200, 0, 0.7) !important; }
`
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'
import Loading from '@/app/components/base/loading'

type PdfViewerWithHighlightProps = {
  url: string
  searchText?: string
  pageNumber?: string
  chunkId?: string
  onFullTextExtracted?: (fullText: string) => void
}

type PdfHighlighterWrapperProps = {
  pdfDocument: any
  searchText?: string
  pageNumber?: string
  chunkId?: string
  onFullTextExtracted?: (fullText: string) => void
}

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

// Pipeline steps - each step must complete before the next can start
type PipelineStep = 'init' | 'container_ready' | 'api_complete' | 'scaling_done' | 'highlights_ready' | 'viewer_ready' | 'complete'

// ============ Token-based matching types and functions ============
interface PDFToken {
  text: string
  normalized: string
  x: number
  y: number
  width: number
  height: number
  itemIndex: number
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\w]/g, '').trim()
}

function tokenizeChunk(text: string): string[] {
  return text.split(/\s+/)
    .map(w => normalizeToken(w))
    .filter(w => w.length > 0)
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

// ============ Frequency-based common word detection (language-agnostic) ============
const HIGH_FREQUENCY_THRESHOLD = 10 // Words appearing 10+ times are "common"

interface WordFrequency {
  word: string
  count: number
  isCommon: boolean
}

function analyzeWordFrequency(pdfTokens: PDFToken[]): Map<string, WordFrequency> {
  const frequency = new Map<string, number>()

  // Count occurrences of each word
  for (const token of pdfTokens) {
    const word = token.normalized
    frequency.set(word, (frequency.get(word) || 0) + 1)
  }

  // Mark high-frequency words as "common"
  const result = new Map<string, WordFrequency>()
  for (const [word, count] of frequency) {
    result.set(word, {
      word,
      count,
      isCommon: count >= HIGH_FREQUENCY_THRESHOLD,
    })
  }

  return result
}

function isCommonWord(word: string, wordFrequency: Map<string, WordFrequency>): boolean {
  const freq = wordFrequency.get(word)
  return freq ? freq.isCommon : false
}

// Phase 1: Match content words only (skip high-frequency words)
function findContentWordMatches(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  wordFrequency: Map<string, WordFrequency>,
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  // Filter to content words only (non-common words)
  const contentTokens = chunkTokens.filter(t => !isCommonWord(t, wordFrequency))

  if (contentTokens.length === 0) {
    // All words are common - fall back to full matching
    return findSequentialMatchesCore(chunkTokens, pdfTokens, similarityFn)
  }

  // Use sequential matching on content words only
  return findSequentialMatchesCore(contentTokens, pdfTokens, similarityFn)
}

// Phase 2: Fill in common words within established cluster bounds
function fillCommonWordsInCluster(
  matchedIndices: number[],
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  wordFrequency: Map<string, WordFrequency>,
): number[] {
  if (matchedIndices.length === 0) return []

  // Get Y-bounds of cluster (with generous tolerance for multi-line text)
  const yValues = matchedIndices.map(i => pdfTokens[i].y)
  const minY = Math.min(...yValues)
  const maxY = Math.max(...yValues)
  const yTolerance = 30 // Increased tolerance for wrapped lines

  // For X-bounds, use full page width if text spans multiple lines
  // This handles text that wraps from end of one line to start of next
  const yRange = maxY - minY
  const isMultiLine = yRange > 10 // If matches span multiple lines

  let minX: number
  let maxX: number
  if (isMultiLine) {
    // Multi-line text: use very wide X bounds (essentially full page)
    minX = 0
    maxX = 1000
  }
  else {
    // Single line: use tighter X bounds
    const xValues = matchedIndices.map(i => pdfTokens[i].x)
    minX = Math.min(...xValues) - 100
    maxX = Math.max(...xValues) + 100
  }

  // Find common words in PDF within cluster bounds
  const filledIndices = [...matchedIndices]
  const usedPositions = new Set(matchedIndices)
  const chunkTokenSet = new Set(chunkTokens)

  for (let i = 0; i < pdfTokens.length; i++) {
    if (usedPositions.has(i)) continue

    const token = pdfTokens[i]

    // Check if within cluster bounds (both Y and X)
    const inYRange = token.y >= minY - yTolerance && token.y <= maxY + yTolerance
    const inXRange = token.x >= minX && token.x <= maxX

    if (inYRange && inXRange) {
      // Check if it's a common word that exists in chunk
      if (isCommonWord(token.normalized, wordFrequency) && chunkTokenSet.has(token.normalized)) {
        filledIndices.push(i)
        usedPositions.add(i)
      }
    }
  }

  return filledIndices.sort((a, b) => a - b)
}

// ============ Spatial clustering and match scoring ============
interface MatchCluster {
  indices: number[]
  minY: number
  maxY: number
  avgY: number
}

function clusterMatchesByProximity(
  matchedIndices: number[],
  pdfTokens: PDFToken[],
  yTolerance: number = 50, // Max gap between lines in same cluster
): MatchCluster[] {
  if (matchedIndices.length === 0) return []

  // Sort by Y position
  const sorted = [...matchedIndices].sort((a, b) =>
    pdfTokens[a].y - pdfTokens[b].y,
  )

  const clusters: MatchCluster[] = []
  let currentCluster: number[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prevY = pdfTokens[sorted[i - 1]].y
    const currY = pdfTokens[sorted[i]].y

    if (Math.abs(currY - prevY) <= yTolerance) {
      currentCluster.push(sorted[i])
    }
    else {
      // Gap too large - start new cluster
      if (currentCluster.length >= 2)
        clusters.push(createCluster(currentCluster, pdfTokens))

      currentCluster = [sorted[i]]
    }
  }

  if (currentCluster.length >= 2)
    clusters.push(createCluster(currentCluster, pdfTokens))

  return clusters
}

function createCluster(indices: number[], pdfTokens: PDFToken[]): MatchCluster {
  const yValues = indices.map(i => pdfTokens[i].y)
  return {
    indices,
    minY: Math.min(...yValues),
    maxY: Math.max(...yValues),
    avgY: yValues.reduce((a, b) => a + b, 0) / yValues.length,
  }
}

interface MatchScore {
  matchRatio: number // % of chunk tokens matched
  density: number // How tightly packed are matches
  coherence: number // Are matches in expected Y-range
  score: number // Combined score 0-1
}

function scoreBlockMatch(
  matchedIndices: number[],
  chunkTokens: string[],
  pdfTokens: PDFToken[],
): MatchScore {
  if (matchedIndices.length === 0)
    return { matchRatio: 0, density: 0, coherence: 0, score: 0 }

  // 1. Match ratio (most important)
  const matchRatio = matchedIndices.length / chunkTokens.length

  // 2. Density - how many gaps between matched indices
  let gaps = 0
  for (let i = 1; i < matchedIndices.length; i++) {
    const gap = matchedIndices[i] - matchedIndices[i - 1] - 1
    if (gap > 3) gaps++
  }
  const density = 1 - (gaps / Math.max(1, matchedIndices.length - 1))

  // 3. Coherence - Y-range should be reasonable for text length
  const yValues = matchedIndices.map(i => pdfTokens[i].y)
  const yRange = Math.max(...yValues) - Math.min(...yValues)
  const expectedRange = chunkTokens.length * 3 // ~3px per token estimate
  const coherence = yRange <= expectedRange * 2 ? 1 : Math.max(0, 1 - (yRange - expectedRange * 2) / 500)

  // Combined score
  const score = matchRatio * 0.5 + density * 0.3 + coherence * 0.2

  return { matchRatio, density, coherence, score }
}

const MIN_MATCH_SCORE = 0.5 // Reject matches below this threshold (balanced)

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

// For short blocks (titles), find all matching tokens by proximity (non-sequential)
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
  const yTolerance = 20 // pixels
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

// Core sequential matching - used by two-phase matching
function findSequentialMatchesCore(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  if (chunkTokens.length === 0 || pdfTokens.length === 0) return []

  // For short blocks (titles), use proximity matching instead of sequential
  if (chunkTokens.length <= 15) {
    const proximityResult = findProximityMatches(chunkTokens, pdfTokens, similarityFn)
    if (proximityResult.length >= chunkTokens.length * 0.6)
      return proximityResult
  }

  // Find all starting positions where first token matches
  const startCandidates: number[] = []
  for (let i = 0; i < pdfTokens.length; i++) {
    if (tokensMatch(chunkTokens[0], pdfTokens[i].normalized, similarityFn))
      startCandidates.push(i)
  }

  if (startCandidates.length === 0) return []

  // For each start, try sequential matching
  let bestMatch: number[] = []

  for (const startIdx of startCandidates) {
    const matched: number[] = []
    let pdfIdx = startIdx
    let chunkIdx = 0
    let pdfGaps = 0
    let chunkSkips = 0
    const maxPdfGap = 20 // Allow skipping up to 20 PDF tokens (handles styled/italic text)
    const maxChunkSkip = 20 // Allow skipping up to 20 chunk tokens (handles duplicated content)

    while (chunkIdx < chunkTokens.length && pdfIdx < pdfTokens.length) {
      if (tokensMatch(chunkTokens[chunkIdx], pdfTokens[pdfIdx].normalized, similarityFn)) {
        matched.push(pdfIdx)
        pdfIdx++
        chunkIdx++
        pdfGaps = 0
        chunkSkips = 0
      }
      else {
        // Try skipping PDF token first
        pdfGaps++
        if (pdfGaps <= maxPdfGap) {
          pdfIdx++
        }
        else {
          // PDF gap exhausted, try skipping chunk token instead
          // This handles duplicated/corrupted chunk text
          pdfGaps = 0
          chunkSkips++
          if (chunkSkips > maxChunkSkip) break
          chunkIdx++
        }
      }
    }

    if (matched.length > bestMatch.length)
      bestMatch = matched
  }

  return bestMatch
}

// Anchor-based matching: find start anchor, find end anchor, highlight everything between
function findAnchorBasedMatches(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  wordFrequency: Map<string, WordFrequency>,
  similarityFn: (s1: string, s2: string) => number,
): { indices: number[], startAnchorFound: boolean, endAnchorFound: boolean } {
  if (chunkTokens.length === 0 || pdfTokens.length === 0)
    return { indices: [], startAnchorFound: false, endAnchorFound: false }

  // Get non-common tokens from the chunk for anchoring
  const contentTokenIndices: number[] = []
  for (let i = 0; i < chunkTokens.length; i++) {
    if (!isCommonWord(chunkTokens[i], wordFrequency))
      contentTokenIndices.push(i)
  }

  // If not enough content words, use all tokens
  const anchorTokenIndices = contentTokenIndices.length >= 4
    ? contentTokenIndices
    : chunkTokens.map((_, i) => i)

  // START ANCHOR: First 3-5 content words
  const startAnchorSize = Math.min(5, Math.max(3, Math.floor(anchorTokenIndices.length / 3)))
  const startAnchorIndices = anchorTokenIndices.slice(0, startAnchorSize)
  const startAnchorTokens = startAnchorIndices.map(i => chunkTokens[i])

  // END ANCHOR: Last 3-5 content words
  const endAnchorSize = Math.min(5, Math.max(3, Math.floor(anchorTokenIndices.length / 3)))
  const endAnchorIndices = anchorTokenIndices.slice(-endAnchorSize)
  const endAnchorTokens = endAnchorIndices.map(i => chunkTokens[i])

  // Find START anchor position in PDF
  let startPdfIdx = -1
  for (let i = 0; i < pdfTokens.length - startAnchorSize; i++) {
    let matchCount = 0
    let lastMatchIdx = i

    for (const anchorToken of startAnchorTokens) {
      // Search within a window after last match
      for (let k = lastMatchIdx; k < Math.min(lastMatchIdx + 15, pdfTokens.length); k++) {
        if (tokensMatch(anchorToken, pdfTokens[k].normalized, similarityFn)) {
          matchCount++
          lastMatchIdx = k + 1
          break
        }
      }
    }

    // If we matched enough of the start anchor, we found the start
    if (matchCount >= startAnchorSize * 0.6) {
      startPdfIdx = i
      break
    }
  }

  if (startPdfIdx === -1)
    return { indices: [], startAnchorFound: false, endAnchorFound: false }

  // Find END anchor position in PDF (search after start position)
  // Estimate where to start looking for end anchor
  const estimatedSpan = chunkTokens.length * 1.5 // Allow for some extra tokens in PDF
  const searchStartForEnd = startPdfIdx + Math.floor(chunkTokens.length * 0.5)

  let endPdfIdx = -1
  for (let i = searchStartForEnd; i < Math.min(startPdfIdx + estimatedSpan + 50, pdfTokens.length); i++) {
    let matchCount = 0
    let lastMatchIdx = i

    for (const anchorToken of endAnchorTokens) {
      for (let k = lastMatchIdx; k < Math.min(lastMatchIdx + 15, pdfTokens.length); k++) {
        if (tokensMatch(anchorToken, pdfTokens[k].normalized, similarityFn)) {
          matchCount++
          lastMatchIdx = k + 1
          break
        }
      }
    }

    // If we matched enough of the end anchor, we found the end
    if (matchCount >= endAnchorSize * 0.6) {
      endPdfIdx = lastMatchIdx // Use the last matched position
      break
    }
  }

  // If no end anchor found, estimate based on chunk length
  const endAnchorFound = endPdfIdx !== -1
  if (!endAnchorFound)
    endPdfIdx = Math.min(startPdfIdx + chunkTokens.length + 10, pdfTokens.length - 1)

  // Return ALL indices from start to end (highlight everything between anchors)
  const result: number[] = []
  for (let i = startPdfIdx; i <= endPdfIdx && i < pdfTokens.length; i++)
    result.push(i)

  return { indices: result, startAnchorFound: true, endAnchorFound }
}

// Main matching function: find scattered matches, then fill in everything between min and max
function findSequentialMatches(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  wordFrequency: Map<string, WordFrequency>,
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  // Step 1: Get content tokens only (skip high-frequency words for initial matching)
  const contentTokens = chunkTokens.filter(t => !isCommonWord(t, wordFrequency))

  // If all words are common, use full tokens
  const tokensToMatch = contentTokens.length >= 3 ? contentTokens : chunkTokens

  // Step 2: Find scattered matches using core sequential matching
  const scatteredMatches = findSequentialMatchesCore(tokensToMatch, pdfTokens, similarityFn)

  if (scatteredMatches.length < 2) return scatteredMatches

  // Step 3: Fill in EVERYTHING between first and last match (complete the span)
  const minIdx = Math.min(...scatteredMatches)
  const maxIdx = Math.max(...scatteredMatches)

  // Return all indices from min to max (fills gaps, highlights complete sentence)
  const filledIndices: number[] = []
  for (let i = minIdx; i <= maxIdx; i++)
    filledIndices.push(i)

  return filledIndices
}

function generateMatchedRects(
  matchedIndices: number[],
  pdfTokens: PDFToken[],
  pageNumber: number,
): Array<{ x1: number, y1: number, x2: number, y2: number, width: number, height: number, pageNumber: number }> {
  const rects: Array<{ x1: number, y1: number, x2: number, y2: number, width: number, height: number, pageNumber: number }> = []

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

  // Merge rects on same line - fill gaps between matched tokens
  if (rects.length === 0) return []

  const sorted = [...rects].sort((a, b) => {
    const yDiff = a.y1 - b.y1
    if (Math.abs(yDiff) < 5) return a.x1 - b.x1
    return yDiff
  })

  // Group rects by line (same Y coordinate within tolerance)
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

  // For each line, create one rect from leftmost to rightmost token (fills gaps)
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
  }

  return merged
}

const PdfHighlighterWrapper: FC<PdfHighlighterWrapperProps> = ({
  pdfDocument,
  searchText,
  pageNumber,
  chunkId,
  onFullTextExtracted,
}) => {
  // Pipeline state - start with container_ready to begin immediately
  const [pipelineStep, setPipelineStep] = useState<PipelineStep>('container_ready')

  // Data states
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [fullChunkContext, setFullChunkContext] = useState<string | null>(null)
  const [apiPageNumber, setApiPageNumber] = useState<number | null>(null)

  // Refs for tracking
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const scrollToFnRef = useRef<((highlight: IHighlight) => void) | null>(null)
  const hasScrolledRef = useRef(false)
  const citationKeyRef = useRef<string>('')

  // Debug logging - enabled for debugging
  const addLog = (msg: string) => console.log(`[PDF] ${msg}`)

  // Similarity score function
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

  // ============ STEP 1: Reset pipeline when citation changes ============
  useEffect(() => {
    const newKey = `${chunkId || 'none'}-${pageNumber || 'none'}`

    // Skip if same citation (but always run on first mount)
    if (citationKeyRef.current === newKey && citationKeyRef.current !== '') return

    addLog(`🔄 Citation changed: ${newKey}`)
    citationKeyRef.current = newKey

    // Reset state
    setHighlights([])
    setFullChunkContext(null)
    setApiPageNumber(null)
    hasScrolledRef.current = false

    // Restart pipeline from container_ready
    setPipelineStep('container_ready')
  }, [chunkId, pageNumber])

  // ============ STEP 2: Wait for container to have size ============
  useEffect(() => {
    if (pipelineStep !== 'container_ready') return

    addLog('📦 Step 2: Checking container...')

    const checkContainer = () => {
      if (!containerRef.current) {
        addLog('⏳ Container ref not ready, retrying...')
        setTimeout(checkContainer, 50)
        return
      }

      const { width, height } = containerRef.current.getBoundingClientRect()
      addLog(`📐 Container size: ${width.toFixed(0)}x${height.toFixed(0)}`)

      if (width > 0 && height > 0) {
        lastSizeRef.current = { width, height }
        addLog(`✅ Container ready!`)

        // Next step: fetch API data if needed, otherwise go to scaling
        if (chunkId) {
          addLog('➡️ Moving to: api_complete')
          setPipelineStep('api_complete')
        }
        else {
          addLog('➡️ Moving to: scaling_done (no chunkId)')
          setPipelineStep('scaling_done')
        }
      }
      else {
        setTimeout(checkContainer, 50)
      }
    }

    checkContainer()
  }, [pipelineStep, chunkId])

  // ============ STEP 3: Fetch API data (if chunkId exists) ============
  useEffect(() => {
    if (pipelineStep !== 'api_complete' || !chunkId) return

    const fetchChunkContext = async () => {
      try {
        addLog(`📡 Fetching chunk ${chunkId}...`)
        const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
        const data = await response.json()

        if (data.chunk_context) {
          setFullChunkContext(data.chunk_context)
          addLog('✅ Got chunk context')

          if (onFullTextExtracted)
            onFullTextExtracted(data.chunk_context)
        }

        if (data.page_numbers && data.page_numbers.length > 0) {
          setApiPageNumber(data.page_numbers[0])
          addLog(`📄 API page number: ${data.page_numbers[0]}`)
        }

        // Next step: scaling
        setPipelineStep('scaling_done')
      }
      catch (error: any) {
        addLog(`❌ API error: ${error.message}`)
        // Continue anyway with fallback
        setPipelineStep('scaling_done')
      }
    }

    fetchChunkContext()
  }, [pipelineStep, chunkId, onFullTextExtracted])

  // ============ STEP 4: Wait for scaling to stabilize ============
  useEffect(() => {
    if (pipelineStep !== 'scaling_done') return

    addLog('⏳ Waiting for scaling to stabilize...')

    // Wait for PDF viewer to stabilize (first load needs more time)
    const delay = 800
    const timer = setTimeout(() => {
      addLog('✅ Scaling complete')
      setPipelineStep('highlights_ready')
    }, delay)

    return () => clearTimeout(timer)
  }, [pipelineStep])

  // ============ STEP 5: Compute highlights ============
  useEffect(() => {
    if (pipelineStep !== 'highlights_ready') return

    const textToSearch = fullChunkContext || searchText
    if (!textToSearch) {
      addLog('⚠️ No text to search')
      setPipelineStep('viewer_ready')
      return
    }

    const findTextHighlight = async () => {
      try {
        addLog('🚀 Starting block-by-block matching...')

        const pageNum = apiPageNumber || (pageNumber ? Number.parseInt(pageNumber) : 1)
        const page = await pdfDocument.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.0 })
        const textContent = await page.getTextContent()
        const items = textContent.items as any[]

        addLog(`📄 Page ${pageNum}: ${items.length} text items`)

        // Tokenize PDF once (reused for all blocks)
        const pdfTokens = tokenizePDF(items)
        addLog(`📄 PDF has ${pdfTokens.length} tokens`)

        // Analyze word frequency for common word detection (language-agnostic)
        const wordFrequency = analyzeWordFrequency(pdfTokens)
        const commonWords = [...wordFrequency.values()].filter(w => w.isCommon).map(w => w.word)
        addLog(`📊 Detected ${commonWords.length} high-frequency words: ${commonWords.slice(0, 5).join(', ')}${commonWords.length > 5 ? '...' : ''}`)

        // Split by newlines to get individual blocks/areas
        const allBlocks = textToSearch
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 10) // Skip very short fragments

        // Remove duplicate blocks
        const uniqueBlocks = [...new Set(allBlocks)]
        addLog(`📝 ${allBlocks.length} blocks → ${uniqueBlocks.length} unique blocks`)

        // Match each block using anchor-based matching (find start → find end → highlight all between)
        const allMatchedRects: Array<{ x1: number, y1: number, x2: number, y2: number, width: number, height: number, pageNumber: number }> = []
        let totalMatched = 0
        let totalTokens = 0

        for (let i = 0; i < uniqueBlocks.length; i++) {
          const block = uniqueBlocks[i]
          const blockTokens = tokenizeChunk(block)
          totalTokens += blockTokens.length

          if (blockTokens.length < 1) continue // Only skip empty blocks

          // Find matches and fill in everything between first and last match
          const matchedIndices = findSequentialMatches(blockTokens, pdfTokens, wordFrequency, calculateSimilarity)

          if (matchedIndices.length > 0) {
            totalMatched += matchedIndices.length
            const blockRects = generateMatchedRects(matchedIndices, pdfTokens, pageNum)
            allMatchedRects.push(...blockRects)
            addLog(`  ✓ Block ${i + 1}: ${matchedIndices.length} tokens highlighted (${block.substring(0, 30)}...)`)
          }
          else {
            addLog(`  ✗ Block ${i + 1}: no matches (${block.substring(0, 30)}...)`)
          }
        }

        if (allMatchedRects.length === 0) {
          addLog('⚠️ No matches found in any block')
          setPipelineStep('viewer_ready')
          return
        }

        addLog(`✅ Total: ${totalMatched}/${totalTokens} tokens (${(totalMatched / totalTokens * 100).toFixed(0)}%)`)

        // Create highlight from all matched rects
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
          content: { text: textToSearch },
          comment: { text: '', emoji: '' },
        }

        setHighlights([newHighlight])
        addLog(`🎉 Created highlight with ${allMatchedRects.length} rects from ${uniqueBlocks.length} blocks`)

        setPipelineStep('viewer_ready')
      }
      catch (error: any) {
        console.error('Highlight error:', error)
        addLog(`❌ Error: ${error.message}`)
        setPipelineStep('viewer_ready')
      }
    }

    findTextHighlight()
  }, [pipelineStep, pdfDocument, searchText, pageNumber, fullChunkContext, apiPageNumber, calculateSimilarity])

  // ============ STEP 6: Wait for viewer to be ready, then scroll ============
  useEffect(() => {
    if (pipelineStep !== 'viewer_ready') return

    addLog('⏳ Waiting for viewer to initialize...')

    const timer = setTimeout(() => {
      addLog('✅ Viewer ready')

      // Scroll to highlight if we have one
      if (highlights.length > 0 && scrollToFnRef.current && !hasScrolledRef.current) {
        addLog('📜 Scrolling to highlight...')
        scrollToFnRef.current(highlights[0])
        hasScrolledRef.current = true
      }

      setPipelineStep('complete')
    }, 600)

    return () => clearTimeout(timer)
  }, [pipelineStep, highlights])

  // ============ Handle resize - restart from scaling step ============
  useEffect(() => {
    if (!containerRef.current || pipelineStep === 'init') return

    let resizeTimer: NodeJS.Timeout | null = null

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect
      if (width === 0 || height === 0) return

      // Only restart if size changed significantly
      if (Math.abs(width - lastSizeRef.current.width) > 10
          || Math.abs(height - lastSizeRef.current.height) > 10) {
        lastSizeRef.current = { width, height }

        if (resizeTimer)
          clearTimeout(resizeTimer)

        // Debounce resize - restart from scaling step
        resizeTimer = setTimeout(() => {
          if (pipelineStep === 'complete') {
            addLog('📐 Resize detected, recomputing...')
            setHighlights([])
            hasScrolledRef.current = false
            setPipelineStep('scaling_done')
          }
        }, 300)
      }
    })

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      if (resizeTimer)
        clearTimeout(resizeTimer)
    }
  }, [pipelineStep])

  return (
    <div className='flex h-full w-full flex-col'>
      {/* Inject CSS override for highlight color */}
      <style dangerouslySetInnerHTML={{ __html: highlightColorStyle }} />
      {/* PDF Viewer - always rendered, no conditional */}
      <div ref={containerRef} className='min-h-0 flex-1'>
        <PdfHighlighter
          pdfDocument={pdfDocument}
          enableAreaSelection={() => false}
          scrollRef={(scrollTo) => {
            scrollToFnRef.current = scrollTo
          }}
          // eslint-disable-next-line no-empty-function
          onScrollChange={() => {}}
          pdfScaleValue="page-width"
          onSelectionFinished={() => null}
          highlightTransform={(highlight, _index, _setTip, _hideTip, _viewportToScaled, _screenshot, isScrolledTo) => (
            <Highlight
              key={highlight.id}
              isScrolledTo={isScrolledTo}
              position={highlight.position}
              comment={highlight.comment}
            />
          )}
          highlights={pipelineStep === 'complete' ? highlights : []}
        />
      </div>
    </div>
  )
}

const PdfViewerWithHighlight: FC<PdfViewerWithHighlightProps> = ({
  url,
  searchText,
  pageNumber,
  chunkId,
  onFullTextExtracted,
}) => {
  return (
    <div className='h-full w-full'>
      <PdfLoader
        workerSrc='/pdf.worker.min.mjs'
        url={url}
        beforeLoad={
          <div className='flex h-64 items-center justify-center'>
            <Loading type='app' />
          </div>
        }
      >
        {pdfDocument => (
          <PdfHighlighterWrapper
            pdfDocument={pdfDocument}
            searchText={searchText}
            pageNumber={pageNumber}
            chunkId={chunkId}
            onFullTextExtracted={onFullTextExtracted}
          />
        )}
      </PdfLoader>
    </div>
  )
}

export default PdfViewerWithHighlight
