// src/pages/api/get-menu.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { getMenuFromUrl, MenuExtractionError } from '@/lib/menuExtractor';

type SuccessResponse = {
    source: 'pdf' | 'html' | 'js';
    menu: object;
    sourceUrl: string;
    extractionTime: number;
    itemCount: number;
    hasRealPrices: boolean;
};

type ErrorResponse = {
    error: string;
    details?: string;
    extractionTime?: number;
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<SuccessResponse | ErrorResponse>
) {
    const startTime = Date.now();
    
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ 
            error: 'Method Not Allowed',
            extractionTime: Date.now() - startTime
        });
    }

    // CORRECTED: The `options` variable was unused and caused an error in the function call.
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ 
            error: 'URL is required in the request body.',
            extractionTime: Date.now() - startTime
        });
    }

    try {
        new URL(url);
    } catch (error) {
        return res.status(400).json({ 
            error: 'Invalid URL format provided.',
            extractionTime: Date.now() - startTime
        });
    }

    try {
        console.log(`[API] Starting enhanced menu extraction for: ${url}`);
        
        // CORRECTED: The getMenuFromUrl function only takes one argument (url).
        // The `options` parameter was removed as it's not defined in the function signature.
        const result = await getMenuFromUrl(url);
        const extractionTime = Date.now() - startTime;
        
        // Calculate statistics
        const allItems = [
            ...(result.menu.starters || []),
            ...(result.menu.main_courses || []),
            ...(result.menu.desserts || []),
            ...((result.menu as any).drinks || [])
        ];
        
        const itemCount = allItems.length;
        const hasRealPrices = allItems.some((item: any) => 
            item.price && item.price !== 'N/A' && /\d/.test(item.price)
        );
        
        console.log(`[API] SUCCESS! Extracted ${itemCount} items in ${extractionTime}ms from ${result.sourceUrl}`);
        console.log(`[API] Real prices found: ${hasRealPrices ? 'Yes' : 'No'}`);
        console.log(`[API] Source type: ${result.source}`);
        
        return res.status(200).json({
            ...result,
            extractionTime,
            itemCount,
            hasRealPrices
        });
        
    } catch (error) {
        const extractionTime = Date.now() - startTime;
        console.error(`[API] Error processing ${url} (${extractionTime}ms):`, error);
        
        if (error instanceof MenuExtractionError) {
            return res.status(error.statusCode).json({
                error: error.message,
                details: error.details,
                extractionTime,
            });
        }
        
        return res.status(500).json({
            error: 'An unexpected internal server error occurred.',
            details: (error as Error).message,
            extractionTime,
        });
    }
}