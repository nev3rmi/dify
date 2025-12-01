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
  _containerWidth: number
  chunkContext: string | null
  isFullyReady: boolean
  apiPageNumber: number | null
  apiPageNumbers: number[]
}

const PdfHighlighterStable: FC<PdfHighlighterStableProps> = ({ pdfDocument, onReady, _containerWidth, chunkContext, isFullyReady, apiPageNumber, apiPageNumbers }) => {
  const hasCalledReady = useRef(false)
  const hasRendered = useRef(false)
  const hasHighlightedRef = useRef(false)
  const hasExtractedPagesRef = useRef<Set<number>>(new Set())
  const scrollToRef = useRef<((highlight: IHighlight) => void) | null>(null)
  const [scale, setScale] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [_viewerReady, setViewerReady] = useState(false)

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
    setHighlights([])
    setPageTextMap(null)
  }, [chunkContext])

  // Set fixed scale once on mount
  useEffect(() => {
    if (!pdfDocument || scale) return
    console.log('[PDF] 📐 Setting fixed scale: 0.55')
    setScale('0.55')
  }, [pdfDocument, scale])

  useEffect(() => {
    if (!hasCalledReady.current && scale !== null) {
      hasCalledReady.current = true
      onReady()
    }
  }, [onReady, scale])

  // Normalization helper - removes punctuation for better matching
  const normalizeWithSpaces = useCallback((text: string) => text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')
    .trim(), [])

  // Normalization without spaces - for handling "sciencenewst oday" vs "sciencenewstoday"
  const normalizeNoSpaces = useCallback((text: string) => text
    .toLowerCase()
    .replace(/[^\w]/g, ''), [])

  // Word-bag matching for word order differences
  const wordBagMatch = useCallback((lineText: string, blockText: string): number => {
    const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out'])
    const lineWords = lineText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w))
    const blockWords = blockText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w))

    if (lineWords.length === 0) return 0

    let matchedWords = 0
    for (const word of lineWords) {
      const exactMatch = blockWords.includes(word)
      const substringMatch = blockWords.some((bw) => {
        const shorter = Math.min(bw.length, word.length)
        const longer = Math.max(bw.length, word.length)
        return shorter >= 5 && longer / shorter <= 1.5 && (bw.includes(word) || word.includes(bw))
      })
      if (exactMatch || substringMatch) matchedWords++
    }

    return matchedWords / lineWords.length
  }, [])

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
      hasScrollTo: !!scrollToRef.current,
      hasHighlighted: hasHighlightedRef.current,
    })

    if (!isFullyReady || !chunkContext || !pdfDocument || !pageTextMap || !hasRendered.current || hasHighlightedRef.current) return

    console.log('[PDF] ✅ All dependencies ready, starting highlighting...')
    hasHighlightedRef.current = true

    const findHighlights = async () => {
      console.log('[PDF] 🚀 Starting SEQUENTIAL PARAGRAPH matching...')
      console.log('[PDF] Chunk context:', chunkContext.substring(0, 200))

      try {
        const pageNum = apiPageNumber || 1

        // Split chunk into blocks
        const chunkBlocks = chunkContext
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length > 10)

        console.log(`[PDF] 📝 ${chunkBlocks.length} chunk blocks to match against ${pageTextMap.lines.length} PDF lines`)

        const allMatchedRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []
        const matchResults: Array<{ blockIndex: number; linesMatched: number; matched: boolean }> = []

        // SEQUENTIAL PARAGRAPH MATCHING: Find ALL lines that belong to each block
        let lastMatchedLineIdx = -1

        for (let blockIdx = 0; blockIdx < chunkBlocks.length; blockIdx++) {
          const block = chunkBlocks[blockIdx]
          const blockNormalized = normalizeWithSpaces(block)

          console.log(`[PDF]   Block ${blockIdx + 1}: "${block.substring(0, 60)}..."`)

          // Find ALL PDF lines whose text appears in this chunk block
          const matchingLines: Array<{ line: typeof pageTextMap.lines[0]; lineIdx: number }> = []

          for (let lineIdx = lastMatchedLineIdx + 1; lineIdx < pageTextMap.lines.length; lineIdx++) {
            const line = pageTextMap.lines[lineIdx]
            const lineNormalized = normalizeWithSpaces(line.text)

            // Skip very short lines
            if (lineNormalized.length < 8) continue

            // Check if this PDF line's text appears in the chunk block
            const lineInBlock = blockNormalized.includes(lineNormalized)

            // Also check if block appears in line (for short blocks)
            const blockInLine = lineNormalized.includes(blockNormalized)

            // Check with no spaces (handles "sciencenewst oday" vs "sciencenewstoday")
            const lineNoSpaces = normalizeNoSpaces(line.text)
            const blockNoSpaces = normalizeNoSpaces(block)
            const lineInBlockNoSpaces = blockNoSpaces.includes(lineNoSpaces)
            const blockInLineNoSpaces = lineNoSpaces.includes(blockNoSpaces)

            // Word-bag matching (handles word order differences)
            // Stricter threshold for short blocks to avoid false positives
            const lengthRatio = Math.max(lineNormalized.length, blockNormalized.length) / Math.min(lineNormalized.length, blockNormalized.length)
            const wordBagScore = lengthRatio <= 3 ? wordBagMatch(line.text, block) : 0
            const wordBagThreshold = blockNormalized.length < 60 ? 0.95 : 0.8

            // Fallback: high Levenshtein similarity
            const similarity = calculateLevenshteinSimilarity(lineNormalized, blockNormalized)

            if (lineInBlock || blockInLine || lineInBlockNoSpaces || blockInLineNoSpaces || wordBagScore >= wordBagThreshold || similarity >= 0.75)
              matchingLines.push({ line, lineIdx })
          }

          // Add all matching lines to highlights
          if (matchingLines.length > 0) {
            console.log(`[PDF]       ✓ Found ${matchingLines.length} matching lines:`)

            for (const match of matchingLines) {
              console.log(`[PDF]           Line ${match.lineIdx + 1}: "${match.line.text.substring(0, 50)}..." @ y=${match.line.box.y1.toFixed(0)}`)

              // Add rect for this line
              const yOffset = (match.line.box.y2 - match.line.box.y1) * 0.15
              allMatchedRects.push({
                x1: match.line.box.x1,
                y1: match.line.box.y1 - yOffset,
                x2: match.line.box.x2,
                y2: match.line.box.y2 - yOffset,
                width: match.line.box.x2 - match.line.box.x1,
                height: match.line.box.y2 - match.line.box.y1,
                pageNumber: match.line.pageNumber,
              })

              // Update last matched position to maintain sequential order
              lastMatchedLineIdx = Math.max(lastMatchedLineIdx, match.lineIdx)
            }

            matchResults.push({
              blockIndex: blockIdx,
              linesMatched: matchingLines.length,
              matched: true,
            })
          }
          else {
            console.log('[PDF]       ✗ No matching lines found')
            matchResults.push({ blockIndex: blockIdx, linesMatched: 0, matched: false })
          }
        }

        // Calculate quality metrics
        const totalBlocks = chunkBlocks.length
        const matchedBlocks = matchResults.filter(r => r.matched).length
        const matchRate = totalBlocks > 0 ? matchedBlocks / totalBlocks : 0
        const totalLinesMatched = matchResults.reduce((sum, r) => sum + r.linesMatched, 0)

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
        console.log(`[PDF] Total Lines:       ${totalLinesMatched} PDF lines highlighted`)
        console.log(`[PDF] Coverage:          ${(coverageRate * 100).toFixed(1)}% of chunk chars`)
        console.log(`[PDF] Matched Rects:     ${allMatchedRects.length}`)
        console.log(`[PDF] ${'='.repeat(50)}\n`)

        if (allMatchedRects.length === 0) {
          console.log('[PDF] ⚠️ No matches found')
          return
        }

        // Use API page number first (from n8n), fallback to first matched rect's page only if needed
        const matchedPageNumbers = Array.from(new Set(allMatchedRects.map(r => r.pageNumber))).sort((a, b) => a - b)
        console.log(`[PDF] 📄 API page: ${pageNum}, Matched rects span pages: [${matchedPageNumbers.join(', ')}]`)

        // Create highlight - prioritize API page number
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
        // scrollTo is handled in separate useEffect after highlights render
      }
      catch (error: any) {
        console.error('[PDF] ❌ Highlight error:', error)
      }
    }

    findHighlights()
  }, [isFullyReady, chunkContext, pdfDocument, apiPageNumber, pageTextMap, normalizeWithSpaces, normalizeNoSpaces, wordBagMatch, calculateLevenshteinSimilarity])

  // Scroll to highlight AFTER it's rendered - this is the final step
  useEffect(() => {
    if (highlights.length === 0 || !scrollToRef.current) return

    const highlight = highlights[0]
    console.log(`[PDF] 📜 Scrolling to highlight on page ${highlight.position.pageNumber}...`)
    scrollToRef.current(highlight)
  }, [highlights])

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

            // Check if already added
            const exists = allTextItems.some(t =>
              t.pageNumber === pageNum && Math.abs(t.x - x) < 1 && Math.abs(t.y - y) < 1 && t.text === item.str,
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
            line.pageNumber === item.pageNumber && Math.abs(line.y - item.y) < 5,
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
              key={chunkId}
              pdfDocument={pdfDocument}
              onReady={handlePdfReady}
              _containerWidth={containerRef.current?.clientWidth || 600}
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
