// Background service worker — proxies HTTP fetches that would be blocked as
// mixed content from the Xero HTTPS page.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg.type !== "fetch-bank-rules") return false;

	const urls = [
		"http://localhost:3737/api/bank-rules",
		"http://192.168.1.247:3737/api/bank-rules",
	];

	(async () => {
		let lastErr;
		for (const url of urls) {
			try {
				const resp = await fetch(url);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const json = await resp.json();
				// Server returns { count, rules } — extract the array
				const data = Array.isArray(json) ? json : (json.rules ?? json);
				sendResponse({ ok: true, data });
				return;
			} catch (err) {
				lastErr = err.message;
			}
		}
		sendResponse({ ok: false, error: lastErr });
	})();

	return true; // keep message channel open for async response
});
