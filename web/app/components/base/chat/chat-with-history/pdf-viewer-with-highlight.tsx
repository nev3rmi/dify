import type { FC } from 'react'
import { useEffect, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { PdfHighlighter, PdfLoader } from 'react-pdf-highlighter'
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'
import Loading from '@/app/components/base/loading'
import { noop } from 'lodash-es'

type PdfViewerWithHighlightProps = {
  url: string
  searchText?: string
  pageNumber?: string
  onFullTextExtracted?: (fullText: string) => void
}

const PdfViewerWithHighlight: FC<PdfViewerWithHighlightProps> = ({
  url,
  searchText,
  pageNumber,
  onFullTextExtracted,
}) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([])

  // Extract text from PDF and create highlights
  useEffect(() => {
    if (!searchText || !pageNumber)
      return

    const extractAndHighlight = async () => {
      try {
        // Load PDF.js
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        // Load PDF document
        const loadingTask = pdfjsLib.getDocument(url)
        const pdf = await loadingTask.promise

        // Get the specific page
        const pageNum = Number.parseInt(pageNumber)
        const page = await pdf.getPage(pageNum)

        // Get viewport for coordinate scaling
        const viewport = page.getViewport({ scale: 1.0 })

        // Extract text content with positions
        const textContent = await page.getTextContent()

        // Build full text and track positions
        const items = textContent.items as any[]
        let fullText = ''
        const textPositions: Array<{ text: string; transform: number[]; width: number; height: number; index: number }> = []

        items.forEach((item) => {
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

        // Search for the chunk text
        let fullChunkText = searchText
        let searchStartText = searchText
        let searchEndText = searchText

        // Handle truncated format "ABC ... XYZ"
        if (searchText.includes('...')) {
          const parts = searchText.split('...')
          searchStartText = parts[0]?.trim() || ''
          searchEndText = parts[parts.length - 1]?.trim() || ''

          const startIndex = fullText.indexOf(searchStartText)
          const endIndex = fullText.indexOf(searchEndText, startIndex)

          if (startIndex !== -1 && endIndex !== -1)
            fullChunkText = fullText.substring(startIndex, endIndex + searchEndText.length).trim()
        }

        // Notify parent of full extracted text
        if (onFullTextExtracted)
          onFullTextExtracted(fullChunkText)

        // Find text positions for highlighting
        const chunkStartIndex = fullText.indexOf(searchStartText)
        const chunkEndIndex = fullText.indexOf(searchEndText, chunkStartIndex) + searchEndText.length

        if (chunkStartIndex !== -1 && chunkEndIndex > chunkStartIndex) {
          // Calculate bounding boxes for the matched text
          const rects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber: number }> = []

          textPositions.forEach((pos) => {
            const posEnd = pos.index + pos.text.length + 1

            // Check if this text item is within our highlight range
            if (pos.index >= chunkStartIndex && posEnd <= chunkEndIndex) {
              const [, , , , x, y] = pos.transform

              rects.push({
                x1: x,
                y1: viewport.height - y - pos.height,
                x2: x + pos.width,
                y2: viewport.height - y,
                width: pos.width,
                height: pos.height,
                pageNumber: pageNum,
              })
            }
          })

          // Create highlight if we found rectangles
          if (rects.length > 0) {
            const boundingRect = {
              x1: Math.min(...rects.map(r => r.x1)),
              y1: Math.min(...rects.map(r => r.y1)),
              x2: Math.max(...rects.map(r => r.x2)),
              y2: Math.max(...rects.map(r => r.y2)),
              width: viewport.width,
              height: viewport.height,
              pageNumber: pageNum,
            }

            const highlight: IHighlight = {
              id: `highlight-${Date.now()}`,
              position: {
                boundingRect,
                rects,
                pageNumber: pageNum,
              } as ScaledPosition,
              content: {
                text: fullChunkText,
              },
              comment: {
                text: '',
                emoji: '',
              },
            }

            setHighlights([highlight])
          }
        }
      }
      catch (error) {
        console.error('Error extracting PDF text:', error)
      }
    }

    extractAndHighlight()
  }, [url, searchText, pageNumber, onFullTextExtracted])

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
        {(pdfDocument) => {
          return (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              enableAreaSelection={() => false}
              scrollRef={noop}
              onScrollChange={noop}
              onSelectionFinished={() => null}
              highlightTransform={() => {
                return (
                  <div
                    className='absolute bg-yellow-200/40'
                    style={{
                      mixBlendMode: 'multiply',
                    }}
                  />
                )
              }}
              highlights={highlights}
            />
          )
        }}
      </PdfLoader>
    </div>
  )
}

export default PdfViewerWithHighlight
