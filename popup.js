document.addEventListener('DOMContentLoaded', () => {
    const countEl = document.getElementById('queue-count');
    const exportBtn = document.getElementById('export-btn');

    function updateUI() {
        chrome.storage.local.get(['pollyQueue'], (result) => {
            const queue = result.pollyQueue || [];
            countEl.textContent = `You have ${queue.length} alt texts queued for export.`;
            exportBtn.disabled = queue.length === 0;
            if (queue.length === 0) exportBtn.style.opacity = 0.5;
        });
    }

    updateUI();

    exportBtn.addEventListener('click', () => {
        chrome.storage.local.get(['pollyQueue'], (result) => {
            const queue = result.pollyQueue || [];
            if (queue.length === 0) return;

            // Format: Filename, next line Alt, blank line.
            const exportText = queue.map(item => `${item.filename}\n${item.alt}`).join('\n\n');
            const blob = new Blob([exportText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            
            chrome.downloads.download({
                url: url,
                filename: 'polly-alt-export.txt',
                saveAs: true
            });
        });
    });

    document.getElementById('clear-btn').addEventListener('click', () => {
        if (confirm("Are you sure you want to clear your queue? This cannot be undone.")) {
            chrome.storage.local.set({ pollyQueue: [] }, updateUI);
        }
    });

    document.getElementById('settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
});