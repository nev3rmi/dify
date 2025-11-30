# PDF Matching Test Matrix

## Chunk → PDF Mapping (from n8n API)

| Chunk ID | Type | PDF File | Page(s) | Project | Blocks | Description |
|----------|------|----------|---------|---------|--------|-------------|
| 1 | image | system-architecture.png | 1 | ccc | - | ❌ Skip (image) |
| **2** | **text** | **page37.pdf** | **1** | **ccc** | **4** | ✅ Digital Key Architecture |
| **3** | **text** | **page37.pdf** | **1** | **ccc** | **3** | ✅ Device OEM Servers |
| **4** | **text** | **Tropical.pdf** | **1** | **tropical** | **2** | ✅ Science article intro |
| 5 | image | tropical-river.png | 1 | tropical | - | ❌ Skip (image) |
| **6** | **text** | **Tropical.pdf** | **1** | **tropical** | **2** | ✅ Amazon's Vastness |
| **7** | **text** | **Tropical.pdf** | **1-2** | **tropical** | **7** | ✅ Earth's Lungs (multi-page) |
| 8 | image | tropical-bull.png | 2 | tropical | - | ❌ Skip (image) |
| **9** | **text** | **Tropical.pdf** | **2** | **tropical** | **2** | ✅ Threats to Amazon |
| **10** | **text** | **Tropical.pdf** | **2-3** | **tropical** | **3** | ✅ Deforestation (multi-page) |

## Test PDFs (Downloaded from MinIO)

1. **page37.pdf** (214 KB) - `/tmp/test-pdfs/page37.pdf`
   - Chunks: 2, 3
   - Pages to test: Page 1

2. **Tropical.pdf** (449 KB) - `/tmp/test-pdfs/Tropical.pdf`
   - Chunks: 4, 6, 7, 9, 10
   - Pages to test: Pages 1, 2, 3

3. **hospital.pdf** (399 KB) - `/tmp/test-pdfs/hospital.pdf`
   - Chunks: None found (no chunks in n8n yet)
   - Status: ⚠️ No test data

## Priority Test Cases

### Test 1: Single Page Matching (Chunk 2)
```bash
node scripts/test-all-pdfs.js --chunkId=2
```

**PDF:** page37.pdf
**Page:** 1
**Blocks:** 4
- "Figure 2-1: Digital Key Architecture..."
- "In the system, the vehicle is linked..."
- "The vehicle is equipped with NFC..."
- "The owner device communicates..."

**Expected:**
- Match Rate: ≥ 80% (3-4 blocks matched)
- Score: ≥ 0.85
- Coverage: ≥ 75%

### Test 2: Multi-Page Matching (Chunk 7)
```bash
node scripts/test-all-pdfs.js --chunkId=7
```

**PDF:** Tropical.pdf
**Pages:** 1-2 (spans pages!)
**Blocks:** 7

**Expected:**
- ⚠️ Challenge: Content spans 2 pages
- Current code only extracts from page_numbers[0] = page 1
- May miss content on page 2
- **This is a test for edge case**

### Test 3: Different Content (Chunk 4)
```bash
node scripts/test-all-pdfs.js --chunkId=4
```

**PDF:** Tropical.pdf
**Page:** 1
**Blocks:** 2
- Science article header
- Amazon rainforest description

**Expected:**
- Match Rate: ≥ 80%
- Different content style (article vs technical doc)

## Testing Workflow

```bash
# Step 1: Quick check - what chunks exist
node scripts/test-all-pdfs.js --chunkId=2
node scripts/test-all-pdfs.js --chunkId=3
node scripts/test-all-pdfs.js --chunkId=4

# Step 2: Test each in browser
# Open http://localhost:3000
# Click citations 2, 3, 4
# Check console quality metrics for each

# Step 3: Record results
# Create spreadsheet:
# Chunk | Match Rate | Score | Coverage | False Positives | Pass/Fail
```

## Success Criteria (ALL Must Pass)

✓ **Chunk 2** (page37.pdf, page 1): Match ≥80%, No false positives
✓ **Chunk 3** (page37.pdf, page 1): Match ≥80%, No false positives
✓ **Chunk 4** (Tropical.pdf, page 1): Match ≥80%, No false positives
✓ **Chunk 6** (Tropical.pdf, page 1): Match ≥80%, No false positives
✓ **Chunk 9** (Tropical.pdf, page 2): Match ≥80%, No false positives

## Known Issues to Test

**Multi-page chunks (7, 10):**
- Current code only extracts page_numbers[0]
- May miss content from second page
- Need to handle: Extract text from ALL pages in page_numbers array

**Image chunks (1, 5, 8):**
- Type: "image" (not text)
- Should these have highlighting? Probably not
- Skip for now
