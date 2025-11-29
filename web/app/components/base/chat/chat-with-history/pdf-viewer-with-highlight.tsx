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
        addLog('🚀 Computing highlights...')

        const pageNum = apiPageNumber || (pageNumber ? Number.parseInt(pageNumber) : 1)
        const page = await pdfDocument.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.0 })

        const textContent = await page.getTextContent()
        const items = textContent.items as any[]
        addLog(`📄 Page ${pageNum}: ${items.length} text items`)

        const normalizeText = (text: string) => text
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()

        let fullText = ''
        let normalizedText = ''
        const textPositions: Array<{
          text: string
          transform: number[]
          width: number
          height: number
          index: number
          normalizedIndex: number
        }> = []

        items.forEach((item: any) => {
          if (item.str) {
            const normalizedItem = normalizeText(item.str)
            textPositions.push({
              text: item.str,
              transform: item.transform,
              width: item.width,
              height: item.height,
              index: fullText.length,
              normalizedIndex: normalizedText.length,
            })
            fullText += `${item.str} `
            normalizedText += `${normalizedItem} `
          }
        })

        const normalizedFullText = normalizeText(fullText)

        const lines = textToSearch.split('\n').filter(l => l.trim().length > 10)
        if (lines.length === 0)
          lines.push(textToSearch)

        const anchorLine = lines.reduce((a, b) => a.length > b.length ? a : b)
        const anchorNormalized = normalizeText(anchorLine)

        const anchorIndex = normalizedFullText.indexOf(anchorNormalized)
        let anchorY = 0
        let anchorFound = false

        if (anchorIndex !== -1) {
          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            if (anchorNormalized.includes(posNormalized) && posNormalized.length > 3) {
              anchorY = pos.transform[5]
              anchorFound = true
              break
            }
          }
        }

        if (!anchorFound) {
          const anchorFirstWord = anchorNormalized.split(' ')[0]
          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            if (posNormalized.includes(anchorFirstWord) || calculateSimilarity(posNormalized, anchorNormalized) > 0.6) {
              anchorY = pos.transform[5]
              anchorFound = true
              break
            }
          }
        }

        const PROXIMITY_THRESHOLD = 300
        const matchedRects: Array<{
          x1: number
          y1: number
          x2: number
          y2: number
          width: number
          height: number
          pageNumber: number
        }> = []

        const addRect = (pos: typeof textPositions[0], pNum: number) => {
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
              pageNumber: pNum,
            })
          }
        }

        const matchedLines = new Set<number>()

        // First pass: Full sentence matching
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]
          const lineNormalized = normalizeText(line)

          if (lineNormalized.length < 20)
            continue

          const sentenceIndex = normalizedFullText.indexOf(lineNormalized)

          if (sentenceIndex !== -1) {
            matchedLines.add(lineIdx)
            const sentenceEnd = sentenceIndex + lineNormalized.length

            for (const pos of textPositions) {
              const posY = pos.transform[5]
              if (anchorFound && Math.abs(posY - anchorY) > PROXIMITY_THRESHOLD)
                continue

              const posStart = pos.normalizedIndex
              const posEnd = pos.normalizedIndex + normalizeText(pos.text).length + 1
              const hasOverlap = posStart < sentenceEnd + 5 && posEnd > sentenceIndex - 2

              if (hasOverlap)
                addRect(pos, pageNum)
            }
          }
        }

        // Second pass: Fragment matching
        const SIMILARITY_THRESHOLD = 0.80

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (matchedLines.has(lineIdx))
            continue

          const line = lines[lineIdx]
          const lineNormalized = normalizeText(line)
          const lineWords = lineNormalized.split(' ').filter(w => w.length >= 6)

          for (const pos of textPositions) {
            const posNormalized = normalizeText(pos.text)
            const posY = pos.transform[5]

            if (anchorFound && Math.abs(posY - anchorY) > PROXIMITY_THRESHOLD)
              continue

            if (posNormalized.length < 3)
              continue

            let isMatch = false

            if (posNormalized.length >= 5 && lineNormalized.includes(posNormalized))
              isMatch = true

            if (!isMatch && posNormalized.length >= 15) {
              const similarity = calculateSimilarity(posNormalized, lineNormalized)
              if (similarity >= SIMILARITY_THRESHOLD)
                isMatch = true
            }

            if (!isMatch && lineWords.length >= 2) {
              const matchingWords = lineWords.filter(word => posNormalized.includes(word))
              if (matchingWords.length >= 2)
                isMatch = true
            }

            if (isMatch)
              addRect(pos, pageNum)
          }
        }

        // Third pass: Fill gaps
        if (matchedRects.length > 0) {
          const minY = Math.min(...matchedRects.map(r => r.y1))
          const maxY = Math.max(...matchedRects.map(r => r.y2))

          for (const pos of textPositions) {
            const posText = normalizeText(pos.text)
            const [, , , scaleY, , y] = pos.transform
            const height = pos.height || Math.abs(scaleY)

            if (posText.length < 2)
              continue

            const posTop = y - height * 0.15
            const posBottom = y + height - height * 0.15

            if (posTop >= minY - 5 && posBottom <= maxY + 5)
              addRect(pos, pageNum)
          }
        }

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
          addLog('🎉 Highlights computed!')
        }

        // Next step: viewer ready
        setPipelineStep('viewer_ready')
      }
      catch (error: any) {
        console.error('Error finding highlights:', error)
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
