// Set up the context menu when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "polly-generate-alt",
        title: "🦜 Generate Alt Text with Polly",
        contexts: ["image"]
    });
});

async function processImageGeneration(srcUrl, tabId, currentAlt = '', pageContext = null) {
    try {
        const settings = await chrome.storage.sync.get(['pollyApiKey', 'pollyModel', 'pollyChoices', 'pollyExplain']);
        
        if (!settings.pollyApiKey) {
            chrome.tabs.sendMessage(tabId, { 
                action: "show_error", 
                message: "Polly has no API key! Please right-click the Polly icon and select 'Options' to add your Gemini API Key.",
                srcUrl: srcUrl,
                currentAlt: currentAlt
            });
            return;
        }

        const model = settings.pollyModel || 'gemini-1.5-flash';
        const choiceCount = settings.pollyChoices || 3;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.pollyApiKey}`;

        let analyzedConcept = '';

        // -----------------------------------------------------------------
        // PASS 1: Pure Text Analysis (NO Image Data Sent)
        // -----------------------------------------------------------------
        if (pageContext && !pageContext.isFunctional && (pageContext.paragraphsBefore || pageContext.paragraphsAfter)) {
            const pass1Prompt = `You are an accessibility expert analyzing text surrounding an image in an article.\n\n` +
                `PRECEDING PARAGRAPHS:\n"${pageContext.paragraphsBefore}"\n\n` +
                `FOLLOWING PARAGRAPHS:\n"${pageContext.paragraphsAfter}"\n\n` +
                `TASK:\nIn 1 concise sentence, state what core concept, topic, or metaphor the author is discussing in this text. ` +
                `DO NOT try to guess what the image shows. Focus ONLY on the narrative topic of the words (e.g., "The author is discussing how personalized recommendations make customers feel delighted/jubilant rather than frustrated.").`;

            try {
                const pass1Response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: pass1Prompt }] }] })
                });
                const pass1Data = await pass1Response.json();
                if (pass1Response.ok && pass1Data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    analyzedConcept = pass1Data.candidates[0].content.parts[0].text.trim();
                }
            } catch (e) {
                // Silent fallback if Pass 1 fails
            }
        }

        // -----------------------------------------------------------------
        // PASS 2: Vision Alt Generation Grounded in Pass 1 Concept
        // -----------------------------------------------------------------
        // Fetch the image and convert to Base64 (handles both HTTP URLs and uploaded Data URLs)
        let mimeType = 'image/jpeg';
        let base64Data = '';

        if (srcUrl.startsWith('data:')) {
            const parts = srcUrl.split(',');
            mimeType = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
            base64Data = parts[1];
        } else {
            const imgResponse = await fetch(srcUrl);
            const imgBlob = await imgResponse.blob();
            mimeType = imgBlob.type || 'image/jpeg';
            
            base64Data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.onerror = () => reject(new Error("Failed to read image data"));
                reader.readAsDataURL(imgBlob);
            });
        }

        let contextInstructions = '';

        if (pageContext?.isFunctional) {
            contextInstructions = `STRICT FUNCTIONAL LINK / BUTTON RULES:\n` +
                `This image acts as an interactive ${pageContext.functionalRole.toUpperCase()} (Target: "${pageContext.destination}").\n` +
                `- ULTRA-CONCISE MANDATE: Functional alt text MUST be as brief as possible (typically 2 to 5 words maximum).\n` +
                `- State ONLY the brand or organization name and the primary destination/action (e.g., "SeaMonster Studios Home", "SeaMonster Studios Homepage", "SeaMonster Studios").\n` +
                `- ABSOLUTE PROHIBITION ON MARKETING FLUFF: DO NOT add service descriptions, taglines, or explanatory descriptors (e.g. NEVER write "...for creative design and web development").\n` +
                `- ABSOLUTE PROHIBITION ON META-EXPLANATIONS: NEVER write phrases like "acting as a link", "redirects to", "navigation button", "logo icon", etc.\n\n`;
        } else if (analyzedConcept) {
            contextInstructions = `STRICT EDITORIAL THEME (FROM SURROUNDING TEXT):\n` +
                `"${analyzedConcept}"\n\n` +
                `THE "SHOW, DON'T TELL" ACCESSIBILITY MANDATE:\n` +
                `1. SHOW (Use Context for Visual Emphasis): The surrounding text is about "${analyzedConcept}". Use this theme to decide WHICH visible details, facial expressions, or actions in the image to highlight (e.g., emphasize visible feelings of joy, delight, or excitement).\n` +
                `2. DON'T TELL (Zero Editorializing): Describe ONLY physical visual realities. NEVER preach the article's business thesis or abstract lesson inside the alt text.\n` +
                `3. ABSOLUTE PROHIBITION ON META-PHRASES: NEVER use words like "illustrating...", "representing...", "symbolizing...", "showing how...", "a metaphor for...", or "demonstrating...". The alt text must remain a pure, vivid description of what is seen.\n\n`;
        }

        const prompt = `You are an accessibility expert writing alt text for a web image.\n` +
            `The current alt text on the page for this image is: "${currentAlt || 'None set'}".\n\n` +
            `${contextInstructions}` +
            `TASKS:\n` +
            `1. Provide a 1-2 sentence critique of the current alt text against accessibility standards.\n` +
            `2. Generate exactly ${choiceCount} distinct alt text variations following rules:\n` +
            `- Each alt text should be as close to 125 characters as possible without going over\n` +
            `- Do NOT begin with "image of", "photo of", "picture of", or similar\n` +
            `- Write in plain language, present tense, active voice\n` +
            `- Do NOT use double quotes (") inside property values\n\n` +
            `Return ONLY a valid JSON object with these exact keys:\n` +
            `- "current_analysis": "1-2 sentence evaluation string of current alt text",\n` +
            `- "choices": a JSON array of objects, each containing "alt" and "explanation"\n\n` +
            `Do not include markdown formatting outside the JSON object.`;

        const payload = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64Data } }
                ]
            }],
            generationConfig: { responseMimeType: 'application/json' }
        };

        const aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await aiResponse.json();

        if (!aiResponse.ok) {
            const isQuotaError = aiResponse.status === 429 || 
                                 (data.error?.message || '').toLowerCase().includes('quota') || 
                                 (data.error?.message || '').includes('RESOURCE_EXHAUSTED');

            if (isQuotaError) {
                throw new Error(
                    "Squawk! You've reached your free Gemini API rate limit or daily quota.\n\n" +
                    "Tip: You can enable pay-as-you-go billing on your API key at Google AI Studio. " +
                    "Gemini Flash is so inexpensive that auditing hundreds of images will only cost a few pennies!"
                );
            }
            throw new Error(data.error?.message || "Unknown Gemini API error");
        }

        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error("Gemini returned an empty response.");
        }

        let rawText = data.candidates[0].content.parts[0].text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        let parsedResult;
        try {
            parsedResult = JSON.parse(rawText);
        } catch (jsonErr) {
            console.warn("Polly JSON Parse Warning:", rawText);
            throw new Error("Blimey, the AI sent back a scrambled message! Please click 'Try Again'.");
        }

        // Always display Pass 1's true text concept in the modal badge
        const finalContextDisplay = pageContext?.isFunctional 
            ? `Functional ${pageContext.functionalRole} pointing to ${pageContext.destination}`
            : (analyzedConcept || 'No surrounding paragraph context found');

        chrome.tabs.sendMessage(tabId, { 
            action: "populate_modal", 
            contextSummary: finalContextDisplay,
            analysis: parsedResult.current_analysis || '',
            choices: parsedResult.choices || [],
            srcUrl: srcUrl,
            currentAlt: currentAlt,
            showExplanation: settings.pollyExplain !== false
        });

    } catch (err) {
        chrome.tabs.sendMessage(tabId, { 
            action: "show_error", 
            message: "🦜 Polly Error: " + err.message,
            srcUrl: srcUrl,
            currentAlt: currentAlt
        });
    }
}

