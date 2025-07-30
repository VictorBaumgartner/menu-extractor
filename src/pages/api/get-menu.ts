// src/pages/api/get-menu.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import { getMenuFromUrl, MenuExtractionError } from '@/lib/menuExtractor';

// Define the structure for a successful response
type SuccessResponse = {
    source: 'pdf' | 'html';
    menu: object; // The structured JSON menu
};

// Define the structure for an error response
type ErrorResponse = {
    error: string;
    details?: string;
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<SuccessResponse | ErrorResponse>
) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required in the request body.' });
    }

    try {
        // Validate URL format
        new URL(url);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid URL format provided.' });
    }

    try {
        console.log(`Starting menu extraction for: ${url}`);
        const result = await getMenuFromUrl(url);
        console.log(`Successfully extracted menu from ${result.source}.`);
        return res.status(200).json(result);
    } catch (error) {
        console.error(`[API Handler] Error processing ${url}:`, error);
        if (error instanceof MenuExtractionError) {
             return res.status(error.statusCode).json({
                error: error.message,
                details: error.details,
            });
        }
        return res.status(500).json({
            error: 'An unexpected internal server error occurred.',
            details: (error as Error).message,
        });
    }
}