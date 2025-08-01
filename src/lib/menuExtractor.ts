import axios from 'axios';
import * as cheerio from 'cheerio';
import pdf from 'pdf-parse';
import { createWorker, PSM } from 'tesseract.js';
import puppeteer from 'puppeteer';

// --- Type Definitions & Custom Error ---
interface MenuItem { 
    name: string; 
    price: string; 
    description?: string; 
    category?: string;
}

interface Menu { 
    starters: MenuItem[]; 
    main_courses: MenuItem[]; 
    desserts: MenuItem[];
    drinks?: MenuItem[];
    [key: string]: MenuItem[] | undefined; 
}

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
// ===== ENHANCED ORCHESTRATOR =====================================
// ====================================================================
export async function getMenuFromUrl(url: string): Promise<{ source: 'pdf' | 'html' | 'js', menu: Menu, sourceUrl: string }> {
    console.log(`[PHASE 1] Starting enhanced discovery for base URL: ${url}`);
    
    // Try multiple extraction strategies in parallel for speed
    const extractionPromises = [
        tryDirectExtraction(url),
        tryEnhancedDiscovery(url)
    ];

    const results = await Promise.allSettled(extractionPromises);
    
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            return result.value;
        }
    }

    throw new MenuExtractionError("Enhanced extraction failed to find a valid menu across all strategies.", 404);
}

// --- Direct Extraction Strategy ---
async function tryDirectExtraction(url: string): Promise<{ source: 'pdf' | 'html' | 'js', menu: Menu, sourceUrl: string } | null> {
    try {
        console.log(`[DIRECT] Attempting direct extraction from: ${url}`);
        
        // Try with enhanced JavaScript rendering first
        const jsResult = await extractWithJavaScript(url);
        if (jsResult) return jsResult;

        // Fallback to traditional HTTP extraction
        const { data, headers } = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            responseType: 'arraybuffer',
            timeout: 20000,
        });

        const contentType = headers['content-type'] || '';
        let rawText = '';
        let source: 'pdf' | 'html' | 'js' = 'html';

        if (contentType.includes('application/pdf')) {
            source = 'pdf';
            rawText = await extractTextFromPdfWithEnhancedOcr(data);
        } else if (contentType.includes('text/html')) {
            source = 'html';
            rawText = extractTextFromHtmlEnhanced(data.toString('utf-8'));
        }

        if (rawText && rawText.trim().length > 100) {
            const structuredMenu = await structureMenuWithEnhancedLLM(rawText);
            if (isMenuValid(structuredMenu)) {
                return { source, menu: structuredMenu, sourceUrl: url };
            }
        }
    } catch (error) {
        console.warn(`[DIRECT] Failed: ${(error as Error).message}`);
    }
    return null;
}

// --- Enhanced Discovery Strategy ---
async function tryEnhancedDiscovery(url: string): Promise<{ source: 'pdf' | 'html' | 'js', menu: Menu, sourceUrl: string } | null> {
    const candidateUrls = await findCandidateUrlsEnhanced(url);
    console.log(`[DISCOVERY] Found ${candidateUrls.length} candidates`);
    
    const rankedUrls = candidateUrls
        .map(u => ({ url: u, score: scoreUrlEnhanced(u) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 15); // Limit to top 15 for speed

    // Process candidates in batches for speed
    const batchSize = 3;
    for (let i = 0; i < rankedUrls.length; i += batchSize) {
        const batch = rankedUrls.slice(i, i + batchSize);
        const batchPromises = batch.map(({ url: candidateUrl }) => processCandidate(candidateUrl));
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value) {
                return result.value;
            }
        }
    }
    
    return null;
}

