import axios from 'axios';
import * as cheerio from 'cheerio';
import pdf from 'pdf-parse';
import { createWorker } from 'tesseract.js';

// --- Type Definitions & Custom Error ---
interface MenuItem { name: string; price: string; description?: string; }
interface Menu { starters: MenuItem[]; main_courses: MenuItem[]; desserts: MenuItem[]; [key: string]: MenuItem[]; }
export class MenuExtractionError extends Error {
    statusCode: number;
    details?: string;
    constructor(message: string, statusCode = 500, details?: string) {
        super(message);
        this.name = 'MenuExtractionError';
        this.statusCode = statusCode;
        this.details = details;
    }
}

// ====================================================================
// ===== THE RELENTLESS ORCHESTRATOR ==================================
// ====================================================================
export async function getMenuFromUrl(url: string): Promise<{ source: 'pdf' | 'html', menu: Menu, sourceUrl: string }> {
    console.log(`[PHASE 1] Starting discovery for base URL: ${url}`);
    const candidateUrls = await findCandidateUrls(url);

    console.log(`[PHASE 1] Discovered ${candidateUrls.length} potential menu pages. Ranking them...`);
    const rankedUrls = candidateUrls
        .map(u => ({ url: u, score: scoreUrl(u) }))
        .sort((a, b) => b.score - a.score);

    console.log(`[PHASE 2] Top 5 candidates:`, rankedUrls.slice(0, 5).map(u => u.url));

    for (const { url: candidateUrl } of rankedUrls) {
        console.log(`\n[PHASE 3] Attempting extraction from candidate: ${candidateUrl}`);
        try {
            const { data, headers } = await axios.get(candidateUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
                responseType: 'arraybuffer',
                timeout: 15000, // 15-second timeout
            });

            const contentType = headers['content-type'] || '';
            let rawText = '';
            let source: 'pdf' | 'html' = 'html';

            if (contentType.includes('application/pdf')) {
                source = 'pdf';
                rawText = await extractTextFromPdfWithOcr(data);
            } else if (contentType.includes('text/html')) {
                source = 'html';
                rawText = extractTextFromHtml(data.toString('utf-8'));
            } else {
                console.log(`   - Skipping: Unsupported content type (${contentType})`);
                continue;
            }

            if (!rawText || rawText.trim().length < 100) {
                console.log(`   - Skipping: Not enough meaningful text found.`);
                continue;
            }
            
            console.log(`   - Text extracted. Sending to AI for validation...`);
            const structuredMenu = await structureMenuWithLLM(rawText);

            if (isMenuValid(structuredMenu)) {
                console.log(`   - SUCCESS! Valid menu found and structured.`);
                return { source, menu: structuredMenu, sourceUrl: candidateUrl };
            } else {
                console.log(`   - SKIPPING: AI returned a low-quality or invalid menu.`);
            }

        } catch (error: any) {
            console.warn(`   - FAILED attempt on ${candidateUrl}: ${error.message}`);
        }
    }

    throw new MenuExtractionError("My bot searched the entire site, but I couldn't find a valid, complete menu. The site might not have one or it's in a very unusual format.", 404);
}

// --- URL Discovery Pipeline ---
async function findCandidateUrls(baseUrl: string): Promise<string[]> {
    const urlObj = new URL(baseUrl);
    const domain = urlObj.hostname;
    const allUrls = new Set<string>([baseUrl]);

    // 1. Get from sitemaps
    const sitemapUrls = await findSitemapUrls(urlObj);
    for (const sitemapUrl of sitemapUrls) {
        (await getUrlsFromSitemap(sitemapUrl)).forEach(u => allUrls.add(u));
    }

    // 2. Scrape internal links from the homepage as a fallback
    try {
        const { data: homeHtml } = await axios.get(baseUrl, { timeout: 10000 });
        const $ = cheerio.load(homeHtml);
        $('a').each((_i, el) => {
            const href = $(el).attr('href');
            if (href) {
                try {
                    const absoluteUrl = new URL(href, baseUrl).href;
                    if (new URL(absoluteUrl).hostname === domain) { // Only keep internal links
                        allUrls.add(absoluteUrl);
                    }
                } catch (e) { /* ignore invalid URLs */ }
            }
        });
    } catch (e) {
        console.warn("Could not scrape homepage for links.", e);
    }

    return Array.from(allUrls);
}

// --- Scoring and Sitemap Helpers ---

function scoreUrl(url: string): number {
    const lowerUrl = url.toLowerCase();
    let score = 0;
    if (lowerUrl.endsWith('.pdf')) score += 50;
    const keywordScores: { [key: string]: number } = {
        'menu': 25, 'carte': 25, 'speisekarte': 25, 'card': 20,
        'online-ordering': 15, 'order': 10, 'speisen': 10, 'food': 5,
        'contact': -50, 'about': -50, 'blog': -50, 'gallery': -30, 'jobs': -50
    };
    for (const [keyword, value] of Object.entries(keywordScores)) {
        if (lowerUrl.includes(keyword)) score += value;
    }
    return score;
}

