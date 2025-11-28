import type { FC } from 'react'
import { useEffect, useState } from 'react'
import 'react-pdf-highlighter/dist/style.css'
import { PdfHighlighter, PdfLoader, Highlight } from 'react-pdf-highlighter'
import type { IHighlight, ScaledPosition } from 'react-pdf-highlighter'
import Loading from '@/app/components/base/loading'
import { noop } from 'lodash-es'

type PdfViewerWithHighlightProps = {
  url: string
  searchText?: string
  pageNumber?: string
  onFullTextExtracted?: (fullText: string) => void
}

type PdfHighlighterWrapperProps = {
  pdfDocument: any
  searchText?: string
  pageNumber?: string
  onFullTextExtracted?: (fullText: string) => void
}

const PdfHighlighterWrapper: FC<PdfHighlighterWrapperProps> = ({
  pdfDocument,
  searchText,
  pageNumber,
  onFullTextExtracted,
}) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([])

  useEffect(() => {
    const findTextHighlight = async () => {
      try {
        if (!searchText || highlights.length > 0) return

        const pageNum = pageNumber ? Number.parseInt(pageNumber) : 1
        const page = await pdfDocument.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.0 })

        const textContent = await page.getTextContent()
        const items = textContent.items as any[]

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

        // Normalize text for better matching
        const normalizeText = (text: string) => text
          .replace(/['']/g, '\'')
          .replace(/[""]/g, '"')
          .replace(/\s+/g, ' ')
          .trim()

        const normalizedFullText = normalizeText(fullText)

        // Handle truncated format "ABC ... XYZ"
        let fullChunkText = searchText
        let searchStartText = searchText
        let searchEndText = searchText

        if (searchText.includes('...')) {
          const parts = searchText.split('...')
          const startWords = parts[0]?.trim().split(' ').slice(0, 7).join(' ') || ''
          const endWords = parts[parts.length - 1]?.trim() || ''
          searchStartText = normalizeText(startWords)
          searchEndText = normalizeText(endWords)

          const startIndex = normalizedFullText.indexOf(searchStartText)
          const endIndex = normalizedFullText.indexOf(searchEndText, startIndex)

          if (startIndex !== -1 && endIndex !== -1)
            fullChunkText = fullText.substring(startIndex, endIndex + searchEndText.length).trim()
        }

        // Notify parent of full extracted text
        if (onFullTextExtracted)
          onFullTextExtracted(fullChunkText)

        // Find text positions for highlighting
        const normalizedSearchStart = normalizeText(searchStartText)
        const normalizedSearchEnd = normalizeText(searchEndText)
        const chunkStartIndex = normalizedFullText.indexOf(normalizedSearchStart)
        const chunkEndIndex = normalizedFullText.indexOf(normalizedSearchEnd, chunkStartIndex) + normalizedSearchEnd.length

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

            // Check if this text item is within our highlight range
            if (pos.index >= chunkStartIndex && posEnd <= chunkEndIndex) {
              const [scaleX, , , scaleY, x, y] = pos.transform
              const height = pos.height || Math.abs(scaleY)
              const width = pos.width

              // Use PDF coordinates with baseline adjustment
              const yOffset = height * 0.15
              const x1 = x
              const y1 = y - yOffset
              const x2 = x + width
              const y2 = y + height - yOffset

              matchedRects.push({
                x1,
                y1,
                x2,
                y2,
                width,
                height,
                pageNumber: pageNum,
              })
            }
          })

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
          }
        }
      }
      catch (error) {
        console.error('Error finding highlights:', error)
      }
    }

    findTextHighlight()
  }, [pdfDocument, searchText, pageNumber, highlights.length, onFullTextExtracted])

  return (
    <PdfHighlighter
      pdfDocument={pdfDocument}
      enableAreaSelection={() => false}
      scrollRef={noop}
      onScrollChange={noop}
      pdfScaleValue="1"
      onSelectionFinished={() => null}
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
  )
}

const PdfViewerWithHighlight: FC<PdfViewerWithHighlightProps> = ({
  url,
  searchText,
  pageNumber,
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
        {(pdfDocument) => (
          <PdfHighlighterWrapper
            pdfDocument={pdfDocument}
            searchText={searchText}
            pageNumber={pageNumber}
            onFullTextExtracted={onFullTextExtracted}
          />
        )}
      </PdfLoader>
    </div>
  )
}

export default PdfViewerWithHighlight
