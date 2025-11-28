
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfUrl = 'https://minio.toho.vn/n8n-document-ingestion/tropical/inbox/Tropical.pdf';

async function testConversion() {
    try {
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        console.log('Viewport:', { width: viewport.width, height: viewport.height });

        const textContent = await page.getTextContent();
        const items = textContent.items;

        // Find "SCIENCE NEWS ARTICLE"
        const target = items.find(item => item.str === 'SCIENCE NEWS ARTICLE');

        if (target) {
            console.log('\nFound target:', target.str);
            console.log('Transform:', target.transform);
            console.log('Width:', target.width);
            console.log('Height:', target.height);

            const [scaleX, , , scaleY, x, y] = target.transform;
            const height = target.height || Math.abs(scaleY);
            const width = target.width;

            console.log('\nPDF Coordinates:');
            console.log('x:', x);
            console.log('y:', y);
            console.log('width:', width);
            console.log('height:', height);

            // Test different rectangle formats
            console.log('\n--- Testing convertToViewportRectangle ---');

            // Format 1: [x1, y1, x2, y2]
            const rect1 = [x, y, x + width, y + height];
            const view1 = viewport.convertToViewportRectangle(rect1);
            console.log('Format [x, y, x+w, y+h]:', rect1);
            console.log('Result:', view1);

            // Format 2: [x1, y2, x2, y1] (flipped y)
            const rect2 = [x, y + height, x + width, y];
            const view2 = viewport.convertToViewportRectangle(rect2);
            console.log('\nFormat [x, y+h, x+w, y]:', rect2);
            console.log('Result:', view2);

            // Manual calculation
            console.log('\n--- Manual Calculation ---');
            const manualY1 = viewport.height - (y + height);
            const manualY2 = viewport.height - y;
            console.log('Manual y1 (top):', manualY1);
            console.log('Manual y2 (bottom):', manualY2);
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

testConversion();
