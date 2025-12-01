#!/usr/bin/env node

/**
 * Extract PDF Text Lines (Same as Component)
 *
 * Uses pdfjs-dist to extract text exactly like pdf-viewer-with-highlight.tsx
 *
 * Usage:
 *   node scripts/extract-pdf-lines.js --pdf=/tmp/test-pdfs/page37.pdf --page=1
 */

const fs = require('fs')

// Dynamic import for ESM module
async function loadPdfJs() {
  return await import('pdfjs-dist/legacy/build/pdf.mjs')
}

// Parse CLI args
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=')
  acc[key] = value
  return acc
}, {})

const pdfPath = args.pdf || '/tmp/test-pdfs/page37.pdf'
const pageNum = parseInt(args.page || '1')

async function extractPageLines(pdfPath, pageNumber) {
  console.log(`📄 Extracting text from ${pdfPath} page ${pageNumber}...\n`)

  // Load pdfjs
  const pdfjsLib = await loadPdfJs()

  // Load PDF
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise

  console.log(`   Total pages: ${pdfDocument.numPages}`)

  // Get page
  const page = await pdfDocument.getPage(pageNumber)
  const textContent = await page.getTextContent()
  const items = textContent.items

  console.log(`   Text items: ${items.length}\n`)

  // Deduplicate by position (SAME AS COMPONENT)
  const textItemsMap = new Map()

  for (const item of items) {
    if (!item.str || !item.str.trim()) continue

    const x = item.transform[4]
    const y = item.transform[5]
    const key = `${x.toFixed(1)},${y.toFixed(1)},${item.str}`

    if (textItemsMap.has(key)) continue

    textItemsMap.set(key, {
      text: item.str,
      x,
      y,
      width: item.width,
      height: item.height || Math.abs(item.transform[3]),
    })
  }

  const textItems = Array.from(textItemsMap.values())

  // Sort by Y (top to bottom), then X (left to right) - SAME AS COMPONENT
  const sortedItems = [...textItems].sort((a, b) => {
    const yDiff = b.y - a.y
    if (Math.abs(yDiff) < 5) return a.x - b.x
    return yDiff
  })

  // Group into lines (Y within 5px) - SAME AS COMPONENT
  const lineGroups = []

  for (const item of sortedItems) {
    const existingLine = lineGroups.find(line => Math.abs(line.y - item.y) < 5)

    if (existingLine) {
      existingLine.items.push(item)
    }
    else {
      lineGroups.push({
        y: item.y,
        items: [item],
        text: '',
      })
    }
  }

  // Build text for each line - SAME AS COMPONENT
  for (const line of lineGroups) {
    const sortedLineItems = [...line.items].sort((a, b) => a.x - b.x)

    let lineText = sortedLineItems.map(i => i.text).join(' ')

    // Merge split words: "o wner" → "owner"
    lineText = lineText.replace(/\b([a-zA-Z])\s+([a-z]+\w*)/g, '$1$2')

    // Clean spacing
    lineText = lineText.replace(/\s+/g, ' ').trim()

    line.text = lineText
  }

  return lineGroups.map(lg => lg.text)
}

async function main() {
  try {
    const lines = await extractPageLines(pdfPath, pageNum)

    console.log(`✅ Extracted ${lines.length} lines:\n`)
    lines.forEach((line, i) => {
      console.log(`${(i + 1).toString().padStart(3)}. ${line}`)
    })

    // Save to test data
    const outputPath = args.output || `/tmp/pdf-lines-p${pageNum}.json`
    const testData = {
      pdf: pdfPath.split('/').pop(),
      page: pageNum,
      lines,
      extractedAt: new Date().toISOString(),
    }

    fs.writeFileSync(outputPath, JSON.stringify(testData, null, 2))
    console.log(`\n💾 Saved to: ${outputPath}`)
  }
  catch (error) {
    console.error('❌ Error:', error.message)
    process.exit(1)
  }
}

main()
