import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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

// PDF renderer component
type PdfHighlighterStableProps = {
  pdfDocument: any
  onReady: () => void
  containerWidth: number
  chunkContext: string | null
  isFullyReady: boolean
  apiPageNumber: number | null
  apiPageNumbers: number[]
}

const PdfHighlighterStable: FC<PdfHighlighterStableProps> = ({ pdfDocument, onReady, containerWidth, chunkContext, isFullyReady, apiPageNumber, apiPageNumbers }) => {
  const hasCalledReady = useRef(false)
  const hasRendered = useRef(false)
  const hasHighlightedRef = useRef(false)
  const hasExtractedPagesRef = useRef<Set<number>>(new Set())
  const scrollToRef = useRef<((highlight: IHighlight) => void) | null>(null)
  const [scale, setScale] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [viewerReady, setViewerReady] = useState(false)

  // Page text map with line boxes
  type LineGroup = {
    y: number
    pageNumber: number
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
      pageNumber: number
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
    hasExtractedPagesRef.current.clear()
    setViewerReady(false)
    setHighlights([])
    setPageTextMap(null)
  }, [chunkContext])

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
      catch {
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

  // Normalization helper
  const normalizeWithSpaces = useCallback((text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim(), [])

  // Levenshtein distance for better similarity matching
  const levenshteinDistance = useCallback((str1: string, str2: string): number => {
    const len1 = str1.length
    const len2 = str2.length
    const matrix: number[][] = []

    for (let i = 0; i <= len1; i++)
      matrix[i] = [i]

    for (let j = 0; j <= len2; j++)
      matrix[0][j] = j

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + cost, // substitution
        )
      }
    }

    return matrix[len1][len2]
  }, [])

  // Calculate similarity score from Levenshtein distance (0-1, higher is better)
  const calculateLevenshteinSimilarity = useCallback((str1: string, str2: string): number => {
    const distance = levenshteinDistance(str1, str2)
    const maxLength = Math.max(str1.length, str2.length)
    return maxLength === 0 ? 1 : 1 - distance / maxLength
  }, [levenshteinDistance])

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
      console.log('[PDF] 🚀 Starting sliding window + Levenshtein matching...')
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
        const matchResults: Array<{ blockIndex: number; score: number; matched: boolean }> = []

        // Match each chunk block using sliding window approach
        for (let i = 0; i < chunkBlocks.length; i++) {
          const block = chunkBlocks[i]
          const blockNormalized = normalizeWithSpaces(block)

          console.log(`[PDF]   Block ${i + 1}: "${block.substring(0, 60)}..."`)

          let bestMatch: { lines: typeof pageTextMap.lines, score: number } | null = null

          // Try windows of 1-5 consecutive PDF lines
          for (let windowSize = 1; windowSize <= Math.min(5, pageTextMap.lines.length); windowSize++) {
            for (let startIdx = 0; startIdx <= pageTextMap.lines.length - windowSize; startIdx++) {
              const windowLines = pageTextMap.lines.slice(startIdx, startIdx + windowSize)
              const windowText = normalizeWithSpaces(windowLines.map(l => l.text).join(' '))

              // Calculate similarity using Levenshtein distance
              const similarity = calculateLevenshteinSimilarity(blockNormalized, windowText)

              // Check substring in BOTH directions (needed for multi-column PDFs)
              const isSubstring = windowText.includes(blockNormalized) || blockNormalized.includes(windowText)

              let score = isSubstring ? 1.0 : similarity

              // Special handling for short blocks (<60 chars): word-bag matching
              // Helps with headers/titles/URLs where word order may differ
              if (blockNormalized.length < 60 && score < 0.75) {
                const blockWords = blockNormalized.split(' ').filter(w => w.length >= 3)
                const windowWords = windowText.split(' ').filter(w => w.length >= 3)

                // Check if ALL block words exist in window (order-independent)
                const allWordsPresent = blockWords.length > 0
                  && blockWords.every(w => windowWords.some(ww => ww.includes(w) || w.includes(ww)))

                // SAFEGUARD: Window shouldn't be much longer than block (prevent false positives)
                const lengthRatio = windowText.length / blockNormalized.length
                const acceptableLength = lengthRatio <= 2.0 // At most 2x longer

                if (allWordsPresent && acceptableLength) {
                  score = 0.85 // Good enough for short blocks
                  console.log(`[PDF]           (word-bag match for short block, ratio: ${lengthRatio.toFixed(1)}x)`)
                }
              }

              if (!bestMatch || score > bestMatch.score)
                bestMatch = { lines: windowLines, score }
            }
          }

          // Accept match if score > 0.75
          const threshold = 0.75
          if (bestMatch && bestMatch.score >= threshold) {
            console.log(`[PDF]       ✓ Matched ${bestMatch.lines.length} consecutive lines (score: ${bestMatch.score.toFixed(2)}):`)

            // Create rects from matched lines
            for (const line of bestMatch.lines) {
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
                pageNumber: line.pageNumber, // Use actual page from line
              })
            }

            matchResults.push({ blockIndex: i, score: bestMatch.score, matched: true })
          }
          else {
            console.log(`[PDF]       ✗ No match found (best score: ${bestMatch?.score.toFixed(2) || '0.00'})`)
            matchResults.push({ blockIndex: i, score: bestMatch?.score || 0, matched: false })
          }
        }

        // Calculate quality metrics
        const totalBlocks = chunkBlocks.length
        const matchedBlocks = matchResults.filter(r => r.matched).length
        const matchRate = totalBlocks > 0 ? matchedBlocks / totalBlocks : 0
        const avgScore = matchResults.length > 0
          ? matchResults.reduce((sum, r) => sum + r.score, 0) / matchResults.length
          : 0

        // Calculate character coverage
        const matchedBlocksText = chunkBlocks
          .filter((_, idx) => matchResults[idx]?.matched)
          .join(' ')
        const coverageRate = chunkContext.length > 0
          ? matchedBlocksText.length / chunkContext.length
          : 0

        console.log('\n[PDF] 📊 QUALITY METRICS')
        console.log(`[PDF] ${'='.repeat(50)}`)
        console.log(`[PDF] Block Match Rate:  ${matchedBlocks}/${totalBlocks} (${(matchRate * 100).toFixed(1)}%)`)
        console.log(`[PDF] Average Score:     ${avgScore.toFixed(3)}`)
        console.log(`[PDF] Coverage:          ${(coverageRate * 100).toFixed(1)}% of chunk chars`)
        console.log(`[PDF] Matched Rects:     ${allMatchedRects.length}`)
        console.log(`[PDF] ${'='.repeat(50)}\n`)

        if (allMatchedRects.length === 0) {
          console.log('[PDF] ⚠️ No matches found')
          return
        }

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
        console.log('[PDF] Highlight object:', newHighlight)

        // Manually scroll to the highlight to trigger textLayer creation on that page
        if (scrollToRef.current) {
          console.log(`[PDF] 📜 Scrolling to highlight page ${apiPageNumber}...`)
          scrollToRef.current(newHighlight)
        }
        else {
          console.log('[PDF] ⚠️ scrollTo function not available yet')
        }
      }
      catch (error: any) {
        console.error('[PDF] ❌ Highlight error:', error)
      }
    }

    findHighlights()
  }, [isFullyReady, chunkContext, pdfDocument, apiPageNumber, pageTextMap, normalizeWithSpaces, calculateLevenshteinSimilarity])

  // Extract full text from ALL API pages WITH positions
  useEffect(() => {
    if (apiPageNumbers.length === 0 || !pdfDocument || !scale) return

    // Check if we've already extracted these exact pages
    const pagesKey = apiPageNumbers.join(',')
    const alreadyExtracted = apiPageNumbers.every(p => hasExtractedPagesRef.current.has(p))

    if (alreadyExtracted) {
      console.log(`[PDF] ⏭️ Already extracted pages [${pagesKey}], skipping`)
      return
    }

    const extractMultiPageText = async () => {
      try {
        console.log(`[PDF] 📄 Extracting text from pages [${pagesKey}]...`)

        // Collect all text items from ALL pages
        const allTextItems: Array<{
          text: string
          x: number
          y: number
          width: number
          height: number
          pageNumber: number
        }> = []

        for (const pageNum of apiPageNumbers) {
          const page = await pdfDocument.getPage(pageNum)
          const textContent = await page.getTextContent()
          const items = textContent.items as any[]

          console.log(`[PDF]   Page ${pageNum}: ${items.length} text items`)

          // Deduplicate and add to collection with page number
          for (const item of items) {
            if (!item.str || !item.str.trim()) continue

            const x = item.transform[4]
            const y = item.transform[5]
            const key = `${pageNum}-${x.toFixed(1)},${y.toFixed(1)},${item.str}`

            // Check if already added
            const exists = allTextItems.some(t =>
              t.pageNumber === pageNum && Math.abs(t.x - x) < 1 && Math.abs(t.y - y) < 1 && t.text === item.str
            )

            if (!exists) {
              allTextItems.push({
                text: item.str,
                x,
                y,
                width: item.width,
                height: item.height || Math.abs(item.transform[3]),
                pageNumber: pageNum,
              })
            }
          }

          // Mark page as extracted
          hasExtractedPagesRef.current.add(pageNum)
        }

        console.log(`[PDF] ✅ Extracted ${allTextItems.length} total items from ${apiPageNumbers.length} page(s)`)

        const textItems = allTextItems

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
          if (lastY >= 0 && Math.abs(item.y - lastY) > 5)
            fullText += '\n'

          fullText += `${item.text} `
          lastY = item.y
        }

        // Clean up text
        fullText = fullText.replace(/\b([a-zA-Z])\s+([a-z]+)/g, '$1$2') // Merge split words
        fullText = fullText.replace(/ {2,}/g, ' ').trim()

        // Group text items by line (Y position + page number)
        const lineGroups: Array<{
          y: number
          pageNumber: number
          items: typeof textItems
          text: string
          box: { x1: number; y1: number; x2: number; y2: number }
        }> = []

        for (const item of sortedItems) {
          // Find existing line group (within 5px Y AND same page)
          const existingLine = lineGroups.find(line =>
            line.pageNumber === item.pageNumber && Math.abs(line.y - item.y) < 5
          )

          if (existingLine) {
            existingLine.items.push(item)
          }
          else {
            lineGroups.push({
              y: item.y,
              pageNumber: item.pageNumber,
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

        // Store text map with lines (including page numbers)
        const textMap = {
          items: textItems,
          lines: lineGroups.map(lg => ({ y: lg.y, pageNumber: lg.pageNumber, text: lg.text, box: lg.box })),
          fullText,
        }

        setPageTextMap(textMap)

        console.log(`[PDF] 📝 Pages [${pagesKey}] text map: ${textItems.length} items, ${lineGroups.length} lines`)
        console.log('[PDF] ✅ pageTextMap state updated - this should trigger highlighting now')
        console.log(`[PDF] 📦 ALL sentence boxes with positions (${lineGroups.length} lines from ${apiPageNumbers.length} page(s)):`)
        lineGroups.forEach((line, idx) => {
          const box = line.box
          console.log(`[PDF]   Line ${idx + 1} (p${line.pageNumber}): [${box.x1.toFixed(0)},${box.y1.toFixed(0)} → ${box.x2.toFixed(0)},${box.y2.toFixed(0)}]`)
          console.log(`[PDF]           "${line.text}"`)
        })
        console.log(`[PDF] 📝 Full text (${fullText.length} chars):`)
        console.log(fullText)
      }
      catch (error: any) {
        console.log(`[PDF] ❌ Text extraction error: ${error.message}`)
      }
    }

    extractMultiPageText()
  }, [apiPageNumbers, pdfDocument, scale])

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
  const onScrollChange = useCallback(() => {
    // No-op: PdfHighlighter requires this callback
  }, [])
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
    [],
  )

  // Don't render PDF until scale is calculated - prevents initial render at wrong scale
  if (scale === null)
    return <div className="h-full w-full" />

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

const PdfViewerWithHighlight: FC<PdfViewerWithHighlightProps> = ({
  url,
  chunkId,
  onFullTextExtracted,
}) => {
  const [pdfLoaded, setPdfLoaded] = useState(false)
  const [apiLoaded, setApiLoaded] = useState(false)
  const [fullChunkContext, setFullChunkContext] = useState<string | null>(null)
  const [apiPageNumbers, setApiPageNumbers] = useState<number[]>([])
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
    setApiPageNumbers([])
    setApiPageNumber(null)
    const fetchChunkContext = async () => {
      console.log(`[PDF] Fetching chunk ${chunkId}...`)
      try {
        const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
        const text = await response.text()
        console.log(`[PDF] Response: ${text.substring(0, 200)}`)

        if (text) {
          const data = JSON.parse(text)
          console.log('[PDF] API data:', data)

          if (data.chunk_context) {
            // Handle double-encoded JSON string
            let chunkText = data.chunk_context
            if (typeof chunkText === 'string' && chunkText.startsWith('"') && chunkText.endsWith('"'))
              chunkText = JSON.parse(chunkText) // Parse the inner JSON string

            setFullChunkContext(chunkText)
            console.log(`[PDF] Got context: ${chunkText.length} chars`)
            if (onFullTextExtractedRef.current)
              onFullTextExtractedRef.current(chunkText)
          }
          if (data.page_numbers && data.page_numbers.length > 0) {
            setApiPageNumbers(data.page_numbers)
            setApiPageNumber(data.page_numbers[0])
            console.log(`[PDF] API page numbers: [${data.page_numbers.join(', ')}]`)
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
        className='h-full w-full overflow-y-auto overflow-x-hidden'
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
              apiPageNumbers={apiPageNumbers}
            />
          )}
        </PdfLoader>
      </div>
    </div>
  )
}
export default PdfViewerWithHighlight
