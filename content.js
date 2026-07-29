const ALT_TEXT_TIPS = [
    'Keep it snappy — aim for about 20% shorter than a standard text message, roughly 125 characters or less.',
    'Skip "image of" or "photo of" — screen readers already announce that it\'s an image.',
    'Describe what\'s actually visible — save interpretation and assumptions for the caption.',
    'Keep sentences plain and simple — screen readers read alt text aloud, word for word.'
];

let pollyPanel = null;
let pollyModalOverlay = null;
let tipInterval = null;
let activeRowTarget = null; // Tracks which image row initiated AI generation

// -------------------------------------------------------------------------
// Message Listener
// -------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggle_polly_panel") {
        togglePollyPanel();
    } else if (request.action === "show_generating_modal") {
        buildModal(request.srcUrl);
    } else if (request.action === "populate_modal") {
        populateModal(request.choices, request.srcUrl, request.showExplanation, request.analysis, request.currentAlt, request.contextSummary);
    } else if (request.action === "show_error") {
        showError(request.message, request.srcUrl, request.currentAlt);
    }
});

// -------------------------------------------------------------------------
// Helper Utilities & Toast
// -------------------------------------------------------------------------
function showToast(message) {
    const panel = document.getElementById('polly-audit-panel');
    const targetContainer = panel || document.body;

    const existing = targetContainer.querySelector('.polly-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'polly-toast';
    toast.textContent = message;
    targetContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, 2200);
}

function getFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url, window.location.href);
        const path = urlObj.pathname;
        const filename = path.substring(path.lastIndexOf('/') + 1);
        return filename || 'image.jpg';
    } catch {
        return 'image.jpg';
    }
}

// -------------------------------------------------------------------------
// Persistent Draggable Panel
// -------------------------------------------------------------------------

