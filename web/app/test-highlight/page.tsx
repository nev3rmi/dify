'use client'

import { useState, useEffect } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { PdfHighlighter, PdfLoader, Highlight } from 'react-pdf-highlighter'
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'
import { noop } from 'lodash-es'

const PdfHighlighterWrapper = ({ pdfDocument, pdfUrl }: { pdfDocument: any, pdfUrl: string }) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([])
  const [debugLog, setDebugLog] = useState<string[]>([])
  const searchText = 'Science News Article'

  const addLog = (msg: string) => setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`])

  useEffect(() => {
    const findTextHighlight = async () => {
      try {
        if (highlights.length > 0) return // Already found

        addLog('🚀 Starting PDF text extraction...')
        console.log('🔍 Searching for:', searchText)

        const page = await pdfDocument.getPage(1)
        const viewport = page.getViewport({ scale: 1.0 })

        const textContent = await page.getTextContent()
        const items = textContent.items as any[]
        addLog(`Page 1 loaded. Found ${items.length} text items.`)

        // Normalize search text
        const normalize = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
        const searchNormalized = normalize(searchText)

        const matchedRects: Array<{ x1: number, y1: number, x2: number, y2: number, width: number, height: number, pageNumber: number }> = []

        // Find items that match - looking for exact phrase match
        items.forEach((item: any) => {
          const itemStr = item.str.trim()
          if (!itemStr) return

          const itemNormalized = normalize(itemStr)

          // Only match if this item contains the COMPLETE search phrase
          if (itemNormalized === searchNormalized) {
            addLog(`Exact match found: "${item.str}"`)
            const [scaleX, , , scaleY, x, y] = item.transform

            // Use scaleY (font size) for height if item.height is not reliable
            const height = item.height || Math.abs(scaleY)
            const width = item.width

            // react-pdf-highlighter expects PDF coordinates at scale 1.0
            // Adjust y down by adding an offset (text baseline adjustment)
            const yOffset = height * 0.15
            const x1 = x
            const y1 = y - yOffset
            const x2 = x + width
            const y2 = y + height - yOffset

            addLog(`PDF Coords: x1=${x1.toFixed(2)}, y1=${y1.toFixed(2)}, x2=${x2.toFixed(2)}, y2=${y2.toFixed(2)}`)

            matchedRects.push({
              x1,
              y1,
              x2,
              y2,
              width,
              height,
              pageNumber: 1
            })
          }
        })

        if (matchedRects.length > 0) {
          addLog(`✅ Found ${matchedRects.length} matching rectangles. Creating highlight.`)
          console.log('✅ Found matches:', matchedRects)

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
              usePdfCoordinates: true,  // Tell the library we're using PDF coordinates!
            } as ScaledPosition,
            content: { text: searchText },
            comment: { text: 'Auto-found', emoji: '🤖' },
          }

          setHighlights([newHighlight])
        } else {
          addLog('❌ No matches found for search text.')
        }
      } catch (error: any) {
        console.error('Error finding highlights:', error)
        addLog(`❌ Error: ${error.message}`)
      }
    }

    findTextHighlight()
  }, [pdfDocument, searchText, highlights.length])

  return (
    <div className='flex h-full flex-col'>
      <div className='mb-4 rounded bg-gray-100 p-4'>
        <h1 className='mb-2 text-2xl font-bold'>PDF Highlighting Test</h1>
        <p>Testing react-pdf-highlighter@8.0.0-rc.0</p>
        <p>Searching and highlighting text: <strong>"{searchText}"</strong></p>
        <div className='mt-2 max-h-32 overflow-y-auto rounded border border-gray-300 bg-white p-2 text-xs font-mono'>
          {debugLog.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
      </div>
      <div className='relative flex-1 border border-gray-300'>
        <PdfHighlighter
          pdfDocument={pdfDocument}
          enableAreaSelection={(event) => event.altKey}
          scrollRef={noop}
          onScrollChange={noop}
          pdfScaleValue="1"
          onSelectionFinished={(position, content, hideTipAndSelection, transformSelection) => {
            console.log('Selection made:', position)
            return (
              <Highlight
                isScrolledTo={false}
                position={position}
                comment={{ text: 'New selection', emoji: '' }}
              />
            )
          }}
          highlightTransform={(highlight, index, setTip, hideTip, viewportToScaled, screenshot, isScrolledTo) => {
            return (
              <Highlight
                key={index}
                isScrolledTo={isScrolledTo}
                position={highlight.position}
                comment={highlight.comment}
              />
            )
          }}
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
          {(pdfDocument) => (
            <PdfHighlighterWrapper pdfDocument={pdfDocument} pdfUrl={pdfUrl} />
          )}
        </PdfLoader>
      </div>
    </div>
  )
}
