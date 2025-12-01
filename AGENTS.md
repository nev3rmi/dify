# AGENTS.md

## Project Overview

Dify is an open-source platform for developing LLM applications with an intuitive interface combining agentic AI workflows, RAG pipelines, agent capabilities, and model management.

The codebase is split into:

- **Backend API** (`/api`): Python Flask application organized with Domain-Driven Design
- **Frontend Web** (`/web`): Next.js 15 application using TypeScript and React 19
- **Docker deployment** (`/docker`): Containerized deployment configurations

## Backend Workflow

- Run backend CLI commands through `uv run --project api <command>`.

- Before submission, all backend modifications must pass local checks: `make lint`, `make type-check`, and `uv run --project api --dev dev/pytest/pytest_unit_tests.sh`.

- Use Makefile targets for linting and formatting; `make lint` and `make type-check` cover the required checks.

- Integration tests are CI-only and are not expected to run in the local environment.

## Frontend Workflow

```bash
cd web
pnpm lint
pnpm lint:fix
pnpm test
```

## Testing & Quality Practices

- Follow TDD: red → green → refactor.
- Use `pytest` for backend tests with Arrange-Act-Assert structure.
- Enforce strong typing; avoid `Any` and prefer explicit type annotations.
- Write self-documenting code; only add comments that explain intent.

## Language Style

- **Python**: Keep type hints on functions and attributes, and implement relevant special methods (e.g., `__repr__`, `__str__`).
- **TypeScript**: Use the strict config, lean on ESLint + Prettier workflows, and avoid `any` types.

## General Practices

- Prefer editing existing files; add new documentation only when requested.
- Inject dependencies through constructors and preserve clean architecture boundaries.
- Handle errors with domain-specific exceptions at the correct layer.

## Project Conventions

- Backend architecture adheres to DDD and Clean Architecture principles.
- Async work runs through Celery with Redis as the broker.
- Frontend user-facing strings must use `web/i18n/en-US/`; avoid hardcoded text.

## PDF Citation Highlighting System

### Location

**Main Component:** `web/app/components/base/chat/chat-with-history/pdf-viewer-with-highlight.tsx`

### Architecture

**Data Flow:**
```
1. n8n API → chunk_context (text) + page_numbers (array) + pdf_url
2. PDF loads from MinIO via URL
3. Extract text from page_numbers[0] using pdfjs-dist
4. Group text into lines with bounding boxes (Y-position grouping)
5. Match chunk blocks to PDF lines (sliding window + Levenshtein)
6. Highlight matched line boxes
7. scrollTo(highlight) triggers textLayer creation → highlights render
```

**Key Dependencies:**
- `pdfjs-dist` - PDF text extraction
- `react-pdf-highlighter` - Rendering highlights
- n8n webhook API for chunk data

### Matching Algorithm

**Components:**
1. **Sliding Window (1-5 lines):** Tries all consecutive line combinations
2. **Levenshtein Distance:** Character-level similarity (0-1 score)
3. **Bidirectional Substring:** `window.includes(block) || block.includes(window)`
   - Critical for multi-column PDFs where text is fragmented
4. **Word-Bag (short blocks <60 chars):** Order-independent word matching
   - Safeguard: max 2x length ratio prevents false positives
   - Handles headers/URLs with different word order

**Threshold:** 0.75 minimum score to accept match

### Testing

**Automated test suite:**
```bash
cd web

# Test all chunks (36 text chunks, 88% pass rate validated)
bash scripts/run-full-test-suite.sh

# Detailed evidence for specific chunk
node scripts/generate-test-evidence.js --chunkId=4

# Extract PDF text (same algorithm as component)
node scripts/extract-pdf-lines.js --pdf=/path/to/file.pdf --page=1
```

**Test data:**
- 43 chunks in n8n database
- 3 PDFs in MinIO (n8n-document-ingestion bucket)
- page37.pdf: Technical doc (single-column)
- Tropical.pdf: Article (multi-column)
- hospital.pdf: Medical letter (standard format)

**Expected results:**
- Pass rate: ≥80% (currently 88.9%)
- No false positives (only highlight chunk text)
- Auto-show highlights (no manual click)

### Debugging

**Console logging:**
All matching steps logged with `[PDF]` prefix. Key metrics auto-reported:

```javascript
[PDF] API page number: 2
[PDF] 📄 Extracting text from page 2...
[PDF] 📦 ALL sentence boxes (26 lines)
[PDF] 🚀 Starting sliding window + Levenshtein matching...
[PDF]   Block 1: "..."
[PDF]       ✓ Matched 2 consecutive lines (score: 0.95)

[PDF] 📊 QUALITY METRICS
Block Match Rate:  8/10 (80.0%)
Average Score:     0.892
Coverage:          85.3% of chunk chars
```

**Common issues:**

1. **Highlights don't appear:**
   - Check: `scrollToRef.current` exists before calling
   - Reason: PdfHighlighter needs textLayer on that page
   - Fix: scrollTo() scrolls to page, creating textLayer

2. **Low match rate (<80%):**
   - Check console: Which blocks failed?
   - Run: `node scripts/generate-test-evidence.js --chunkId=X`
   - Look for: Word order differences, split words, wrong page number

3. **False positives:**
   - Check: Coverage vs matched rects
   - If window >> block: Bidirectional substring may over-match
   - Safeguard: Word-bag has 2x length ratio limit

4. **Multi-page chunks:**
   - Current: Only extracts page_numbers[0]
   - Future: Extract from ALL pages in array

### Where to Fix

**Matching algorithm:** Lines 195-247 in pdf-viewer-with-highlight.tsx
```typescript
// Sliding window loop
for (let windowSize = 1; windowSize <= Math.min(5, pageTextMap.lines.length); windowSize++)
  // Levenshtein + substring + word-bag logic
```

**Page extraction:** Lines 323-437
```typescript
const page = await pdfDocument.getPage(apiPageNumber)
// Deduplicate, sort, group into lines
```

**Highlight rendering:** Lines 302-313
```typescript
setHighlights([newHighlight])
scrollToRef.current(newHighlight) // Critical for textLayer creation
```

### Performance Notes

- **Validated:** 88.9% success rate on 36 real chunks
- **Multi-column PDFs:** Handled correctly (bi-directional substring)
- **Short blocks:** Word-bag matching improves headers/URLs
- **Known limitation:** Only uses page_numbers[0], not full array

### Test Evidence Location

- `web/scripts/FINAL_TEST_RESULTS.md` - Full test report
- `web/scripts/COMPLETE_CHUNK_MAPPING.md` - All 43 chunks mapped
- `web/scripts/HIGHLIGHTING_GOALS.md` - Success criteria
- Generated evidence reports in `/tmp/` after running tests