// Handle right-click action
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "polly-generate-alt" && info.srcUrl) {
        chrome.tabs.sendMessage(tab.id, { 
            action: "show_generating_modal", 
            srcUrl: info.srcUrl 
        });
        processImageGeneration(info.srcUrl, tab.id, '');
    }
});

// Listener for 'Make it Fit' compression, 'Try Again' retries, and Options Page navigation
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "open_options") {
        chrome.runtime.openOptionsPage();
        return;
    }

    if (request.action === "retry_generation" && request.srcUrl && sender.tab) {
        processImageGeneration(request.srcUrl, sender.tab.id, request.currentAlt || '', request.pageContext || null);
        return;
    }

    if (request.action === "compress_text") {
        (async () => {
            try {
                const settings = await chrome.storage.sync.get(['pollyApiKey', 'pollyModel']);
                const model = settings.pollyModel || 'gemini-1.5-flash';
                
                const fitPrompt = `You are an accessibility expert. Compress the following alternative text so it fits perfectly under a strict 125-character budget. Return ONLY the refined alt text string, no markdown.\n\nText to compress: "${request.text}"`;
                
                const payload = { contents: [{ parts: [{ text: fitPrompt }] }] };
                
                const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.pollyApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const data = await aiResponse.json();
                let refinedText = data.candidates[0].content.parts[0].text.trim().replace(/^["']|["']$/g, '').trim();
                
                sendResponse({ success: true, text: refinedText });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true; // Keep message channel open for async response
    }
});
// Toggle the floating panel on the current page when the extension toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: "toggle_polly_panel" });
    }
});