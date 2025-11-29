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

function findSequentialMatches(
  chunkTokens: string[],
  pdfTokens: PDFToken[],
  similarityFn: (s1: string, s2: string) => number,
): number[] {
  if (chunkTokens.length === 0 || pdfTokens.length === 0) return []

  // For short blocks (titles), use proximity matching instead of sequential
  if (chunkTokens.length <= 15) {
    const proximityResult = findProximityMatches(chunkTokens, pdfTokens, similarityFn)
    if (proximityResult.length >= chunkTokens.length * 0.6) {
      return proximityResult
    }
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

        // Split by newlines to get individual blocks/areas
        const allBlocks = textToSearch
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 10) // Skip very short fragments

        // Remove duplicate blocks
        const uniqueBlocks = [...new Set(allBlocks)]
        addLog(`📝 ${allBlocks.length} blocks → ${uniqueBlocks.length} unique blocks`)

        // Match each block independently
        const allMatchedRects: Array<{ x1: number, y1: number, x2: number, y2: number, width: number, height: number, pageNumber: number }> = []
        let totalMatched = 0
        let totalTokens = 0

        for (let i = 0; i < uniqueBlocks.length; i++) {
          const block = uniqueBlocks[i]
          const blockTokens = tokenizeChunk(block)
          totalTokens += blockTokens.length

          if (blockTokens.length < 1) continue // Only skip empty blocks

          // Find matches for this block
          const matchedIndices = findSequentialMatches(blockTokens, pdfTokens, calculateSimilarity)

          if (matchedIndices.length > 0) {
            totalMatched += matchedIndices.length
            const blockRects = generateMatchedRects(matchedIndices, pdfTokens, pageNum)
            allMatchedRects.push(...blockRects)
            addLog(`  ✓ Block ${i + 1}: ${matchedIndices.length}/${blockTokens.length} tokens (${block.substring(0, 30)}...)`)
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
