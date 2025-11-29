import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import './pdf-viewer-fix.css'
import { PdfHighlighter, PdfLoader } from 'react-pdf-highlighter'
import Loading from '@/app/components/base/loading'

type PdfViewerWithHighlightProps = {
  url: string
  searchText?: string
  pageNumber?: string
  chunkId?: string
  onFullTextExtracted?: (fullText: string) => void
}

const CHUNK_API_URL = 'https://n8n.toho.vn/webhook/dbf0d2ae-ec68-4827-bdb7-f5dec29c2b1d'

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
}

const PdfHighlighterStable: FC<PdfHighlighterStableProps> = ({ pdfDocument, onReady, containerWidth }) => {
  const hasCalledReady = useRef(false)
  const hasRendered = useRef(false)
  const [scale, setScale] = useState<string | null>(null)

  console.log('[PDF] PdfHighlighterStable render, hasRendered:', hasRendered.current)

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

  // Memoize callbacks to prevent PdfHighlighter re-renders
  const enableAreaSelection = useCallback(() => false, [])
  const scrollRef = useCallback(() => {}, [])
  const onScrollChange = useCallback(() => {}, [])
  const onSelectionFinished = useCallback(() => null, [])
  const highlightTransform = useCallback(() => null, [])

  // Memoize PdfHighlighter to prevent React createRoot() error
  // IMPORTANT: Must be before conditional returns (Rules of Hooks)
  const pdfHighlighter = useMemo(() => {
    if (scale === null) return null

    return (
      <PdfHighlighter
        pdfDocument={pdfDocument}
        enableAreaSelection={enableAreaSelection}
        scrollRef={scrollRef}
        onScrollChange={onScrollChange}
        pdfScaleValue={scale}
        onSelectionFinished={onSelectionFinished}
        highlightTransform={highlightTransform}
        highlights={[]}
      />
    )
  }, [pdfDocument, scale, enableAreaSelection, scrollRef, onScrollChange, onSelectionFinished, highlightTransform])

  // Don't render PDF until scale is calculated - prevents initial render at wrong scale
  if (scale === null) {
    return <div className="h-full w-full" />
  }

  if (!hasRendered.current) {
    hasRendered.current = true
    console.log('[PDF] First render of PdfHighlighter with scale:', scale)
  }

  return pdfHighlighter
}

export default PdfViewerWithHighlight
