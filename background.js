// Set up the context menu when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "polly-generate-alt",
        title: "🦜 Generate Alt Text with Polly",
        contexts: ["image"]
    });
});

async function processImageGeneration(srcUrl, tabId, currentAlt = '') {
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
        
        // Fetch the image and convert to Base64
        const imgResponse = await fetch(srcUrl);
        const imgBlob = await imgResponse.blob();
        const mimeType = imgBlob.type || 'image/jpeg';
        
        const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = () => reject(new Error("Failed to read image data"));
            reader.readAsDataURL(imgBlob);
        });

        const prompt = `You are an accessibility expert writing alt text for a web image.\n` +
            `The current alt text on the page for this image is: "${currentAlt || 'None set'}".\n\n` +
            `TASKS:\n` +
            `1. Provide a brief 1-2 sentence critique of the current alt text against web accessibility standards (snappy, under 125 chars, active voice, visual facts only, no "image of"). Phrase it like: "The current alt [evaluation]. It might be stronger if [recommendations]."\n` +
            `2. Generate exactly ${choiceCount} distinct alt text variations following accessibility rules:\n` +
            `- Each alt text should be as close to 125 characters as possible without going over\n` +
            `- Do NOT begin with "image of", "photo of", "picture of", or similar\n` +
            `- Write in plain language, present tense, active voice\n` +
            `- Include only what is visible — no interpretation or assumptions\n` +
            `- Do NOT use double quotes (") inside the property values\n\n` +
            `Return ONLY a valid JSON object with these exact keys:\n` +
            `- "current_analysis": "your 1-2 sentence evaluation string of the current alt text",\n` +
            `- "choices": a JSON array of objects, each containing "alt" and "explanation"\n\n` +
            `Do not include any markdown formatting outside the JSON object.`;

        const payload = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64Data } }
                ]
            }],
            generationConfig: { responseMimeType: 'application/json' }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.pollyApiKey}`;
        
        const aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await aiResponse.json();

        if (!aiResponse.ok) {
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

        chrome.tabs.sendMessage(tabId, { 
            action: "populate_modal", 
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

// Listener for 'Make it Fit' compression and 'Try Again' retries
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "retry_generation" && request.srcUrl && sender.tab) {
        processImageGeneration(request.srcUrl, sender.tab.id, request.currentAlt || '');
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