// --- JavaScript-Powered Extraction ---
async function extractWithJavaScript(url: string): Promise<{ source: 'pdf' | 'html' | 'js', menu: Menu, sourceUrl: string } | null> {
    let browser;
    try {
        console.log(`[JS] Launching browser for ${url}`);
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Set viewport and wait for network idle
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for potential dynamic content loading
        await new Promise(r => setTimeout(r, 3000));
        
        // Try to click on menu-related buttons/links
        const menuTriggers = [
            'button[class*="menu"]', 'a[class*="menu"]', 'button[class*="carte"]', 
            'a[href*="menu"]', 'a[href*="carte"]', '[data-menu]', '[id*="menu"]'
        ];
        
        for (const trigger of menuTriggers) {
            try {
                const element = await page.$(trigger);
                if (element) {
                    await element.click();
                    await new Promise(r => setTimeout(r, 2000));
                    break;
                }
            } catch (e) {
                // Continue to next trigger
            }
        }
        
        // Extract text from rendered page
        const extractedText = await page.evaluate(() => {
            // Remove unwanted elements
            const unwanted = document.querySelectorAll('header, footer, nav, script, style, noscript, aside, form, button:not([class*="menu"]), input, .cookie, .popup, .modal');
            unwanted.forEach(el => el.remove());
            
            // Priority selectors for menu content
            const menuSelectors = [
                '[class*="menu"]', '[id*="menu"]', '[class*="carte"]', '[id*="carte"]',
                '[class*="food"]', '[class*="dish"]', '[class*="restaurant"]',
                'main', 'article', '.content', '.container'
            ];
            
            let bestText = '';
            let maxScore = 0;
            
            for (const selector of menuSelectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const text = el.textContent || '';
                    const score = (text.match(/€|\$|£|CHF|\d+[.,]\d{2}/g) || []).length; // Count price indicators
                    if (score > maxScore && text.length > 200) {
                        maxScore = score;
                        bestText = text;
                    }
                });
            }
            
            return bestText || document.body.textContent || '';
        });
        
        if (extractedText && extractedText.trim().length > 100) {
            const structuredMenu = await structureMenuWithEnhancedLLM(extractedText);
            if (isMenuValid(structuredMenu)) {
                return { source: 'js' as const, menu: structuredMenu, sourceUrl: url };
            }
        }
        
    } catch (error) {
        console.warn(`[JS] Browser extraction failed: ${(error as Error).message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
    
    return null;
}

// --- Enhanced HTML Extraction ---
function extractTextFromHtmlEnhanced(html: string): string {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements more aggressively
    $('header, footer, nav, script, style, noscript, aside, form, button:not([class*="menu"]), input, .cookie, .popup, .modal, .advertisement, .ad, .social, .share').remove();
    
    // Priority extraction with scoring
    const menuSelectors = [
        '[class*="menu"]', '[id*="menu"]', '[class*="carte"]', '[id*="carte"]',
        '[class*="food"]', '[class*="dish"]', '[class*="restaurant"]', '[class*="price"]',
        'main', 'article', '.content', '.container', 'section'
    ];
    
    let bestText = '';
    let maxScore = 0;
    
    for (const selector of menuSelectors) {
        const elements = $(selector);
        elements.each((_, el) => {
            const text = $(el).text();
            // Score based on price indicators and menu keywords
            const priceScore = (text.match(/€|\$|£|CHF|\d+[.,]\d{2}/g) || []).length * 3;
            const menuScore = (text.match(/entrée|plat|dessert|starter|main|appetizer|dish/gi) || []).length;
            const totalScore = priceScore + menuScore;
            
            if (totalScore > maxScore && text.length > 200) {
                maxScore = totalScore;
                bestText = text;
            }
        });
    }
    
    if (!bestText) {
        bestText = $('body').text();
    }
    
    // Enhanced text cleaning
    return bestText
        .replace(/\s\s+/g, ' ')
        .replace(/(\r\n|\n|\r)/gm, " ")
        .replace(/[^\w\s€$£.,-]/g, ' ')
        .trim();
}

// --- Enhanced PDF OCR ---
async function extractTextFromPdfWithEnhancedOcr(pdfBuffer: Buffer): Promise<string> {
    try {
        console.log("   - Attempting enhanced text-based PDF extraction...");
        const data = await pdf(pdfBuffer, {});
        
        if (data.text && data.text.trim().length > 50) {
            console.log("   - Text-based extraction successful.");
            return data.text;
        }
    } catch (error) {
        console.warn("   - pdf-parse failed, proceeding to enhanced OCR.");
    }
    
    console.log("   - Using enhanced multi-language OCR...");
    const worker = await createWorker(['eng', 'fra', 'deu', 'ita', 'spa'], 1, {
        logger: m => {
            if (m.status === 'recognizing text') {
                console.log(`   - OCR Progress: ${Math.round(m.progress * 100)}%`);
            }
        }
    });
    
    try {
        // Enhanced OCR parameters for better menu extraction
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789€$£.,- àáâäèéêëìíîïòóôöùúûüñç',
            // CORRECTED: Use the PSM enum from tesseract.js instead of a raw number for type safety.
            tessedit_pageseg_mode: PSM.SINGLE_BLOCK, // This corresponds to mode '6'
            preserve_interword_spaces: '1'
        });
        
        const { data: { text } } = await worker.recognize(pdfBuffer);
        console.log("   - Enhanced OCR processing complete.");
        
        // Post-process OCR text to fix common errors
        return text
            .replace(/[|]/g, 'l')  // Common OCR error
            .replace(/[0O]/g, match => match === '0' && /\d/.test(match) ? '0' : 'O')
            .replace(/(\d)[lI](\d)/g, '$1.$2')  // Fix decimal points
            .trim();
            
    } catch (ocrError) {
        throw new Error(`Enhanced OCR failed: ${(ocrError as Error).message}`);
    } finally {
        await worker.terminate();
    }
}

// --- Enhanced URL Discovery ---
async function findCandidateUrlsEnhanced(baseUrl: string): Promise<string[]> {
    const urlObj = new URL(baseUrl);
    const domain = urlObj.hostname;
    const allUrls = new Set<string>([baseUrl]);
    
    // Parallel discovery for speed
    const discoveryPromises = [
        discoverFromSitemaps(urlObj),
        discoverFromHomepage(baseUrl, domain),
        discoverCommonPaths(urlObj)
    ];
    
    const results = await Promise.allSettled(discoveryPromises);
    
    results.forEach(result => {
        if (result.status === 'fulfilled') {
            result.value.forEach(url => allUrls.add(url));
        }
    });
    
    return Array.from(allUrls);
}

async function discoverCommonPaths(urlObj: URL): Promise<string[]> {
    const commonPaths = [
        '/menu', '/carte', '/food', '/dining', '/restaurant',
        '/menu.pdf', '/carte.pdf', '/menu.html', '/carte.html',
        '/en/menu', '/fr/carte', '/de/speisekarte', '/it/menu',
        '/assets/menu.pdf', '/uploads/menu.pdf', '/files/menu.pdf'
    ];
    
    const urls: string[] = [];
    const checkPromises = commonPaths.map(async (path) => {
        const testUrl = `${urlObj.origin}${path}`;
        try {
            const response = await axios.head(testUrl, { timeout: 5000 });
            if (response.status === 200) {
                urls.push(testUrl);
            }
        } catch (e) {
            // Path doesn't exist, ignore
        }
    });
    
    await Promise.allSettled(checkPromises);
    return urls;
}

async function discoverFromHomepage(baseUrl: string, domain: string): Promise<string[]> {
    try {
        const { data: homeHtml } = await axios.get(baseUrl, { timeout: 10000 });
        const $ = cheerio.load(homeHtml);
        const urls: string[] = [];
        
        $('a').each((_i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            
            if (href && (text.includes('menu') || text.includes('carte') || text.includes('food'))) {
                try {
                    const absoluteUrl = new URL(href, baseUrl).href;
                    if (new URL(absoluteUrl).hostname === domain) {
                        urls.push(absoluteUrl);
                    }
                } catch (e) { /* ignore invalid URLs */ }
            }
        });
        
        return urls;
    } catch (e) {
        console.warn("Could not scrape homepage for links.", e);
        return [];
    }
}

async function discoverFromSitemaps(baseUrlObj: URL): Promise<string[]> {
    const sitemapUrls = await findSitemapUrls(baseUrlObj);
    const allUrls: string[] = [];
    
    for (const sitemapUrl of sitemapUrls) {
        const urls = await getUrlsFromSitemap(sitemapUrl);
        allUrls.push(...urls);
    }
    
    return allUrls;
}

// --- Enhanced Scoring ---
function scoreUrlEnhanced(url: string): number {
    const lowerUrl = url.toLowerCase();
    let score = 0;
    
    // File type scoring
    if (lowerUrl.endsWith('.pdf')) score += 60;
    if (lowerUrl.endsWith('.html')) score += 10;
    
    // Keyword scoring with context awareness
    const keywordScores: { [key: string]: number } = {
        'menu': 30, 'carte': 30, 'speisekarte': 30, 'card': 25,
        'food': 20, 'dining': 20, 'restaurant': 15, 'dish': 15,
        'online-ordering': 25, 'order': 15, 'speisen': 15,
        'prix': 10, 'price': 10, 'tarif': 10,
        // Negative keywords
        'contact': -60, 'about': -60, 'blog': -60, 'gallery': -40, 
        'jobs': -60, 'career': -60, 'news': -40, 'event': -30
    };
    
    for (const [keyword, value] of Object.entries(keywordScores)) {
        const matches = (lowerUrl.match(new RegExp(keyword, 'g')) || []).length;
        score += value * matches;
    }
    
    // Path depth penalty (shorter paths often better for menus)
    const pathDepth = url.split('/').length - 3;
    score -= pathDepth * 5;
    
    return score;
}

// --- Enhanced LLM Processing ---
async function structureMenuWithEnhancedLLM(text: string): Promise<Menu> {
    const endpoint = process.env.OLLAMA_API_ENDPOINT || 'http://localhost:11434/api/chat';
    const MAX_CHARS = 20000;
    
    // Preprocess text to improve LLM understanding
    let processedText = text;
    if (text.length > MAX_CHARS) {
        // Smart truncation - keep price-containing sections
        const sections = text.split(/\n\n|\.\s+/);
        const scoredSections = sections.map(section => ({
            text: section,
            score: (section.match(/€|\$|£|CHF|\d+[.,]\d{2}/g) || []).length
        }));
        
        scoredSections.sort((a, b) => b.score - a.score);
        processedText = scoredSections
            .slice(0, Math.floor(MAX_CHARS / 200))
            .map(s => s.text)
            .join(' ');
    }
    
    // Enhanced prompt with better price extraction instructions
    const prompt = `You are a precise menu extraction specialist. Analyze this restaurant text and extract ALL menu items with their exact prices. 

CRITICAL REQUIREMENTS:
1. Extract REAL prices only (€, $, £, CHF, numbers)
2. If no price is visible, use "N/A" but try harder to find prices
3. Group items logically: starters/appetizers, main_courses/mains, desserts, drinks
4. Each item MUST have: "name", "price", optional "description"
5. Be extremely precise - do not invent items or prices
6. Look for price patterns: 15.50, 15,50, 15€, $15, etc.

RESPOND WITH VALID JSON ONLY:
{
  "starters": [{"name": "Item Name", "price": "15.50€", "description": "optional"}],
  "main_courses": [{"name": "Item Name", "price": "25.00€"}],
  "desserts": [{"name": "Item Name", "price": "8.50€"}],
  "drinks": [{"name": "Item Name", "price": "4.00€"}]
}

TEXT TO ANALYZE:
---
${processedText}
---`;

    try {
        const response = await axios.post(endpoint, {
            model: 'mistral:7b',
            messages: [{ role: 'user', content: prompt }],
            format: 'json',
            stream: false,
            options: { 
                temperature: 0.1,
                top_p: 0.9,
                repeat_penalty: 1.1
            }
        }, { timeout: 45000 });

        const result = JSON.parse(response.data.message.content);
        
        // Post-process to fix common issues
        return postProcessMenu(result);
        
    } catch (error: any) {
        console.error("   - Enhanced LLM processing failed:", error.response?.data?.error || error.message);
        throw new Error("Enhanced AI processing failed.");
    }
}

function postProcessMenu(menu: any): Menu {
    // Ensure all required arrays exist
    const processedMenu: Menu = {
        starters: Array.isArray(menu.starters) ? menu.starters : [],
        main_courses: Array.isArray(menu.main_courses) ? menu.main_courses : [],
        desserts: Array.isArray(menu.desserts) ? menu.desserts : [],
        drinks: Array.isArray(menu.drinks) ? menu.drinks : []
    };
    
    // Clean up each item
    Object.keys(processedMenu).forEach(category => {
        const items = processedMenu[category];
        if (Array.isArray(items)) {
            processedMenu[category] = items.map(item => ({
                name: String(item.name || '').trim(),
                price: String(item.price || 'N/A').trim(),
                description: item.description ? String(item.description).trim() : undefined
            })).filter(item => item.name.length > 0);
        }
    });
    
    return processedMenu;
}

// --- Enhanced Validation ---
function isMenuValid(menu: any): menu is Menu {
    if (!menu || typeof menu !== 'object') return false;
    
    const requiredKeys = ['starters', 'main_courses', 'desserts'];
    const hasRequiredKeys = requiredKeys.every(key => Array.isArray(menu[key]));
    if (!hasRequiredKeys) return false;
    
    const allItems = [
        ...(menu.starters || []), 
        ...(menu.main_courses || []), 
        ...(menu.desserts || []),
        ...(menu.drinks || [])
    ];
    
    if (allItems.length < 3) return false;
    
    // Enhanced validation
    const validItems = allItems.filter(item => 
        typeof item.name === 'string' && 
        item.name.length > 2 &&
        typeof item.price === 'string' &&
        (item.price !== 'N/A' || allItems.filter(i => i.price !== 'N/A').length > 0)
    );
    
    // At least 60% of items should be valid, and at least some should have real prices
    const validRatio = validItems.length / allItems.length;
    const hasRealPrices = allItems.some(item => item.price !== 'N/A' && /\d/.test(item.price));
    
    return validRatio >= 0.6 && hasRealPrices;
}

// --- Helper Functions (unchanged but optimized) ---
async function processCandidate(candidateUrl: string): Promise<{ source: 'pdf' | 'html' | 'js', menu: Menu, sourceUrl: string } | null> {
    try {
        const { data, headers } = await axios.get(candidateUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            responseType: 'arraybuffer',
            timeout: 15000,
        });

        const contentType = headers['content-type'] || '';
        let rawText = '';
        let source: 'pdf' | 'html' | 'js' = 'html';

        if (contentType.includes('application/pdf')) {
            source = 'pdf';
            rawText = await extractTextFromPdfWithEnhancedOcr(data);
        } else if (contentType.includes('text/html')) {
            source = 'html';
            rawText = extractTextFromHtmlEnhanced(data.toString('utf-8'));
        }

        if (rawText && rawText.trim().length > 100) {
            const structuredMenu = await structureMenuWithEnhancedLLM(rawText);
            if (isMenuValid(structuredMenu)) {
                return { source, menu: structuredMenu, sourceUrl: candidateUrl };
            }
        }
    } catch (error) {
        console.warn(`Failed to process ${candidateUrl}: ${(error as Error).message}`);
    }
    return null;
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
        // Ignore robots.txt errors
    }
    
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
            const url = $(el).text();
            if (url.toLowerCase().includes('menu') || url.toLowerCase().includes('carte')) {
                urls.push(url);
            }
        });
        
        return urls;
    } catch (error: any) {
        console.warn(`Failed sitemap: ${sitemapUrl}`);
        return [];
    }
}