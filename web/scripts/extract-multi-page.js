#!/usr/bin/env node

/**
 * Extract text from multiple PDF pages
 * Usage: node scripts/extract-multi-page.js --pdf=/tmp/test-pdfs/Tropical.pdf --pages=1,2
 */

const fs = require('fs')

async function loadPdfJs() {
  return await import('pdfjs-dist/legacy/build/pdf.mjs')
}

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=')
  acc[key] = value
  return acc
}, {})

const pdfPath = args.pdf || '/tmp/test-pdfs/Tropical.pdf'
const pages = args.pages ? args.pages.split(',').map(Number) : [1]

async function extractMultiPageLines(pdfPath, pageNumbers) {
  console.log(`📄 Extracting text from ${pdfPath} pages [${pageNumbers.join(', ')}]...`)

  const pdfjsLib = await loadPdfJs()
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise

  const allLines = []

  for (const pageNum of pageNumbers) {
    const page = await pdfDocument.getPage(pageNum)
    const textContent = await page.getTextContent()
    const items = textContent.items

    console.log(`  Page ${pageNum}: ${items.length} items`)

    //Deduplicate
    const pageItems = []
    const seen = new Set()

    for (const item of items) {
      if (!item.str || !item.str.trim()) continue

      const x = item.transform[4]
      const y = item.transform[5]
      const key = `${x.toFixed(1)},${y.toFixed(1)},${item.str}`

      if (seen.has(key)) continue
      seen.add(key)

      pageItems.push({
        text: item.str,
        x,
        y,
        width: item.width,
        height: item.height || Math.abs(item.transform[3]),
        pageNumber: pageNum,
      })
    }

    // Sort and group into lines
    const sortedItems = [...pageItems].sort((a, b) => {
      const yDiff = b.y - a.y
      if (Math.abs(yDiff) < 5) return a.x - b.x
      return yDiff
    })

    const lineGroups = []
    for (const item of sortedItems) {
      const existingLine = lineGroups.find(line =>
        Math.abs(line.y - item.y) < 5
      )

      if (existingLine) {
        existingLine.items.push(item)
      }
      else {
        lineGroups.push({ y: item.y, items: [item], text: '' })
      }
    }

    // Build line text
    for (const line of lineGroups) {
      const sortedLineItems = [...line.items].sort((a, b) => a.x - b.x)
      let lineText = sortedLineItems.map(i => i.text).join(' ')
      lineText = lineText.replace(/\b([a-zA-Z])\s+([a-z]+\w*)/g, '$1$2')
      lineText = lineText.replace(/\s+/g, ' ').trim()
      line.text = lineText
      allLines.push({ text: lineText, pageNumber: pageNum })
    }
  }

  return allLines
}

async function main() {
  try {
    const lines = await extractMultiPageLines(pdfPath, pages)

    console.log(`\n✅ Extracted ${lines.length} lines from ${pages.length} page(s):\n`)
    lines.forEach((line, i) => {
      console.log(`${(i + 1).toString().padStart(3)} (p${line.pageNumber}). ${line.text}`)
    })

    const outputPath = args.output || `/tmp/pdf-multi-lines-p${pages.join('-')}.json`
    fs.writeFileSync(outputPath, JSON.stringify({ pdf: pdfPath.split('/').pop(), pages, lines: lines.map(l => l.text) }, null, 2))
    console.log(`\n💾 Saved to: ${outputPath}`)
  }
  catch (error) {
    console.error('❌ Error:', error.message)
    process.exit(1)
  }
}

main()
