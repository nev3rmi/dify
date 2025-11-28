import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { PdfHighlighter, PdfLoader, Highlight } from 'react-pdf-highlighter'
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
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [fullChunkContext, setFullChunkContext] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const stabilityTimerRef = useRef<NodeJS.Timeout | null>(null)

  const addLog = (msg: string) => setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`])

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
          if (onFullTextExtracted) {
            onFullTextExtracted(data.chunk_context)
          }
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

  // Watch for container size to stabilize (scaling complete)
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

        // Wait 300ms after last resize to consider scaling done
        stabilityTimerRef.current = setTimeout(() => {
          addLog('✅ Scaling complete!')
          setIsScalingDone(true)
          observer.disconnect()
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
        if (highlights.length > 0) return

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

        // Use first 4-6 words from the context/search text
        const searchQuery = textToSearch.split('...')[0]?.trim() || textToSearch
        const searchWords = normalizeText(searchQuery).split(' ').slice(0, 6).join(' ')
        addLog(`🔎 Searching: "${searchWords.substring(0, 50)}..."`)

        // Find start in PDF
        let chunkStartIndex = normalizedFullText.indexOf(searchWords)

        // Fallback: try fewer words
        if (chunkStartIndex === -1) {
          const fewerWords = normalizeText(searchQuery).split(' ').slice(0, 3).join(' ')
          chunkStartIndex = normalizedFullText.indexOf(fewerWords)
          if (chunkStartIndex !== -1) {
            addLog(`🔄 Fallback matched with 3 words`)
          }
        }

        // Find end using last words of context
        let chunkEndIndex = -1
        if (chunkStartIndex !== -1) {
          const endWords = normalizeText(textToSearch).split(' ').slice(-4).join(' ')
          const endIdx = normalizedFullText.indexOf(endWords, chunkStartIndex)

          if (endIdx !== -1) {
            chunkEndIndex = endIdx + endWords.length
          }
          else {
            // Default: use length of search text or 300 chars
            chunkEndIndex = chunkStartIndex + Math.min(textToSearch.length, 500)
          }
          addLog(`✅ Found at ${chunkStartIndex}-${chunkEndIndex}`)
        }
        else {
          addLog(`❌ Text not found in PDF`)
        }

        // Note: Full text is now fetched from API and sent via onFullTextExtracted there

        if (chunkStartIndex !== -1 && chunkEndIndex > chunkStartIndex) {
          const matchedRects: Array<{
            x1: number
            y1: number
            x2: number
            y2: number
            width: number
            height: number
            pageNumber: number
          }> = []

          textPositions.forEach((pos) => {
            const posEnd = pos.index + pos.text.length + 1

            if (pos.index >= chunkStartIndex && posEnd <= chunkEndIndex) {
              const [, , , scaleY, x, y] = pos.transform
              const height = pos.height || Math.abs(scaleY)
              const width = pos.width

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
          })

          addLog(`📦 Found ${matchedRects.length} rects`)

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
              content: { text: fullChunkText },
              comment: { text: '', emoji: '' },
            }

            setHighlights([newHighlight])
            addLog('🎉 Highlight applied!')
          }
          else {
            addLog('❌ No rects to highlight')
          }
        }
        else {
          addLog('❌ Text not found in PDF')
        }
      }
      catch (error: any) {
        console.error('Error finding highlights:', error)
        addLog(`❌ Error: ${error.message}`)
      }
    }

    findTextHighlight()
  }, [pdfDocument, searchText, pageNumber, highlights.length, onFullTextExtracted, isScalingDone, fullChunkContext])

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
          scrollRef={() => {}}
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
