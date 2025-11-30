# Complete Chunk Database Mapping

Found **43+ chunks** from n8n API.

## PDF 1: page37.pdf (CCC Digital Key)

| Chunk | Type | Page(s) | Length | Test Priority |
|-------|------|---------|--------|---------------|
| 1 | image | 1 | 1298 chars | ❌ Skip (image) |
| **2** | **text** | **1** | **906 chars** | ✅ **HIGH** |
| **3** | **text** | **1** | **790 chars** | ✅ **HIGH** |

**Test Coverage:** 2 text chunks on page 1

---

## PDF 2: Tropical.pdf (Amazon Article)

| Chunk | Type | Page(s) | Length | Test Priority |
|-------|------|---------|--------|---------------|
| **4** | **text** | **1** | **495 chars** | ✅ **HIGH** |
| 5 | image | 1 | 1010 chars | ❌ Skip (image) |
| **6** | **text** | **1** | **391 chars** | ✅ **HIGH** |
| 7 | text | 1, 2 | 843 chars | ⚠️ Multi-page |
| 8 | image | 2 | 1118 chars | ❌ Skip (image) |
| **9** | **text** | **2** | **654 chars** | ✅ **MEDIUM** |
| 10 | text | 2, 3 | 664 chars | ⚠️ Multi-page |
| 11 | image | 2 | 1063 chars | ❌ Skip (image) |
| **12** | **text** | **3** | **1458 chars** | ✅ **MEDIUM** |
| 13 | image | 3 | 1025 chars | ❌ Skip (image) |
| **14** | **text** | **3** | **438 chars** | ✅ **LOW** |

**Test Coverage:** 7 single-page + 2 multi-page text chunks

---

## PDF 3: hospital.pdf (Medical Letter)

| Chunk | Type | Page(s) | Length | Test Priority |
|-------|------|---------|--------|---------------|
| 15 | image | 1 | 786 chars | ❌ Skip (image) |
| **16** | **text** | **1** | **91 chars** | ⚠️ Very short |
| **17** | **text** | **1** | **368 chars** | ✅ **MEDIUM** |
| **18** | **text** | **1** | **290 chars** | ✅ **MEDIUM** |
| **19** | **text** | **1** | **213 chars** | ✅ **LOW** |
| **20** | **text** | **1** | **136 chars** | ⚠️ Short |

**Test Coverage:** 5 text chunks on page 1 (some very short)

---

## Complete Test Matrix

### By PDF

| PDF | Total Chunks | Text Chunks | Image Chunks | Single-Page | Multi-Page |
|-----|--------------|-------------|--------------|-------------|------------|
| page37.pdf | 3 | 2 | 1 | 2 | 0 |
| Tropical.pdf | 11 | 7 | 4 | 5 | 2 |
| hospital.pdf | 6+ | 5+ | 1+ | 5+ | 0 |

### Testable Text Chunks (Single-Page Only)

**HIGH Priority** (Good length, single page):
- ✅ Chunk 2 (page37.pdf, page 1, 906 chars)
- ✅ Chunk 3 (page37.pdf, page 1, 790 chars)
- ✅ Chunk 4 (Tropical.pdf, page 1, 495 chars)
- ✅ Chunk 6 (Tropical.pdf, page 1, 391 chars)

**MEDIUM Priority** (Different pages/content):
- ✅ Chunk 9 (Tropical.pdf, page 2, 654 chars)
- ✅ Chunk 12 (Tropical.pdf, page 3, 1458 chars)
- ✅ Chunk 17 (hospital.pdf, page 1, 368 chars)
- ✅ Chunk 18 (hospital.pdf, page 1, 290 chars)

**LOW Priority** (Very short or edge cases):
- ⚠️ Chunk 14 (Tropical.pdf, page 3, 438 chars)
- ⚠️ Chunk 16 (hospital.pdf, page 1, 91 chars - very short!)
- ⚠️ Chunk 19 (hospital.pdf, page 1, 213 chars)
- ⚠️ Chunk 20 (hospital.pdf, page 1, 136 chars)

**DEFERRED** (Multi-page - requires code changes):
- 🔄 Chunk 7 (Tropical.pdf, pages 1-2)
- 🔄 Chunk 10 (Tropical.pdf, pages 2-3)

---

## Recommended Test Plan

### Phase 1: Core Validation (Test 4 chunks)
```bash
node scripts/test-all-pdfs.js --chunkId=2   # page37.pdf p1
node scripts/test-all-pdfs.js --chunkId=3   # page37.pdf p1
node scripts/test-all-pdfs.js --chunkId=4   # Tropical.pdf p1
node scripts/test-all-pdfs.js --chunkId=9   # Tropical.pdf p2
```

**Goal:** Validate algorithm works across different PDFs and pages.

### Phase 2: Extended Validation (Test 4 more)
```bash
node scripts/test-all-pdfs.js --chunkId=6   # Tropical.pdf p1
node scripts/test-all-pdfs.js --chunkId=12  # Tropical.pdf p3
node scripts/test-all-pdfs.js --chunkId=17  # hospital.pdf p1
node scripts/test-all-pdfs.js --chunkId=18  # hospital.pdf p1
```

**Goal:** Test different content types and PDFs.

### Phase 3: Edge Cases (Test 2)
```bash
node scripts/test-all-pdfs.js --chunkId=16  # Very short (91 chars)
node scripts/test-all-pdfs.js --chunkId=20  # Short (136 chars)
```

**Goal:** Validate short text chunks work.

---

## Expected Results

If algorithm works well, we should see:

**Phase 1 (4 chunks):**
- All 4: Match Rate ≥ 80%
- All 4: Score ≥ 0.85
- All 4: No false positives

**Phase 2 (4 chunks):**
- 3-4: Match Rate ≥ 80%
- May have 1 failure acceptable

**Phase 3 (2 chunks):**
- Short chunks may have lower scores (acceptable)
- Main goal: No false positives

---

## Current Test Status

**Total testable chunks: 14** (single-page text chunks)

**Tested so far: 0**

**Next: Test Phase 1 (chunks 2, 3, 4, 9)**