async function findSitemapUrls(baseUrlObj: URL): Promise<string[]> {
    const robotsUrl = `${baseUrlObj.origin}/robots.txt`;
    const sitemaps: string[] = [];
    try {
        const { data } = await axios.get(robotsUrl, { timeout: 5000 });
        const lines = data.split('\n');
        for (const line of lines) {
            if (line.toLowerCase().startsWith('sitemap:')) {
                sitemaps.push(line.substring(8).trim());
            }
        }
    } catch (error) {
        console.log(`No robots.txt found at ${robotsUrl}, will check common sitemap path.`);
    }
    // Add common fallback paths if none found in robots.txt
    if (sitemaps.length === 0) {
        sitemaps.push(`${baseUrlObj.origin}/sitemap.xml`);
        sitemaps.push(`${baseUrlObj.origin}/sitemap_index.xml`);
    }
    return sitemaps;
}

async function getUrlsFromSitemap(sitemapUrl: string): Promise<string[]> {
    try {
        const { data } = await axios.get(sitemapUrl, { timeout: 10000 });
        const $ = cheerio.load(data, { xmlMode: true });
        const urls: string[] = [];

        if ($('sitemapindex').length > 0) {
            const sitemapLinks = $('sitemap > loc').map((_i, el) => $(el).text()).get();
            const nestedUrls = await Promise.all(sitemapLinks.map(link => getUrlsFromSitemap(link)));
            return nestedUrls.flat();
        }

        $('url > loc').each((_i, el) => {
            urls.push($(el).text());
        });
        return urls;
    } catch (error: any) {
        console.warn(`Failed to fetch or parse sitemap: ${sitemapUrl} (${error.message})`);
        return [];
    }
}

// --- Text Extraction ---

function extractTextFromHtml(html: string): string {
    const $ = cheerio.load(html);
    // Prioritize specific 'menu' elements
    const commonMenuSelectors = ['[class*="menu"]', '[id*="menu"]', 'article', 'main'];
    let text = '';
    for (const selector of commonMenuSelectors) {
        if ($(selector).length > 0) {
            text = $(selector).text();
            if (text.length > 500) break;
        }
    }
    if (!text) text = $('body').text();
    return text.replace(/\s\s+/g, ' ').replace(/(\r\n|\n|\r)/gm, " ").trim();
}

async function extractTextFromPdfWithOcr(pdfBuffer: Buffer): Promise<string> {
    try {
        console.log("   - Attempting text-based PDF extraction...");
        const data = await pdf(pdfBuffer);
        if (data.text && data.text.trim().length > 50) {
            console.log("   - Text-based extraction successful.");
            return data.text;
        }
    } catch (error) {
        console.warn("   - pdf-parse failed, likely an image-based PDF. Proceeding to OCR.");
    }

    console.log("   - Falling back to OCR with Tesseract.js. This may take a moment...");
    const worker = await createWorker('eng+fra+deu+ita+spa');
    try {
        const { data: { text } } = await worker.recognize(pdfBuffer);
        console.log("   - OCR processing complete.");
        return text;
    } catch (ocrError) {
        throw new Error(`Both text parsing and OCR failed for the PDF: ${(ocrError as Error).message}`);
    } finally {
        await worker.terminate();
    }
}

// --- AI Processing and Validation ---

async function structureMenuWithLLM(text: string): Promise<Menu> {
    const endpoint = process.env.OLLAMA_API_ENDPOINT || 'http://localhost:11434/api/chat';
    const MAX_CHARS = 16000;
    if (text.length > MAX_CHARS) {
        console.warn(`   - Input text too long (${text.length} chars). Truncating.`);
        text = text.substring(0, MAX_CHARS);
    }
    const prompt = `Analyze the following restaurant menu text and extract all items. Structure the output as a valid JSON object with keys: "starters", "main_courses", "desserts", and "drinks". If a category is empty, provide an empty array []. Each item must be an object with "name" (string), "price" (string), and optional "description" (string). Be extremely precise. Do not invent items. Respond ONLY with the raw JSON object. TEXT: --- ${text} ---`;

    try {
        const response = await axios.post(endpoint, {
            model: 'mistral:7b', messages: [{ role: 'user', content: prompt }],
            format: 'json', stream: false, options: { temperature: 0.0 }
        });
        return JSON.parse(response.data.message.content);
    } catch (error: any) {
        console.error("   - CRITICAL LLM FAILURE:", error.response?.data?.error || error.message);
        throw new Error("The AI model failed to process the text.");
    }
}

function isMenuValid(menu: any): menu is Menu {
    if (!menu || typeof menu !== 'object') return false;

    const hasRequiredKeys = ['starters', 'main_courses', 'desserts'].every(key => Array.isArray(menu[key]));
    if (!hasRequiredKeys) return false;

    const totalItems = (menu.starters?.length || 0) + (menu.main_courses?.length || 0) + (menu.desserts?.length || 0);
    if (totalItems < 3) return false;

    const allItems = [...(menu.starters || []), ...(menu.main_courses || []), ...(menu.desserts || [])];
    const genericNames = new Set(['entrée', 'plat', 'dessert', 'starter', 'main', 'dish', 'item', 'menu item']);

    // Check if at least half the items have a non-generic name and a price
    const validItemCount = allItems.filter(item => 
        typeof item.name === 'string' && 
        !genericNames.has(item.name.toLowerCase()) && 
        item.name.length > 3 &&
        typeof item.price === 'string' &&
        item.price.length > 0
    ).length;

    return validItemCount >= totalItems * 0.5;
}