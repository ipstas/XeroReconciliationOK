// Background service worker — proxies HTTP fetches that would be blocked as
// mixed content from the Xero HTTPS page.

const HOSTS = [
	"http://localhost:3737",
	"http://192.168.1.247:3737",
];

async function tryFetch(path, options = {}) {
	let lastErr;
	for (const host of HOSTS) {
		try {
			const resp = await fetch(host + path, options);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return await resp.json();
		} catch (err) {
			lastErr = err.message;
		}
	}
	throw new Error(lastErr);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	(async () => {
		try {
			if (msg.type === "fetch-bank-rules") {
				const json = await tryFetch("/api/bank-rules");
				const data = Array.isArray(json) ? json : (json.rules ?? json);
				sendResponse({ ok: true, data });

			} else if (msg.type === "fetch-xero-bank-rules") {
				const json = await tryFetch("/api/xero/bank-rules");
				const data = Array.isArray(json) ? json : (json.rules ?? json);
				sendResponse({ ok: true, data });

			} else if (msg.type === "save-xero-bank-rule") {
				await tryFetch("/api/xero/bank-rules", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(msg.rule),
				});
				sendResponse({ ok: true });

			} else if (msg.type === "sync-xero-bank-rules") {
				const json = await tryFetch("/api/xero/bank-rules/sync", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rules: msg.rules }),
				});
				sendResponse({ ok: true, ...json });

			} else {
				sendResponse({ ok: false, error: "Unknown message type" });
			}
		} catch (err) {
			sendResponse({ ok: false, error: err.message });
		}
	})();

	return true; // keep message channel open for async response
});
