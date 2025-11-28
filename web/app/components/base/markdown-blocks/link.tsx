/**
 * @fileoverview Link component for rendering <a> tags in Markdown.
 * Extracted from the main markdown renderer for modularity.
 * Handles special rendering for "abbr:" type links for interactive chat actions.
 */
import React from 'react'
import { useChatContext } from '@/app/components/base/chat/chat/context'
import { useChatWithHistoryContext } from '@/app/components/base/chat/chat-with-history/context'
import { isValidUrl } from './utils'

// Check if URL is a previewable file from minio.toho.vn
const isPreviewableMinioUrl = (url: string): boolean => {
  if (!url.includes('minio.toho.vn'))
    return false
  return /\.(png|jpg|jpeg|gif|webp|svg|pdf)$/i.test(url)
}

// Extract text content from React children
const extractTextFromChildren = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('')
  if (children && typeof children === 'object' && 'props' in children)
    return extractTextFromChildren((children as React.ReactElement).props.children)

  return ''
}

// Parse citation format: "Tropical.pdf - Page 3 - Chunk 47 - [Source text...]"
const parseCitation = (text: string) => {
  const citationRegex = /^(.+?\.pdf)\s*-\s*Page\s*(\d+)\s*-\s*Chunk\s*(\d+)\s*-\s*\[(.+)\]$/i
  const match = text.match(citationRegex)

  if (match) {
    return {
      filename: match[1],
      pageNumber: match[2],
      chunkId: match[3],
      sourceText: match[4],
    }
  }

  return null
}

const Link = ({ node, children, ...props }: any) => {
  const { onSend } = useChatContext()
  // Get preview context (returns default noop if no provider)
  const { setPreviewData } = useChatWithHistoryContext()

  const commonClassName = 'cursor-pointer underline !decoration-primary-700 decoration-dashed'
  if (node.properties?.href && node.properties.href?.toString().startsWith('abbr')) {
    const hidden_text = decodeURIComponent(node.properties.href.toString().split('abbr:')[1])

    return <abbr className={commonClassName} onClick={() => onSend?.(hidden_text)} title={node.children[0]?.value || ''}>{node.children[0]?.value || ''}</abbr>
  }
  else {
    const href = props.href || node.properties?.href
    if (href && /^#[a-zA-Z0-9_-]+$/.test(href.toString())) {
      const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        // scroll to target element if exists within the answer container
        const answerContainer = e.currentTarget.closest('.chat-answer-container')

        if (answerContainer) {
          const targetId = CSS.escape(href.toString().substring(1))
          const targetElement = answerContainer.querySelector(`[id="${targetId}"]`)
          targetElement?.scrollIntoView({ behavior: 'smooth' })
        }
      }
      return <a href={href} onClick={handleClick} className={commonClassName}>{children || 'ScrollView'}</a>
    }

    if (!href || !isValidUrl(href))
      return <span>{children}</span>

    // Check if this is a previewable minio.toho.vn file
    if (isPreviewableMinioUrl(href.toString())) {
      const handlePreviewClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()

        // Extract link text
        const linkText = extractTextFromChildren(children)

        // Try to parse citation format
        const citation = parseCitation(linkText)

        if (citation) {
          // Citation format detected - use page number and parsed source text
          const urlWithPage = `${href.toString()}#page=${citation.pageNumber}`
          setPreviewData({
            url: urlWithPage,
            sourceText: citation.sourceText,
            pageNumber: citation.pageNumber,
            filename: citation.filename,
            chunkId: citation.chunkId,
          })
        }
        else {
          // Fallback: use link text as source text
          setPreviewData({
            url: href.toString(),
            sourceText: linkText || undefined,
          })
        }
      }
      return <a href={href} onClick={handlePreviewClick} className={`${commonClassName} text-primary-600`}>{children || 'Preview'}</a>
    }

    return <a href={href} target="_blank" rel="noopener noreferrer" className={commonClassName}>{children || 'Download'}</a>
  }
}

export default Link
