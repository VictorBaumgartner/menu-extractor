"use client"; // This is crucial! It tells Next.js this is a client-side component that can use state and handle user interactions.

import { useState, FormEvent } from 'react';

// Define the structure of the menu for TypeScript
interface MenuItem {
    name: string;
    price: string;
    description?: string;
}

interface Menu {
    starters: MenuItem[];
    main_courses: MenuItem[];
    desserts: MenuItem[];
    [key: string]: MenuItem[]; // Allows for other categories like 'drinks'
}

export default function HomePage() {
    // State variables to manage the form and results
    const [url, setUrl] = useState<string>('');
    const [menu, setMenu] = useState<Menu | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault(); // Prevent the default form submission
        setIsLoading(true);
        setError(null);
        setMenu(null);

        try {
            // This is the call from your frontend UI to your backend API endpoint
            const response = await fetch('/api/get-menu', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url }), // Send the URL in the request body
            });

            const data = await response.json();

            if (!response.ok) {
                // Handle errors from the API (e.g., 400, 500 status codes)
                throw new Error(data.error || 'An unknown error occurred.');
            }

            setMenu(data.menu); // On success, store the menu data
        } catch (err: any) {
            setError(err.message); // On failure, store the error message
        } finally {
            setIsLoading(false); // Stop the loading indicator
        }
    };

    return (
        <main className="flex min-h-screen flex-col items-center p-12 bg-gray-50">
            <div className="z-10 w-full max-w-4xl items-center justify-between font-mono text-sm">
                <h1 className="text-4xl font-bold text-center mb-2 text-gray-800">
                    Restaurant Menu Extractor
                </h1>
                <p className="text-center text-gray-500 mb-8">
                    Enter a restaurant's URL to extract its menu as structured JSON.
                </p>

                <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2 mb-8">
                    <input
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://www.example-restaurant.com"
                        required
                        className="flex-grow p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                    />
                    <button
                        type="submit"
                        disabled={isLoading}
                        className="bg-blue-600 text-white font-bold py-3 px-6 rounded-md hover:bg-blue-700 transition disabled:bg-gray-400 disabled:cursor-not-allowed"
                    >
                        {isLoading ? 'Extracting...' : 'Get Menu'}
                    </button>
                </form>

                {/* Conditional Rendering for Results */}
                <div className="w-full bg-white rounded-lg shadow-md p-6 border border-gray-200 min-h-[200px]">
                    {isLoading && (
                        <div className="flex justify-center items-center h-full">
                            <p className="text-gray-500">Loading, please wait...</p>
                        </div>
                    )}

                    {error && (
                        <div className="text-red-600 bg-red-50 p-4 rounded-md">
                            <h3 className="font-bold">Error</h3>
                            <p>{error}</p>
                        </div>
                    )}

                    {menu && (
                        <div>
                            <h2 className="text-2xl font-semibold mb-4 text-gray-700">Extracted Menu:</h2>
                            <pre className="bg-gray-900 text-white p-4 rounded-md overflow-x-auto">
                                <code>{JSON.stringify(menu, null, 2)}</code>
                            </pre>
                        </div>
                    )}
                     {!isLoading && !error && !menu && (
                        <div className="flex justify-center items-center h-full">
                            <p className="text-gray-400">Results will be displayed here.</p>
                        </div>
                     )}
                </div>
            </div>
        </main>
    );
}