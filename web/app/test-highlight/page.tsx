'use client'

import { useState, useEffect, useRef } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { PdfHighlighter, PdfLoader, Highlight } from 'react-pdf-highlighter'
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'

const PdfHighlighterWrapper = ({ pdfDocument }: { pdfDocument: any }) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [isScalingDone, setIsScalingDone] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const stabilityTimerRef = useRef<NodeJS.Timeout | null>(null)
  const searchText = 'Science News Article'

  const addLog = (msg: string) => setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`])

  // Watch for container size to stabilize (scaling complete)
  useEffect(() => {
    if (!containerRef.current) return

    addLog('👀 Watching for scaling to complete...')

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect

      // Clear previous timer
      if (stabilityTimerRef.current) {
        clearTimeout(stabilityTimerRef.current)
      }

      // Check if size changed
      if (width !== lastSizeRef.current.width || height !== lastSizeRef.current.height) {
        lastSizeRef.current = { width, height }
        addLog(`📐 Size changed: ${width.toFixed(0)}x${height.toFixed(0)}`)

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
      if (stabilityTimerRef.current) {
        clearTimeout(stabilityTimerRef.current)
      }
    }
  }, [])

  // Apply highlights only after scaling is done
  useEffect(() => {
    if (!isScalingDone) return

    const findTextHighlight = async () => {
      try {
        if (highlights.length > 0) return

        addLog('🚀 Starting PDF text extraction...')

        const page = await pdfDocument.getPage(1)
        const viewport = page.getViewport({ scale: 1.0 })

        const textContent = await page.getTextContent()
        const items = textContent.items as any[]
        addLog(`Page 1 loaded. Found ${items.length} text items.`)

        const normalize = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
        const searchNormalized = normalize(searchText)

        const matchedRects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []

        items.forEach((item: any) => {
          const itemStr = item.str.trim()
          if (!itemStr) return

          if (normalize(itemStr) === searchNormalized) {
            addLog(`Exact match found: "${item.str}"`)
            const [, , , scaleY, x, y] = item.transform

            const height = item.height || Math.abs(scaleY)
            const width = item.width

            const yOffset = height * 0.15
            matchedRects.push({
              x1: x,
              y1: y - yOffset,
              x2: x + width,
              y2: y + height - yOffset,
              width,
              height,
              pageNumber: 1,
            })
          }
        })

        if (matchedRects.length > 0) {
          addLog(`✅ Found ${matchedRects.length} rectangles. Creating highlight...`)

          const boundingRect = {
            x1: Math.min(...matchedRects.map(r => r.x1)),
            y1: Math.min(...matchedRects.map(r => r.y1)),
            x2: Math.max(...matchedRects.map(r => r.x2)),
            y2: Math.max(...matchedRects.map(r => r.y2)),
            width: viewport.width,
            height: viewport.height,
            pageNumber: 1,
          }

          const newHighlight: IHighlight = {
            id: 'auto-highlight-1',
            position: {
              boundingRect,
              rects: matchedRects,
              pageNumber: 1,
              usePdfCoordinates: true,
            } as ScaledPosition,
            content: { text: searchText },
            comment: { text: 'Auto-found', emoji: '🤖' },
          }

          setHighlights([newHighlight])
          addLog('🎉 Highlight applied!')
        }
        else {
          addLog('❌ No matches found.')
        }
      }
      catch (error: any) {
        console.error('Error:', error)
        addLog(`❌ Error: ${error.message}`)
      }
    }

    findTextHighlight()
  }, [pdfDocument, isScalingDone, highlights.length])

  return (
    <div className='flex h-full flex-col'>
      <div className='mb-4 rounded bg-gray-100 p-4'>
        <h1 className='mb-2 text-2xl font-bold'>PDF Highlighting Test</h1>
        <p>Searching: <strong>&quot;{searchText}&quot;</strong></p>
        <p className='text-sm text-gray-600'>
          Scaling: {isScalingDone ? '✅ Done' : '⏳ In progress...'} | Highlights: {highlights.length}
        </p>
        <div className='mt-2 max-h-32 overflow-y-auto rounded border border-gray-300 bg-white p-2 font-mono text-xs'>
          {debugLog.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
      </div>
      <div ref={containerRef} className='relative flex-1 border border-gray-300'>
        <PdfHighlighter
          pdfDocument={pdfDocument}
          enableAreaSelection={event => event.altKey}
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

export default function TestHighlightPage() {
  const pdfUrl = 'https://minio.toho.vn/n8n-document-ingestion/tropical/inbox/Tropical.pdf'

  return (
    <div className='h-screen w-full p-4'>
      <div className='h-[calc(100vh-50px)] w-full'>
        <PdfLoader
          url={pdfUrl}
          workerSrc='/pdf.worker.min.mjs'
          beforeLoad={<div className='flex h-64 items-center justify-center'>Loading PDF...</div>}
        >
          {pdfDocument => <PdfHighlighterWrapper pdfDocument={pdfDocument} />}
        </PdfLoader>
      </div>
    </div>
  )
}