// Scrapes functional role and climbs parent wrappers to find preceding & following paragraph text
function extractImageContext(imgSrc) {
    console.log("🦜 POLLY SCRAPER: Searching DOM for image source:", imgSrc);

    const context = {
        isFunctional: false,
        functionalRole: '',
        destination: '',
        paragraphsBefore: '',
        paragraphsAfter: ''
    };

    // 1. Locate matching <img> in DOM (with URL & filename fallback matching)
    const allImgs = Array.from(document.querySelectorAll('img'));
    let imgEl = allImgs.find(i => i.src === imgSrc || i.currentSrc === imgSrc);

    if (!imgEl && imgSrc) {
        const cleanTarget = imgSrc.split('?')[0].split('#')[0];
        imgEl = allImgs.find(i => {
            const s = (i.src || i.currentSrc || '').split('?')[0].split('#')[0];
            return s && (s === cleanTarget || s.endsWith(cleanTarget) || cleanTarget.endsWith(s));
        });
    }

    if (!imgEl) {
        console.warn("🦜 POLLY SCRAPER: ❌ Could not match <img> tag in DOM for:", imgSrc);
        return context;
    }

    console.log("🦜 POLLY SCRAPER: ✅ Found <img> element:", imgEl);

    // 2. Check Functional Roles (Link or Button wrapper)
    const linkParent = imgEl.closest('a');
    const buttonParent = imgEl.closest('button, [role="button"], input[type="image"]');

    if (linkParent) {
        context.isFunctional = true;
        context.functionalRole = 'link';
        context.destination = linkParent.getAttribute('href') || linkParent.getAttribute('aria-label') || '';
        console.log("🦜 POLLY SCRAPER: Image is a Link -> Destination:", context.destination);
        return context;
    } else if (buttonParent) {
        context.isFunctional = true;
        context.functionalRole = 'button';
        context.destination = buttonParent.getAttribute('aria-label') || buttonParent.getAttribute('title') || buttonParent.innerText.trim() || 'Trigger action';
        console.log("🦜 POLLY SCRAPER: Image is a Button -> Action:", context.destination);
        return context;
    }

    // Helper: Extracts paragraph text from an element or its child <p> tags
    function extractTextFromElement(el) {
        if (!el || el.nodeType !== 1) return [];
        if (el.closest('#polly-audit-panel, #polly-alt-modal-overlay, script, style, nav, header, footer')) return [];

        if (el.tagName === 'P') {
            const txt = el.innerText ? el.innerText.trim() : '';
            return txt.length > 20 ? [txt] : [];
        }

        // If it's a wrapper container (figure, div, section), check for internal <p> elements
        const childPs = Array.from(el.querySelectorAll('p, blockquote, li'))
            .map(p => p.innerText ? p.innerText.trim() : '')
            .filter(txt => txt.length > 20);

        if (childPs.length > 0) return childPs;

        const fallback = el.innerText ? el.innerText.trim() : '';
        return (fallback.length > 20 && fallback.length < 1500) ? [fallback] : [];
    }

    // 3. Walk UP and BACKWARDS to find PRECEDING paragraphs
    let beforeTexts = [];
    let curr = imgEl;

    while (curr && curr !== document.body && beforeTexts.length < 2) {
        if (curr.previousElementSibling) {
            curr = curr.previousElementSibling;
            const extracted = extractTextFromElement(curr);
            extracted.forEach(txt => {
                if (!beforeTexts.includes(txt)) {
                    beforeTexts.unshift(txt); // Keep reading order
                }
            });
        } else {
            curr = curr.parentElement; // Step up wrapper container
        }
    }

    // 4. Walk UP and FORWARDS to find FOLLOWING paragraphs
    let afterTexts = [];
    curr = imgEl;

    while (curr && curr !== document.body && afterTexts.length < 1) {
        if (curr.nextElementSibling) {
            curr = curr.nextElementSibling;
            const extracted = extractTextFromElement(curr);
            extracted.forEach(txt => {
                if (!afterTexts.includes(txt)) {
                    afterTexts.push(txt);
                }
            });
        } else {
            curr = curr.parentElement; // Step up wrapper container
        }
    }

    context.paragraphsBefore = beforeTexts.slice(-2).join('\n\n');
    context.paragraphsAfter = afterTexts.slice(0, 1).join('\n\n');

    console.log("🦜 POLLY SCRAPED PRECEDING PARAGRAPHS:\n", context.paragraphsBefore || "(None found)");
    console.log("🦜 POLLY SCRAPED FOLLOWING PARAGRAPHS:\n", context.paragraphsAfter || "(None found)");

    return context;
}
function togglePollyPanel() {
    if (pollyPanel) {
        pollyPanel.style.display = (pollyPanel.style.display === 'none') ? 'flex' : 'none';
        if (pollyPanel.style.display === 'flex') refreshImageScanner();
        return;
    }

    pollyPanel = document.createElement('div');
    pollyPanel.id = 'polly-audit-panel';
    pollyPanel.innerHTML = `
        <div id="polly-panel-header">
            <span class="polly-panel-title">🦜 Polly Alt Assistant</span>
            <div class="polly-panel-header-actions">
                <button type="button" id="polly-panel-settings-btn" aria-label="Settings">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                </button>
                <button type="button" id="polly-panel-close-btn" aria-label="Close Panel">&times;</button>
            </div>
        </div>
        <div id="polly-panel-controls">
            <button type="button" class="polly-panel-btn primary" id="polly-add-checked-btn">➕ Add Checked to Queue</button>
            <button type="button" class="polly-panel-btn" id="polly-export-btn">📥 Export (<span id="polly-queue-count">0</span>)</button>
            <button type="button" class="polly-panel-btn danger" id="polly-clear-queue-btn">🗑️ Clear</button>
        </div>
        <div id="polly-image-list"></div>
    `;

    document.body.appendChild(pollyPanel);
    makeElementDraggable(pollyPanel, document.getElementById('polly-panel-header'));

    // Control button handlers
    document.getElementById('polly-panel-close-btn').onclick = () => pollyPanel.style.display = 'none';
    document.getElementById('polly-panel-settings-btn').onclick = () => chrome.runtime.sendMessage({ action: "open_options" });
    document.getElementById('polly-clear-queue-btn').onclick = clearQueue;
    document.getElementById('polly-export-btn').onclick = exportQueue;
    document.getElementById('polly-add-checked-btn').onclick = addCheckedToQueue;

    updateQueueCountDisplay();
    refreshImageScanner();
}

