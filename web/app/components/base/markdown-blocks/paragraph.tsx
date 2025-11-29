/**
 * @fileoverview Paragraph component for rendering <p> tags in Markdown.
 * Uses <div> instead of <p> to avoid hydration errors when images are present,
 * since images render as block elements (ImageGallery uses div).
 */
import React from 'react'

const Paragraph = (paragraph: any) => {
  const { node }: any = paragraph
  const children_node = node?.children

  // Check if any child is an img tag - these render as block elements (div)
  // so we can't use <p> which doesn't allow nested block elements
  const hasImage = children_node?.some((child: any) => child.tagName === 'img')

  // Use div for paragraphs with images to avoid hydration errors
  if (hasImage)
    return <div className="mb-4">{paragraph.children}</div>

  return <p>{paragraph.children}</p>
}

export default Paragraph
