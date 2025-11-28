
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfUrl = 'https://minio.toho.vn/n8n-document-ingestion/tropical/inbox/Tropical.pdf';
const searchText = 'Science News Article';

async function testExtraction() {
    try {
        console.log('🚀 Starting PDF text extraction test...');

        // We need to mock the worker or use the legacy build which might not need it in node, 
        // or point to a local worker file if needed.
        // For Node.js, we often don't need the worker if we use the right import or setup.
        // Let's try standard import first.

        console.log(`Loading PDF from: ${pdfUrl}`);
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;

        console.log(`PDF Loaded. Pages: ${pdf.numPages}`);
        console.log('🔍 Searching for:', searchText);

        const page = await pdf.getPage(1);
        const textContent = await page.getTextContent();

        const items = textContent.items;
        console.log(`Page 1 loaded. Found ${items.length} text items.`);

        // Normalize search text
        const normalize = (s) => s.replace(/\s+/g, ' ').toLowerCase();
        const searchNormalized = normalize(searchText);

        let found = false;

        // Find items that match
        items.forEach((item) => {
            const itemStr = normalize(item.str);
            if (itemStr.includes(searchNormalized) || searchNormalized.includes(itemStr)) {
                console.log(`Possible match item: "${item.str}"`);

                if (['Science', 'News', 'Article'].some(word => item.str.includes(word))) {
                    console.log(`✅ CONFIRMED MATCH: "${item.str}" at transform:`, item.transform);
                    found = true;
                }
            }
        });

        if (found) {
            console.log('✅ Test PASSED: Found text in PDF.');
        } else {
            console.log('❌ Test FAILED: Did not find search text.');
            // Log first 20 items to see what's there
            console.log('First 20 items:', items.slice(0, 20).map(i => i.str));
        }

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

testExtraction();
