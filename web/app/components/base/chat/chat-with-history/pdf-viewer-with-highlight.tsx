import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { Highlight, PdfHighlighter, PdfLoader } from 'react-pdf-highlighter'
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

const PdfHighlighterWrapper: FC<PdfHighlighterWrapperProps> = ({
  pdfDocument,
  searchText,
  pageNumber,
  chunkId,
  onFullTextExtracted,
}) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [isScalingDone, setIsScalingDone] = useState(false)
  const [fullChunkContext, setFullChunkContext] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const stabilityTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Similarity score function (0-1, where 1 is exact match)
  const calculateSimilarity = (str1: string, str2: string): number => {
    if (str1 === str2) return 1
    if (str1.length === 0 || str2.length === 0) return 0

    // Simple character-based similarity (Dice coefficient)
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
  }

  // Debug logging (uncomment for debugging)
  // const [debugLog, setDebugLog] = useState<string[]>([])
  // const addLog = (msg: string) => setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`])
  // eslint-disable-next-line no-empty-function
  const addLog = (_msg: string) => {} // No-op for production

  // Reset highlights when citation changes (chunkId or pageNumber)
  // This allows new highlights to be applied for the new citation
  useEffect(() => {
    addLog('🔄 Citation changed, clearing highlights...')
    setHighlights([])
    setFullChunkContext(null)
  }, [chunkId, pageNumber])

  // Fetch full chunk context from API
  useEffect(() => {
    if (!chunkId) {
      addLog('⚠️ No chunkId provided')
      return
    }

    const fetchChunkContext = async () => {
      try {
        addLog(`📡 Fetching chunk ${chunkId}...`)
        const response = await fetch(`${CHUNK_API_URL}?chunkID=${chunkId}`)
        const data = await response.json()

        if (data.chunk_context) {
          setFullChunkContext(data.chunk_context)
          addLog(`✅ Got chunk: "${data.chunk_context.substring(0, 50)}..."`)

          // Notify parent with the full text from API
          if (onFullTextExtracted)
            onFullTextExtracted(data.chunk_context)
        }
        else {
          addLog('❌ No chunk_context in response')
        }
      }
      catch (error: any) {
        addLog(`❌ API error: ${error.message}`)
      }
    }

    fetchChunkContext()
  }, [chunkId, onFullTextExtracted])

  // Watch for container size changes and re-apply highlights on rescale
  useEffect(() => {
    if (!containerRef.current) return

    addLog('👀 Watching for scaling...')

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect

      if (stabilityTimerRef.current)
        clearTimeout(stabilityTimerRef.current)

      if (width !== lastSizeRef.current.width || height !== lastSizeRef.current.height) {
        lastSizeRef.current = { width, height }
        addLog(`📐 Size: ${width.toFixed(0)}x${height.toFixed(0)}`)

        // Clear highlights during resize so they can be re-applied
        setHighlights([])
        setIsScalingDone(false)

        // Wait 300ms after last resize to consider scaling done
        stabilityTimerRef.current = setTimeout(() => {
          addLog('✅ Scaling complete!')
          setIsScalingDone(true)
          // Don't disconnect - keep watching for future resizes
        }, 300)
      }
    })

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      if (stabilityTimerRef.current)
        clearTimeout(stabilityTimerRef.current)
    }
  }, [])

  // Apply highlights only after scaling is done AND we have context
  useEffect(() => {
    // Use fullChunkContext if available, otherwise fall back to searchText
    const textToSearch = fullChunkContext || searchText
    if (!isScalingDone || !textToSearch) return

    const findTextHighlight = async () => {
      try {
        // Removed: if (highlights.length > 0) return
        // Now re-applies highlights on each rescale

        addLog('🚀 Starting text extraction...')
        addLog(`🔍 Using: ${fullChunkContext ? 'Full chunk context' : 'Search text'}`)

        const pageNum = pageNumber ? Number.parseInt(pageNumber) : 1
        const page = await pdfDocument.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.0 })

        const textContent = await page.getTextContent()
        const items = textContent.items as any[]
        addLog(`📄 Page ${pageNum}: ${items.length} text items`)

        // Build full text and track positions
        let fullText = ''
        const textPositions: Array<{
          text: string
          transform: number[]
          width: number
          height: number
          index: number
        }> = []

        items.forEach((item: any) => {
          if (item.str) {
            textPositions.push({
              text: item.str,
              transform: item.transform,
              width: item.width,
              height: item.height,
              index: fullText.length,
            })
            fullText += `${item.str} `
          }
        })

        // Simple normalize - just lowercase and normalize spaces
        const normalizeText = (text: string) => text
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()

        const normalizedFullText = normalizeText(fullText)
        addLog(`📝 PDF: "${fullText.substring(0, 60)}..."`)

        // === LINE-BY-LINE ANCHOR-BASED MATCHING ===
        // Split source text into lines (filter out short lines to avoid false matches)
        const lines = textToSearch.split('\n').filter(l => l.trim().length > 10)
        addLog(`📝 Source has ${lines.length} lines to match`)

        if (lines.length === 0) {
          // Fallback: treat entire text as one line if no newlines
          lines.push(textToSearch)
        }

        // Find anchor line (longest line - most likely to be unique)
        const anchorLine = lines.reduce((a, b) => a.length > b.length ? a : b)
        const anchorNormalized = normalizeText(anchorLine)
        addLog(`⚓ Anchor: "${anchorLine.substring(0, 50)}..."`)

        // Find anchor position in PDF
        const anchorIndex = normalizedFullText.indexOf(anchorNormalized)
        let anchorY = 0
        let anchorFound = false

        // Try to find anchor in text positions
        if (anchorIndex !== -1) {
          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            if (anchorNormalized.includes(posNormalized) && posNormalized.length > 3) {
              anchorY = pos.transform[5]
              anchorFound = true
              addLog(`✅ Anchor found at Y=${anchorY.toFixed(0)}`)
              break
            }
          }
        }

        // Fallback: try fuzzy match on anchor
        if (!anchorFound) {
          const anchorFirstWord = anchorNormalized.split(' ')[0]
          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            // Check if first word matches or high similarity
            if (posNormalized.includes(anchorFirstWord) || calculateSimilarity(posNormalized, anchorNormalized) > 0.6) {
              anchorY = pos.transform[5]
              anchorFound = true
              addLog(`🔄 Anchor fallback at Y=${anchorY.toFixed(0)}`)
              break
            }
          }
        }

        // Proximity threshold: how far (in PDF units) from anchor to consider a match
        const PROXIMITY_THRESHOLD = 300

        // Collect all matched rectangles
        const matchedRects: Array<{
          x1: number
          y1: number
          x2: number
          y2: number
          width: number
          height: number
          pageNumber: number
        }> = []

        // Helper function to add a rect if not duplicate
        const addRect = (pos: typeof textPositions[0], pageNum: number) => {
          const [, , , scaleY, x, y] = pos.transform
          const height = pos.height || Math.abs(scaleY)
          const width = pos.width

          const isDuplicate = matchedRects.some(r =>
            Math.abs(r.x1 - x) < 1 && Math.abs(r.y1 - y) < 1,
          )

          if (!isDuplicate && width > 0) {
            const yOffset = height * 0.15
            matchedRects.push({
              x1: x,
              y1: y - yOffset,
              x2: x + width,
              y2: y + height - yOffset,
              width,
              height,
              pageNumber: pageNum,
            })
          }
        }

        // Track which lines were matched in first pass
        const matchedLines = new Set<number>()

        // ============ FIRST PASS: Full sentence matching (strict) ============
        // Try to find each full sentence in the concatenated PDF text
        addLog('📝 First pass: Full sentence matching...')

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]
          const lineNormalized = normalizeText(line)

          // Skip very short lines
          if (lineNormalized.length < 20)
            continue

          // Check if this full sentence exists in the PDF text
          const sentenceIndex = normalizedFullText.indexOf(lineNormalized)

          if (sentenceIndex !== -1) {
            matchedLines.add(lineIdx)
            addLog(`✅ Line ${lineIdx + 1} matched fully`)

            // Find all text positions that fall within this sentence range
            const sentenceEnd = sentenceIndex + lineNormalized.length

            for (const pos of textPositions) {
              const posY = pos.transform[5]

              // Skip if too far from anchor
              if (anchorFound && Math.abs(posY - anchorY) > PROXIMITY_THRESHOLD)
                continue

              // Check if this text item overlaps with the sentence position
              const posStart = pos.index
              const posEnd = pos.index + pos.text.length

              if (posStart >= sentenceIndex && posEnd <= sentenceEnd + 5)
                addRect(pos, pageNum)
            }
          }
        }

        // ============ SECOND PASS: Fragment matching for unmatched lines ============
        addLog(`📝 Second pass: Fragment matching for ${lines.length - matchedLines.size} unmatched lines...`)

        const SIMILARITY_THRESHOLD = 0.80

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          // Skip lines that matched in first pass
          if (matchedLines.has(lineIdx))
            continue

          const line = lines[lineIdx]
          const lineNormalized = normalizeText(line)
          const lineWords = lineNormalized.split(' ').filter(w => w.length >= 6)

          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            const posY = pos.transform[5]

            // Skip if too far from anchor
            if (anchorFound && Math.abs(posY - anchorY) > PROXIMITY_THRESHOLD)
              continue

            // Skip very short text items
            if (posNormalized.length < 3)
              continue

            let isMatch = false

            // Strategy 1: PDF fragment (5+ chars) is contained in source line
            if (posNormalized.length >= 5 && lineNormalized.includes(posNormalized))
              isMatch = true

            // Strategy 2: Fuzzy similarity for longer PDF items (15+ chars)
            if (!isMatch && posNormalized.length >= 15) {
              const similarity = calculateSimilarity(posNormalized, lineNormalized)
              if (similarity >= SIMILARITY_THRESHOLD)
                isMatch = true
            }

            // Strategy 3: Multiple unique words (6+ chars) match
            if (!isMatch && lineWords.length >= 2) {
              const matchingWords = lineWords.filter(word => posNormalized.includes(word))
              if (matchingWords.length >= 2)
                isMatch = true
            }

            if (isMatch)
              addRect(pos, pageNum)
          }
        }

        // ============ THIRD PASS: Fill gaps between first and last match ============
        // If we have matches, highlight everything between the first and last Y position
        if (matchedRects.length > 0) {
          addLog('📝 Third pass: Filling gaps between matches...')

          const minY = Math.min(...matchedRects.map(r => r.y1))
          const maxY = Math.max(...matchedRects.map(r => r.y2))

          for (const pos of textPositions) {
            const posText = normalizeText(pos.text)
            const [, , , scaleY, , y] = pos.transform
            const height = pos.height || Math.abs(scaleY)

            // Skip very short or empty text
            if (posText.length < 2)
              continue

            // Check if this text item is between the first and last match (by Y position)
            // Add some tolerance for line height
            const posTop = y - height * 0.15
            const posBottom = y + height - height * 0.15

            if (posTop >= minY - 5 && posBottom <= maxY + 5) {
              // This text is in the range, add it if not already added
              addRect(pos, pageNum)
            }
          }
        }

        addLog(`📦 Found ${matchedRects.length} rects from ${lines.length} lines`)

        if (matchedRects.length > 0) {
          const boundingRect = {
            x1: Math.min(...matchedRects.map(r => r.x1)),
            y1: Math.min(...matchedRects.map(r => r.y1)),
            x2: Math.max(...matchedRects.map(r => r.x2)),
            y2: Math.max(...matchedRects.map(r => r.y2)),
            width: viewport.width,
            height: viewport.height,
            pageNumber: pageNum,
          }

          const newHighlight: IHighlight = {
            id: `highlight-${Date.now()}`,
            position: {
              boundingRect,
              rects: matchedRects,
              pageNumber: pageNum,
              usePdfCoordinates: true,
            } as ScaledPosition,
            content: { text: textToSearch },
            comment: { text: '', emoji: '' },
          }

          setHighlights([newHighlight])
          addLog('🎉 Highlight applied!')
        }
        else {
          addLog('❌ No matching rects found')
        }
      }
      catch (error: any) {
        console.error('Error finding highlights:', error)
        addLog(`❌ Error: ${error.message}`)
      }
    }

    findTextHighlight()
  }, [pdfDocument, searchText, pageNumber, isScalingDone, fullChunkContext, calculateSimilarity])

  return (
    <div className='flex h-full w-full flex-col'>
      {/* Debug Panel - uncomment to debug
      <div className='shrink-0 border-b border-gray-200 bg-gray-50 p-2'>
        <div className='flex items-center gap-2 text-xs'>
          <span className='font-medium'>Debug:</span>
          <span>Scaling: {isScalingDone ? '✅' : '⏳'}</span>
          <span>Highlights: {highlights.length}</span>
        </div>
        <div className='mt-1 max-h-20 overflow-y-auto rounded border border-gray-200 bg-white p-1 font-mono text-xs'>
          {debugLog.map((log, i) => (
            <div key={i} className='text-gray-600'>{log}</div>
          ))}
        </div>
      </div>
      */}
      {/* PDF Viewer */}
      <div ref={containerRef} className='min-h-0 flex-1'>
        <PdfHighlighter
          pdfDocument={pdfDocument}
          enableAreaSelection={() => false}
          // eslint-disable-next-line no-empty-function
          scrollRef={() => {}}
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
          highlights={highlights}
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
