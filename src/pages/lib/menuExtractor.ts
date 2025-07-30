// src/lib/menuExtractor.ts

import axios from 'axios';
import * as cheerio from 'cheerio';
import pdf from 'pdf-parse';
// To use Tesseract for image-based PDFs, you would uncomment this
// import { createWorker } from 'tesseract.js';

// --- Type Definitions (no changes here) ---
interface MenuItem {
    name: string;
    price: string;
    description?: string;
}

interface Menu {
    starters: MenuItem[];
    main_courses: MenuItem[];
    desserts: MenuItem[];
    drinks?: MenuItem[];
    other?: MenuItem[];
}

// --- Custom Error Class (no changes here) ---
export class MenuExtractionError extends Error {
    statusCode: number;
    details?: string;
    constructor(message: string, statusCode: number = 500, details?: string) {
        super(message);
        this.name = 'MenuExtractionError';
        this.statusCode = statusCode;
        this.details = details;
    }
}


// --- Main Orchestrator Function (no changes here) ---
export async function getMenuFromUrl(url: string): Promise<{ source: 'pdf' | 'html', menu: Menu }> {
    const { data: initialData, headers } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
        responseType: 'arraybuffer'
    });

    const contentType = headers['content-type'] || '';
    let rawText = '';
    let source: 'pdf' | 'html' = 'html';

    if (contentType.includes('application/pdf')) {
        console.log("Direct PDF link detected. Processing PDF...");
        source = 'pdf';
        rawText = await extractTextFromPdf(initialData);
    } else if (contentType.includes('text/html')) {
        console.log("HTML page detected. Searching for menu...");
        const htmlContent = initialData.toString('utf-8');
        const pdfUrl = await findPdfMenuLink(htmlContent, url);

        if (pdfUrl) {
            console.log(`Found PDF menu link: ${pdfUrl}. Downloading and processing...`);
            source = 'pdf';
            const pdfResponse = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
            rawText = await extractTextFromPdf(pdfResponse.data);
        } else {
            console.log("No PDF link found. Extracting text directly from HTML body.");
            source = 'html';
            rawText = extractTextFromHtml(htmlContent);
        }
    } else {
        throw new MenuExtractionError(`Unsupported content type: ${contentType}`, 415);
    }

    if (!rawText || rawText.trim().length < 50) {
        throw new MenuExtractionError("Could not extract meaningful text from the source.", 422);
    }

    console.log("Raw text extracted. Sending to Ollama for structuring...");
    const structuredMenu = await structureMenuWithLLM(rawText);
    return { source, menu: structuredMenu };
}


// --- Helper Functions (no changes here) ---

async function findPdfMenuLink(html: string, baseUrl: string): Promise<string | null> {
    const $ = cheerio.load(html);
    let pdfLink: string | null = null;
    $('a').each((_i, elem) => {
        const href = $(elem).attr('href');
        const text = $(elem).text().toLowerCase();
        if (href && href.endsWith('.pdf')) {
            if (text.includes('menu') || text.includes('carte') || href.includes('menu') || href.includes('carte')) {
                pdfLink = href;
                return false;
            }
        }
    });
    return pdfLink ? new URL(pdfLink, baseUrl).href : null;
}

function extractTextFromHtml(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript').remove();
    const menuSelectors = ['[id*="menu"]', '[class*="menu"]', 'main', 'article', 'section'];
    let text = '';
    for (const selector of menuSelectors) {
        if ($(selector).length > 0) {
            text = $(selector).text();
            break;
        }
    }
    if (!text) text = $('body').text();
    return text.replace(/\s\s+/g, ' ').trim();
}

async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
    try {
        const data = await pdf(pdfBuffer);
        return data.text;
    } catch (error) {
        console.error("pdf-parse failed. This might be an image-only PDF.", error);
        throw new MenuExtractionError("Failed to parse text-based PDF.", 500, "Consider implementing an OCR fallback for image-based PDFs.");
    }
}

// ====================================================================
// ===== SECTION WITH CHANGES FOR OLLAMA ==============================
// ====================================================================

/**
 * Calls a local Ollama instance to structure the raw text into a JSON menu.
 */
async function structureMenuWithLLM(text: string): Promise<Menu> {
    // Get the Ollama endpoint from environment variables, with a sensible default.
    const endpoint = process.env.OLLAMA_API_ENDPOINT || 'http://localhost:11434/api/chat';

    const prompt = `
        Analyze the following restaurant menu text and extract the menu items.
        Structure the output as a valid JSON object.
        The JSON object should have keys: "starters", "main_courses", and "desserts".
        If you find other categories like drinks, salads, or sides, you can add keys like "drinks" or "other".
        Each key should contain an array of objects.
        Each object in the array should have three keys: "name" (string), "price" (string), and "description" (string, optional).
        Extract prices precisely as they appear.
        Do not include items that are not part of the menu (e.g., opening hours, addresses).
        Respond ONLY with the JSON object, starting with { and ending with }. Do not add any explanatory text, markdown formatting, or code blocks.
        Your entire response must be the raw JSON.
    `;

    try {
        const response = await axios.post(
            endpoint,
            {
                // The model name must match one you have pulled with `ollama pull <model_name>`
                model: 'mistral:7b',
                messages: [{ role: 'user', content: prompt }],
                // Key parameters for Ollama to ensure JSON output and a single response
                format: 'json',
                stream: false, // Ensure we get the full response at once
                options: {
                    temperature: 0.1, // Low temperature for deterministic output
                }
            },
            {
                // No Authorization header is needed for a default local Ollama setup
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );

        // Ollama's response structure for non-streaming chat is simpler
        // The JSON content is directly in `response.data.message.content`
        const llmResponseContent = response.data.message.content;

        // The 'extractJsonFromString' helper is still useful in case the LLM
        // accidentally adds whitespace or other text despite the prompt.
        const cleanJsonString = extractJsonFromString(llmResponseContent);

        if (!cleanJsonString) {
             throw new MenuExtractionError("LLM did not return a valid JSON object.", 502, `LLM Raw Response: ${llmResponseContent}`);
        }

        return JSON.parse(cleanJsonString);

    } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
            throw new MenuExtractionError(
                "Connection to Ollama failed.", 503,
                `Could not connect to ${endpoint}. Is Ollama running?`
            );
        }
        console.error("Error calling Ollama API:", error.response?.data || error.message);
        throw new MenuExtractionError("Failed to get a structured response from Ollama.", 502, error.message);
    }
}

/**
 * Extracts a JSON object string from a larger string.
 * This remains useful as a safeguard.
 */
function extractJsonFromString(str: string): string | null {
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        return null;
    }

    return str.substring(firstBrace, lastBrace + 1);
}