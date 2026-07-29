document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('api-key');
    const modelSelect = document.getElementById('model-select');

    // Fetch live multimodal models from Gemini API
    async function fetchAvailableModels(apiKey) {
        if (!apiKey) return [];
        try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            if (!resp.ok) return [];
            const data = await resp.json();
            if (!data.models || !Array.isArray(data.models)) return [];

            const models = [];
            data.models.forEach(m => {
                if (!m.name || !m.supportedGenerationMethods) return;
                if (!m.supportedGenerationMethods.includes('generateContent')) return;

                const cleanName = m.name.replace('models/', '');
                
                // Exclude specialized, non-standard, agentic, or Interactions-API-only models
                const forbidden = ['embedding', 'text', 'aqa', 'tuning', 'omni', 'deep-research', 'interactions', 'bidi', 'realtime', 'live', 'imagen', 'veo'];
                if (forbidden.some(word => cleanName.toLowerCase().includes(word))) {
                    return;
                }

                models.push({
                    id: cleanName,
                    displayName: m.displayName || cleanName
                });
            });
            return models;
        } catch (e) {
            console.warn('Polly Alt: Error fetching models', e);
            return [];
        }
    }

    async function loadAndPopulateModels(apiKey, savedModel) {
        modelSelect.innerHTML = '<option value="">Fetching live models...</option>';
        modelSelect.disabled = true;

        if (!apiKey) {
            modelSelect.innerHTML = '<option value="">— Enter API Key Above First —</option>';
            return;
        }

        const models = await fetchAvailableModels(apiKey);
        modelSelect.innerHTML = '';

        if (models.length === 0) {
            modelSelect.innerHTML = '<option value="">— No Compatible Models Found (Check Key) —</option>';
            return;
        }

        // Recommend the newest standard numbered Flash model (e.g. gemini-1.5-flash, gemini-2.0-flash, gemini-2.5-flash)
        let recommendedModel = '';
        models.forEach(m => {
            const isStandardFlash = /^gemini-\d+(\.\d+)?-flash/i.test(m.id);
            if (isStandardFlash) {
                if (!recommendedModel || m.id.localeCompare(recommendedModel, undefined, { numeric: true, sensitivity: 'base' }) > 0) {
                    recommendedModel = m.id;
                }
            }
        });
        
        // Fallback to any flash model, or first available model
        if (!recommendedModel) {
            const anyFlash = models.find(m => m.id.includes('-flash'));
            recommendedModel = anyFlash ? anyFlash.id : (models[0] ? models[0].id : '');
        }

        const targetModel = (savedModel && models.some(m => m.id === savedModel)) ? savedModel : recommendedModel;

        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = (m.id === recommendedModel) ? `${m.displayName} (Recommended)` : m.displayName;
            if (m.id === targetModel) opt.selected = true;
            modelSelect.appendChild(opt);
        });

        modelSelect.disabled = false;
    }

    // Load saved settings on startup
    chrome.storage.sync.get(['pollyApiKey', 'pollyModel', 'pollyChoices', 'pollyExplain'], (items) => {
        if (items.pollyApiKey) {
            apiKeyInput.value = items.pollyApiKey;
            loadAndPopulateModels(items.pollyApiKey, items.pollyModel);
        }
        if (items.pollyChoices) document.getElementById('choices').value = items.pollyChoices;
        document.getElementById('explain').checked = items.pollyExplain !== false;
    });

    // Automatically re-fetch models when API key changes or loses focus
    apiKeyInput.addEventListener('blur', () => {
        const key = apiKeyInput.value.trim();
        chrome.storage.sync.get(['pollyModel'], (items) => {
            loadAndPopulateModels(key, items.pollyModel);
        });
    });

    // Save settings
    document.getElementById('save-btn').addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        const model = modelSelect.value;
        const choices = parseInt(document.getElementById('choices').value, 10);
        const explain = document.getElementById('explain').checked;

        if (!apiKey) {
            alert('Please enter a valid Gemini API Key.');
            return;
        }

        chrome.storage.sync.set({
            pollyApiKey: apiKey,
            pollyModel: model,
            pollyChoices: choices,
            pollyExplain: explain
        }, () => {
            const btn = document.getElementById('save-btn');
            btn.textContent = '✅ Saved!';
            setTimeout(() => { btn.textContent = 'Save Settings'; }, 2000);
        });
    });
});