function makeElementDraggable(panel, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = () => {
            document.onmouseup = null;
            document.onmousemove = null;
        };
        document.onmousemove = (e) => {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            panel.style.top = (panel.offsetTop - pos2) + "px";
            panel.style.left = (panel.offsetLeft - pos1) + "px";
        };
    };
}

// -------------------------------------------------------------------------
// On-Page Image Scanner & List Renderer
// -------------------------------------------------------------------------
function refreshImageScanner() {
    const listContainer = document.getElementById('polly-image-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    // Find all images on webpage excluding extension overlays
    const images = Array.from(document.querySelectorAll('img')).filter(img => {
        return !img.closest('#polly-audit-panel') && !img.closest('#polly-alt-modal-overlay') && img.src;
    });

    if (images.length === 0) {
        listContainer.innerHTML = '<div class="polly-empty-notice">No visible images found on this page.</div>';
        return;
    }

    images.forEach((img, index) => {
        const src = img.src;
        const currentAlt = img.getAttribute('alt') || '';
        const filename = getFilenameFromUrl(src);

        const row = document.createElement('div');
        row.className = 'polly-image-row';
        row.dataset.index = index;
        row.dataset.src = src;
        row.dataset.filename = filename;

        row.innerHTML = `
            <div class="polly-row-thumb">
                <img src="${src}" alt="">
            </div>
            <div class="polly-row-details">
                <div class="polly-row-filename" title="${filename}">${filename}</div>
                <div class="polly-row-alt-display ${currentAlt ? '' : 'no-alt'}">
                    ${currentAlt ? escapeHtml(currentAlt) : '<em>No alt text set</em>'}
                </div>
                <button type="button" class="polly-row-gen-btn">✨ Preview & Generate</button>
            </div>
            <div class="polly-row-check-wrap">
                <input type="checkbox" class="polly-row-checkbox" title="Select to queue for export">
            </div>
        `;

        const checkbox = row.querySelector('.polly-row-checkbox');
        checkbox.addEventListener('change', () => {
            row.classList.toggle('is-checked', checkbox.checked);
        });

        // Connect "Preview & Generate" directly to the modal context
        row.querySelector('.polly-row-gen-btn').onclick = () => {
            activeRowTarget = row;
            const currentAltText = row.querySelector('.polly-row-alt-display').innerText.trim();
            const cleanAlt = (currentAltText === 'No alt text set') ? '' : currentAltText;
            
            const imageContext = extractImageContext(src);

            buildModal(src);
            chrome.runtime.sendMessage({ 
                action: "retry_generation", 
                srcUrl: src,
                currentAlt: cleanAlt,
                pageContext: imageContext
            });
        };

        listContainer.appendChild(row);
    });
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// -------------------------------------------------------------------------
// Queue Management
// -------------------------------------------------------------------------
function updateQueueCountDisplay() {
    chrome.storage.local.get(['pollyQueue'], (result) => {
        const queue = result.pollyQueue || [];
        const exportBtn = document.getElementById('polly-export-btn');
        if (exportBtn) {
            exportBtn.innerHTML = `📥 Export (<span id="polly-queue-count">${queue.length}</span>)`;
        }
    });
}

function addCheckedToQueue() {
    const rows = document.querySelectorAll('.polly-image-row');
    let addedCount = 0;

    chrome.storage.local.get(['pollyQueue'], (result) => {
        const queue = result.pollyQueue || [];

        rows.forEach(row => {
            const checkbox = row.querySelector('.polly-row-checkbox');
            if (checkbox && checkbox.checked) {
                const altText = row.querySelector('.polly-row-alt-display').innerText.trim();
                const filename = row.dataset.filename;
                const src = row.dataset.src;

                if (altText && altText !== 'No alt text set') {
                    queue.push({ filename: filename, alt: altText, url: src });
                    checkbox.checked = false; // reset check state
                    row.classList.remove('is-checked');
                    addedCount++;
                }
            }
        });

        if (addedCount === 0) {
            showToast("⚠️ Select an image with alt text first!");
            return;
        }

        chrome.storage.local.set({ pollyQueue: queue }, () => {
            // Trigger Stateful Button Micro-interaction on Export button
            const exportBtn = document.getElementById('polly-export-btn');
            if (exportBtn) {
                exportBtn.classList.add('btn-flash-success');
                exportBtn.innerHTML = `✅ +${addedCount} Added!`;

                setTimeout(() => {
                    exportBtn.classList.remove('btn-flash-success');
                    updateQueueCountDisplay();
                }, 1800);
            } else {
                updateQueueCountDisplay();
            }
        });
    });
}

function clearQueue() {
    if (confirm("Are you sure you want to clear your export queue?")) {
        chrome.storage.local.set({ pollyQueue: [] }, updateQueueCountDisplay);
    }
}

function exportQueue() {
    chrome.storage.local.get(['pollyQueue'], (result) => {
        const queue = result.pollyQueue || [];
        if (queue.length === 0) {
            alert("Your export queue is currently empty!");
            return;
        }

        const exportText = queue.map(item => `${item.filename}\n${item.alt}`).join('\n\n');
        const blob = new Blob([exportText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'polly-alt-export.txt';
        a.click();
        URL.revokeObjectURL(url);
    });
}

// -------------------------------------------------------------------------
// Choice Generation Modal
// -------------------------------------------------------------------------
function buildModal(imgSrc) {
    if (pollyModalOverlay) pollyModalOverlay.remove();

    pollyModalOverlay = document.createElement('div');
    pollyModalOverlay.id = 'polly-alt-modal-overlay';
    pollyModalOverlay.innerHTML = `
        <div id="polly-alt-modal" role="dialog" aria-modal="true">
            <div class="polly-modal-image-container">
                <img src="${imgSrc}" alt="">
            </div>
            <div class="polly-modal-header"><h3 id="polly-modal-title">🦜 Hang tight…</h3></div>
            <div class="polly-modal-body" id="polly-modal-body">
                <p class="polly-modal-intro">Get a good look at the image while I'm working on some alt text options for you…</p>
                <div class="polly-tip-rotator"><span class="polly-tip-text"></span></div>
                <div class="polly-modal-btn-row">
                    <button type="button" class="polly-footer-btn" id="polly-cancel-btn">Cancel</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(pollyModalOverlay);

    const tipText = pollyModalOverlay.querySelector('.polly-tip-text');
    let tipIndex = 0;
    tipText.textContent = ALT_TEXT_TIPS[tipIndex];
    tipInterval = setInterval(() => {
        tipIndex = (tipIndex + 1) % ALT_TEXT_TIPS.length;
        tipText.textContent = ALT_TEXT_TIPS[tipIndex];
    }, 8000);

    pollyModalOverlay.querySelector('#polly-cancel-btn').onclick = dismissModal;
}

function showError(message, srcUrl, currentAlt = '') {
    clearInterval(tipInterval);
    document.getElementById('polly-modal-title').textContent = '🦜 Squawk! Something went sideways.';

    let retryBtnHtml = srcUrl ? `<button type="button" class="polly-footer-btn" id="polly-retry-btn" style="background:#2271b1; color:#fff; border:none; margin-bottom:10px;">✏️ Try Again</button>` : '';

    document.getElementById('polly-modal-body').innerHTML = `
        <p style="font-size:15px; line-height:1.6; color: #d63638;">${message}</p>
        <div class="polly-modal-btn-row" style="display:flex; flex-direction:column; gap:8px;">
            ${retryBtnHtml}
            <button type="button" class="polly-footer-btn" id="polly-error-close-btn">Close</button>
        </div>
    `;

    if (srcUrl && document.getElementById('polly-retry-btn')) {
        document.getElementById('polly-retry-btn').onclick = () => {
            buildModal(srcUrl);
            chrome.runtime.sendMessage({ action: "retry_generation", srcUrl: srcUrl, currentAlt: currentAlt });
        };
    }

    document.getElementById('polly-error-close-btn').onclick = dismissModal;
}

function populateModal(choices, srcUrl, showExplanation, analysis = '', currentAlt = '', contextSummary = '') {
    clearInterval(tipInterval);
    document.getElementById('polly-modal-title').textContent = '🦜 Choose Alt Text';
    const body = document.getElementById('polly-modal-body');
    body.innerHTML = '';

    // --- CONTEXT SUMMARY BADGE ---
    if (contextSummary) {
        const contextBadge = document.createElement('div');
        contextBadge.className = 'polly-context-badge';
        contextBadge.innerHTML = `🧭 <strong>Context Detected:</strong> ${escapeHtml(contextSummary)}`;
        body.appendChild(contextBadge);
    }

    // --- Helper function to attach inline edit functionality to any choice card ---
    function makeCardEditable(item, getInitialText, onTextUpdate) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'polly-modal-edit-btn';
        editBtn.textContent = 'Edit';
        item.appendChild(editBtn);

        let isEditing = false;

        editBtn.onclick = (e) => {
            e.stopPropagation();
            const contentDiv = item.querySelector('.polly-choice-content');
            const charCounter = item.querySelector('.polly-choice-char-count');

            if (!isEditing) {
                isEditing = true;
                editBtn.textContent = 'Done';

                const currentText = contentDiv.textContent.trim() === 'No alt text set' ? '' : contentDiv.textContent.trim();
                const textarea = document.createElement('textarea');
                textarea.className = 'polly-choice-textarea';
                textarea.value = currentText;

                contentDiv.replaceWith(textarea);
                textarea.focus();

                textarea.addEventListener('input', () => {
                    const len = textarea.value.length;
                    charCounter.textContent = `${len} characters`;
                    charCounter.classList.toggle('over-limit', len > 125);
                    onTextUpdate(textarea.value);
                });
            } else {
                isEditing = false;
                editBtn.textContent = 'Edit';

                const textarea = item.querySelector('.polly-choice-textarea');
                const updatedVal = textarea ? textarea.value.trim() : getInitialText();

                const contentDiv = document.createElement('div');
                contentDiv.className = 'polly-choice-content';
                contentDiv.textContent = updatedVal || 'No alt text set';

                textarea.replaceWith(contentDiv);
                onTextUpdate(updatedVal);
            }
        };
    }

    // --- 1. EXISTING ALT ROW (TOP ROW) ---
    const existingItem = document.createElement('div');
    existingItem.className = 'polly-choice-item';
    existingItem.style.borderLeft = '4px solid #666';

    let activeCurrentText = currentAlt;
    const displayAlt = currentAlt || 'No alt text set';
    let analysisHtml = analysis ? `<div class="polly-choice-explanation" style="border-left-color: #666; background: #f9f9f9;">${analysis}</div>` : '';

    existingItem.innerHTML = `
        <div class="polly-choice-select-btn">
            <span class="polly-choice-tag" style="color: #666; font-weight: bold;">CURRENT ALT</span>
            <div class="polly-choice-content">${escapeHtml(displayAlt)}</div>
            <div class="polly-choice-char-count">${currentAlt ? currentAlt.length : 0} characters</div>
            ${analysisHtml}
        </div>
        <div style="display:flex; gap:10px; padding: 0 18px 18px 18px;">
            <button type="button" class="polly-footer-btn polly-select-apply-btn" style="background:#666; color:#fff; border:none;" ${!currentAlt ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>✅ Keep Current Alt</button>
            <button type="button" class="polly-footer-btn polly-copy-btn" ${!currentAlt ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''}>📋 Copy</button>
        </div>
    `;

    makeCardEditable(existingItem, () => activeCurrentText, (newVal) => {
        activeCurrentText = newVal;
        const applyBtn = existingItem.querySelector('.polly-select-apply-btn');
        const copyBtn = existingItem.querySelector('.polly-copy-btn');
        if (newVal) {
            applyBtn.disabled = false;
            applyBtn.style.opacity = '1';
            applyBtn.style.cursor = 'pointer';
            copyBtn.disabled = false;
            copyBtn.style.opacity = '1';
            copyBtn.style.cursor = 'pointer';
        }
    });

    existingItem.querySelector('.polly-copy-btn').onclick = () => {
        navigator.clipboard.writeText(activeCurrentText);
        showToast("📋 Copied current alt text!");
    };

    existingItem.querySelector('.polly-select-apply-btn').onclick = () => {
        if (activeRowTarget && activeCurrentText) {
            const altDisplay = activeRowTarget.querySelector('.polly-row-alt-display');
            altDisplay.innerText = activeCurrentText;
            altDisplay.classList.remove('no-alt');

            const checkbox = activeRowTarget.querySelector('.polly-row-checkbox');
            if (checkbox) {
                checkbox.checked = true;
                activeRowTarget.classList.add('is-checked');
            }
        }
        dismissModal();
    };

    body.appendChild(existingItem);

    // --- 2. AI GENERATED OPTIONS ---
    choices.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'polly-choice-item';

        let activeOptionText = opt.alt;
        let explHtml = (showExplanation && opt.explanation) ? `<div class="polly-choice-explanation">${opt.explanation}</div>` : '';
        const isOver = opt.alt.length > 125;
        let fitBtnHtml = isOver ? `<button type="button" class="polly-modal-fit-btn">Make it Fit</button>` : '';

        item.innerHTML = `
            <div class="polly-choice-select-btn">
                <span class="polly-choice-tag polly-tag-ai">AI OPTION</span>
                <div class="polly-choice-content">${opt.alt}</div>
                <div class="polly-choice-char-count ${isOver ? 'over-limit' : ''}">${opt.alt.length} characters</div>
                ${explHtml}
            </div>
            ${fitBtnHtml}
            <div style="display:flex; gap:10px; padding: 0 18px 18px 18px;">
                <button type="button" class="polly-footer-btn polly-select-apply-btn" style="background:#2271b1; color:#fff; border:none;">✅ Select & Apply</button>
                <button type="button" class="polly-footer-btn polly-copy-btn">📋 Copy</button>
            </div>
        `;

        makeCardEditable(item, () => activeOptionText, (newVal) => {
            activeOptionText = newVal;
        });

        // Make it Fit handler
        const fitBtn = item.querySelector('.polly-modal-fit-btn');
        if (fitBtn) {
            fitBtn.onclick = () => {
                fitBtn.textContent = 'Fitting...';
                fitBtn.disabled = true;
                chrome.runtime.sendMessage({ action: "compress_text", text: activeOptionText }, (res) => {
                    if (res.success) {
                        activeOptionText = res.text;
                        const textarea = item.querySelector('.polly-choice-textarea');
                        if (textarea) textarea.value = res.text;

                        const contentDiv = item.querySelector('.polly-choice-content');
                        if (contentDiv) contentDiv.textContent = res.text;

                        item.querySelector('.polly-choice-char-count').textContent = `${res.text.length} characters`;
                        item.querySelector('.polly-choice-char-count').classList.remove('over-limit');
                        fitBtn.remove();
                    } else {
                        showToast("⚠️ Compression error.");
                        fitBtn.textContent = 'Make it Fit';
                        fitBtn.disabled = false;
                    }
                });
            };
        }

        // Copy button handler
        item.querySelector('.polly-copy-btn').onclick = () => {
            navigator.clipboard.writeText(activeOptionText);
            showToast("📋 Copied to clipboard!");
        };

        // Select & Apply Handler
        item.querySelector('.polly-select-apply-btn').onclick = () => {
            if (activeRowTarget && activeOptionText) {
                const altDisplay = activeRowTarget.querySelector('.polly-row-alt-display');
                altDisplay.innerText = activeOptionText;
                altDisplay.classList.remove('no-alt');

                const checkbox = activeRowTarget.querySelector('.polly-row-checkbox');
                if (checkbox) {
                    checkbox.checked = true;
                    activeRowTarget.classList.add('is-checked');
                }
            }
            dismissModal();
        };

        body.appendChild(item);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'polly-footer-btn';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '15px';
    closeBtn.onclick = dismissModal;
    body.appendChild(closeBtn);
}

function dismissModal() {
    clearInterval(tipInterval);
    if (pollyModalOverlay) pollyModalOverlay.remove();
}