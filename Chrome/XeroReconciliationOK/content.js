/**
 * Xero Reconciliation OK — v2.1.0
 *
 * Injects an "Apply Rules" button into Xero's reconciliation header.
 * When clicked, auto-clicks OK on all rule-matched statement lines
 * and paginates through remaining pages automatically.
 *
 * Selectors to update if Xero changes its DOM:
 *   SELECTOR_OK_BUTTON        — the OK anchor/button on each statement row
 *   SELECTOR_RULED_STATEMENT  — a row that was matched by a bank rule
 *   SELECTOR_SUMMARY_HEADER   — the header element to inject the trigger button into
 */

console.log("[XeroOK] content script loaded v2.5.0 @", new Date().toLocaleTimeString());

// ── Selectors ────────────────────────────────────────────────────────────────
const SELECTOR_OK_BUTTON      = "div.ok a.okayButton"; // confirmed May 2026
const SELECTOR_LINE_ROW       = "div.line";            // container row for each statement line
const SELECTOR_RULE_MATCH     = "div.rule";            // sibling inside div.line — present only on rule-matched rows
const SELECTOR_SUMMARY_HEADER = "div.bank-summary";    // header area for button injection
const ACTIVATION_PARAM        = "pageSize=1337";

// ── Core reconciliation logic ────────────────────────────────────────────────

let initialLoadingsCount = 0;

function removeHiddenButtons(buttons) {
	const result = [];
	for (const btn of buttons) {
		if (btn.style.visibility === "hidden") continue;
		// div.rule is a sibling of div.ok inside div.line — not an ancestor
		const line = btn.closest(SELECTOR_LINE_ROW);
		if (line && line.querySelector(SELECTOR_RULE_MATCH)) {
			result.push(btn);
		}
	}
	return result;
}

function currentPage() {
	const match = location.search.match(/[?&]page=(\d+)/);
	return match ? parseInt(match[1], 10) : 1;
}

function loadPage(delta) {
	const page = currentPage();
	const newPage = page + delta;
	const search = location.search.includes("page=")
		? location.search.replace(/([?&]page=)\d+/, `$1${newPage}`)
		: `${location.search}&page=${newPage}`;
	location.search = search;
}

function clickOks(attempts) {
	console.log("[XeroOK] clickOks attempt:", attempts);

	const allOkButtons = removeHiddenButtons(document.querySelectorAll(SELECTOR_OK_BUTTON));
	const readyButtons = allOkButtons.filter(b => !b.classList.contains("disabled") && !b.classList.contains("reconciled"));
	const loadings     = document.querySelectorAll("div.statement.load");

	if (readyButtons.length > 0) {
		console.log(`[XeroOK] Clicking ${readyButtons.length} buttons (${loadings.length} loading)`);
		if (readyButtons.length < 5 && loadings.length > initialLoadingsCount) {
			console.log("[XeroOK] Hung lines detected — reloading in 3s");
			setTimeout(() => location.reload(), 3000);
			return;
		}
		readyButtons.forEach(b => b.click());
		setTimeout(() => clickOks(1), 1000);

	} else if (allOkButtons.length > 0) {
		console.log(`[XeroOK] Waiting for ${allOkButtons.length} buttons to settle`);
		setTimeout(() => clickOks(1), 1000);

	} else if (attempts > 10) {
		console.log("[XeroOK] Moving to next page");
		loadPage(1);

	} else if (attempts > 0) {
		console.log("[XeroOK] Retrying...");
		setTimeout(() => clickOks(attempts + 1), 1000);

	} else {
		console.log("[XeroOK] Complete — no more rule-matched items on this page");
	}
}

// ── Button injection ─────────────────────────────────────────────────────────

function injectButton(dest) {
	if (dest.querySelector(".xero-ok-btn")) return; // already injected
	console.log("[XeroOK] Injecting Apply Rules button into", dest.className);
	const btn = document.createElement("a");
	btn.className = "xero-ok-btn";
	btn.style.cssText = "margin-left:16px;cursor:pointer;font-weight:600;color:#13B5EA;font-size:14px;";
	btn.textContent = "Apply Rules ✓";
	btn.onclick = () => {
		const sep = location.search ? "&" : "?";
		location.href = location.href + sep + ACTIVATION_PARAM;
		return false;
	};
	dest.appendChild(btn);
}

// ── Entry point — wait for SPA to render the header ─────────────────────────

function activate() {
	return location.search.includes(ACTIVATION_PARAM);
}

function init() {
	if (activate()) {
		console.log("[XeroOK] Activation mode — starting auto-click");
		initialLoadingsCount = document.querySelectorAll("div.statement.load").length;
		clickOks(0);
		return;
	}

	// Try immediately first
	const dest = document.querySelector(SELECTOR_SUMMARY_HEADER);
	if (dest) {
		injectButton(dest);
		return;
	}

	// Fall back to MutationObserver — Xero SPA renders header after JS boots
	console.log("[XeroOK] Header not ready yet, waiting via MutationObserver...");
	const observer = new MutationObserver(() => {
		const el = document.querySelector(SELECTOR_SUMMARY_HEADER);
		if (el) {
			observer.disconnect();
			injectButton(el);
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });

	// Safety timeout — stop observing after 15s
	setTimeout(() => {
		observer.disconnect();
		console.warn("[XeroOK] Gave up waiting for header:", SELECTOR_SUMMARY_HEADER);
	}, 15000);
}

init();

// ── Bank Rules page automation (T203) ────────────────────────────────────────

// Fetch routed through background service worker — avoids mixed-content blocks
// (Xero is HTTPS; our local server is HTTP).

function isBankRulesPage() {
	return /bank-rules|bankreconrules|BankRules/i.test(location.href);
}

function isCreateRulePage() {
	return /bank-rules\/create|BankRules\/Add/i.test(location.href);
}

function bgMessage(msg) {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(msg, (response) => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else if (response?.ok) resolve(response);
			else reject(new Error(response?.error ?? "Unknown error from background"));
		});
	});
}

async function fetchRulesFromServer() {
	const r = await bgMessage({ type: "fetch-bank-rules" });
	return r.data;
}

async function fetchXeroBankRules() {
	const r = await bgMessage({ type: "fetch-xero-bank-rules" });
	return r.data; // rules already in Xero (stored in MongoDB)
}

async function saveXeroBankRule(rule) {
	await bgMessage({ type: "save-xero-bank-rule", rule });
}

async function syncXeroBankRules(rules) {
	return bgMessage({ type: "sync-xero-bank-rules", rules });
}

// Wait for an element matching selector to appear, up to timeoutMs
function waitForEl(selector, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const el = document.querySelector(selector);
		if (el) { resolve(el); return; }
		const obs = new MutationObserver(() => {
			const found = document.querySelector(selector);
			if (found) { obs.disconnect(); resolve(found); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout waiting for ${selector}`)); }, timeoutMs);
	});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Simulate a React-compatible input change
function setReactInputValue(el, value) {
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
		?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	if (nativeSetter) nativeSetter.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setReactSelectValue(el, value) {
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
	if (nativeSetter) nativeSetter.call(el, value);
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function visibleInputs() {
	return [...document.querySelectorAll("input, textarea")]
		.filter(el => el.offsetParent !== null && el.type !== "hidden");
}

// Call React's internal onMouseDown/onClick handler directly via fiber tree.
// Native DOM events don't reliably reach React 17+ synthetic event system.
function fireReactHandler(el) {
	const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
	if (!fiberKey) return false;
	let fiber = el[fiberKey];
	while (fiber) {
		const props = fiber.memoizedProps ?? fiber.pendingProps;
		if (props) {
			const fakeEvt = { preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el };
			if (props.onMouseDown) { props.onMouseDown(fakeEvt); return true; }
			if (props.onClick)     { props.onClick(fakeEvt);     return true; }
		}
		fiber = fiber.return;
	}
	return false;
}

function pickDropdownOption(matchText, searchText) {
	const candidates = [...document.querySelectorAll("[role=option], [class*='option'], [class*='listItem'], [class*='DropdownItem'], [class*='dropdown'] li, [class*='menu'] li")]
		.filter(el => el.offsetParent && (el.textContent.includes(matchText) || el.textContent.includes(searchText)));
	const option = candidates[0];
	if (!option) return null;

	console.log(`[XeroOK] pickDropdownOption: firing React handler on "${option.textContent.trim().slice(0, 60)}"`);
	const fired = fireReactHandler(option);
	if (!fired) {
		// Fallback: brute-force all three mouse events
		console.log(`[XeroOK] pickDropdownOption: no React fiber handler found — falling back to native events`);
		option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		option.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
		option.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true }));
	}
	return option;
}

async function fillCombobox(input, searchText, matchText) {
	input.focus();
	setReactInputValue(input, searchText);
	await sleep(1000);

	// Check dropdown is open with matching option
	const option = [...document.querySelectorAll("[role=option], [class*='option'], [class*='listItem'], [class*='DropdownItem'], [class*='dropdown'] li, [class*='menu'] li")]
		.find(el => el.offsetParent && (el.textContent.includes(matchText) || el.textContent.includes(searchText)));
	console.log(`[XeroOK] fillCombobox: option visible=${!!option} for "${matchText}"`);

	// Use keyboard navigation — keeps focus on input so blur doesn't close the dropdown
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	await sleep(300);
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter",    bubbles: true }));
	await sleep(500);
	return !!option;
}

async function createXeroRule(rawRule, { skipNavigate = false } = {}) {
	const rule = {
		payee:    rawRule.payee    ?? rawRule.vendor,
		gl_code:  rawRule.gl_code  ?? rawRule.gl_account_code,
		gl_name:  rawRule.gl_name  ?? rawRule.gl_account_name,
		type:     rawRule.type     ?? rawRule.rule_type ?? "spend",
	};
	console.log(`[XeroOK] Creating rule: ${rule.payee} → ${rule.gl_code} ${rule.gl_name}`);

	if (!skipNavigate) {
		// Click "Create rule" button on list page
		const createBtn = [...document.querySelectorAll("button, a")]
			.find(el => /create\s+rule/i.test(el.textContent?.trim()));
		if (!createBtn) throw new Error("Could not find Create Rule button");
		createBtn.click();
	}

	// Wait for form: need at least 7 visible inputs (confirmed by DevTools inspection)
	await new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (visibleInputs().length >= 7 || Date.now() - start > 8000) resolve();
			else setTimeout(check, 200);
		};
		setTimeout(check, 500);
	});

	const inputs = visibleInputs();
	console.log(`[XeroOK] Form inputs found: ${inputs.length}`, inputs.map((el, i) => `[${i}] ${el.tagName} type=${el.type} id=${el.id.slice(0,20)}`));

	// [2] Condition value — fill and Tab out
	if (inputs[2]) {
		inputs[2].focus();
		setReactInputValue(inputs[2], rule.payee);
		console.log(`[XeroOK] [2] condition value → "${rule.payee}"`);
		await sleep(300);
		inputs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		await sleep(300);
	} else {
		console.warn("[XeroOK] [2] condition value input not found");
	}

	// [3] Contact name — type vendor, pick existing contact or "Create" option, then Tab
	// Re-query inputs after Tab may have shifted focus
	const inputsForContact = visibleInputs();
	const contactInput = inputsForContact[3];
	if (contactInput) {
		contactInput.focus();
		setReactInputValue(contactInput, rule.payee);
		console.log(`[XeroOK] [3] contact → "${rule.payee}" — waiting for dropdown`);
		await sleep(1200);

		const dropdownOptions = [...document.querySelectorAll("[role=option], [class*='option'], [class*='listItem'], [class*='DropdownItem'], [class*='dropdown'] li")]
			.filter(el => el.offsetParent);
		console.log(`[XeroOK] [3] dropdown options (${dropdownOptions.length}):`, dropdownOptions.map(el => el.textContent.trim().slice(0, 60)));

		// Priority 1: existing contact whose display name contains the vendor (first 12 chars)
		const payeeShort = rule.payee.toLowerCase().slice(0, 12);
		const existingContact = dropdownOptions.find(el => {
			const txt = el.textContent.toLowerCase();
			return txt.includes(payeeShort) && !/enter a unique/i.test(txt) && !/create\s+['"]/.test(txt);
		});
		// Priority 2: "Create '...' as new contact" option
		const createOption = dropdownOptions.find(el => /create\s+['"]/.test(el.textContent));

		const toClick = existingContact ?? createOption;
		if (toClick) {
			console.log(`[XeroOK] [3] mousedown on: "${toClick.textContent.trim().slice(0, 80)}"`);
			toClick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			toClick.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
			toClick.dispatchEvent(new MouseEvent("click",     { bubbles: true, cancelable: true }));
			await sleep(600);
		} else {
			console.warn("[XeroOK] [3] no contact option found — tabbing away");
		}
		// Tab out of contact field to commit
		contactInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		await sleep(400);
	} else {
		console.warn("[XeroOK] [3] contact input not found");
	}

	// [5] Account combobox — re-query after contact step may have shifted DOM
	const inputsAfterContact = visibleInputs();
	console.log(`[XeroOK] Inputs after contact step: ${inputsAfterContact.length}`, inputsAfterContact.map((el, i) => `[${i}] ${el.type} id=${el.id.slice(0, 20)}`));
	const accountInput = inputsAfterContact[5];
	if (accountInput) {
		console.log(`[XeroOK] [5] account combobox → searching "${rule.gl_code} ${rule.gl_name}"`);
		const picked = await fillCombobox(accountInput, rule.gl_code, rule.gl_name);
		console.log(`[XeroOK] [5] account option picked: ${picked}`);
	} else {
		console.warn("[XeroOK] [5] account input not found (index 5 out of range)");
	}

	// [6] Tax rate combobox — keyboard navigation same as account
	const inputsAfterAccount = visibleInputs();
	const taxInput = inputsAfterAccount[6];
	if (taxInput && !taxInput.value) {
		console.log(`[XeroOK] [6] tax rate combobox — typing "Tax Exempt" then ArrowDown+Enter`);
		taxInput.focus();
		setReactInputValue(taxInput, "Tax Exempt");
		await sleep(800);
		taxInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		await sleep(300);
		taxInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter",    bubbles: true }));
		await sleep(500);
	} else {
		console.log(`[XeroOK] [6] tax rate already set or not found: "${taxInput?.value}"`);
	}

	// Rule name — last text input on the form (re-query fresh)
	await sleep(300);
	const fresh = visibleInputs();
	const ruleNameInput = [...fresh].reverse().find(el => el.type === "text");
	if (ruleNameInput) {
		ruleNameInput.focus();
		setReactInputValue(ruleNameInput, rule.payee);
		console.log(`[XeroOK] rule name (id=${ruleNameInput.id.slice(0, 20)}) → "${rule.payee}"`);
		await sleep(300);
		ruleNameInput.blur();
		await sleep(300);
	} else {
		console.warn("[XeroOK] rule name input not found");
	}

	// Find Save button and click
	const allBtns = [...document.querySelectorAll("button")];
	console.log(`[XeroOK] buttons:`, allBtns.map(b => b.textContent?.trim()).filter(Boolean));
	const saveBtn = allBtns.find(el => /^save$/i.test(el.textContent?.trim()) && !el.disabled);
	if (!saveBtn) throw new Error("Could not find Save button");

	// Log current field values before saving (for debugging)
	const finalInputs = visibleInputs();
	console.log(`[XeroOK] Field values before save:`, finalInputs.map((el, i) => `[${i}] "${el.value?.slice(0, 40)}"`));

	// Snapshot existing rule IDs before save so we can detect the newly created one
	const existingIds = new Set(
		[...document.querySelectorAll("a[href*='bank-rules/edit']")]
			.map(a => (a.href ?? "").match(/bank-rules\/edit\/([0-9a-f-]{36})/i)?.[1])
			.filter(Boolean)
	);

	console.log("[XeroOK] clicking Save");
	const urlBefore = location.href;
	saveBtn.click();

	// Wait for URL to change (true navigation = saved) or timeout after 15s
	const saved = await new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (location.href !== urlBefore) { resolve(true); return; }
			if (Date.now() - start > 15000) { resolve(false); return; }
			setTimeout(check, 300);
		};
		setTimeout(check, 800);
	});

	if (!saved) {
		const errors = [...document.querySelectorAll("[class*='error'], [class*='Error'], [class*='invalid'], .validation-error")]
			.filter(el => el.offsetParent && el.textContent.trim())
			.map(el => el.textContent.trim().slice(0, 100));
		console.warn(`[XeroOK] ✗ Save failed — URL unchanged after 15s`);
		if (errors.length) console.warn(`[XeroOK] Validation errors:`, errors);
		throw new Error("Save failed — URL did not change");
	}

	// Wait for the list page to re-render and show the new edit link
	await sleep(800);
	const newLink = [...document.querySelectorAll("a[href*='bank-rules/edit']")]
		.find(a => {
			const id = (a.href ?? "").match(/bank-rules\/edit\/([0-9a-f-]{36})/i)?.[1];
			return id && !existingIds.has(id);
		});
	const newRuleId = (newLink?.href ?? "").match(/bank-rules\/edit\/([0-9a-f-]{36})/i)?.[1] ?? null;
	console.log(`[XeroOK] ✓ Rule saved — xero_rule_id=${newRuleId ?? "not found"} URL=${location.href}`);
	return newRuleId;
}

// Get all Edit link elements from the current bank rules list page
function getEditLinkElements() {
	const links = [...document.querySelectorAll("a[href*='bank-rules/edit']")];
	console.log(`[XeroOK] found ${links.length} edit links`);
	return links;
}

// Click an Edit link, wait for Xero to render the edit form, read values, go back
async function readRuleFromEditPage(linkEl) {
	const href = linkEl.href ?? linkEl.getAttribute("href") ?? "";
	const match = href.match(/bank-rules\/edit\/([0-9a-f-]{36})/i);
	const xero_rule_id = match?.[1] ?? null;
	console.log(`[XeroOK] clicking edit link for rule ${xero_rule_id}`);

	const urlBefore = location.href;
	linkEl.click();

	// Wait for URL to change to the edit page
	await new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (location.href !== urlBefore) { resolve(); return; }
			if (Date.now() - start > 8000) { resolve(); return; }
			setTimeout(check, 200);
		};
		setTimeout(check, 300);
	});
	console.log(`[XeroOK] URL after click: ${location.href}`);

	// Wait for 7+ inputs (the edit form)
	await new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (visibleInputs().length >= 7 || Date.now() - start > 10000) resolve();
			else setTimeout(check, 300);
		};
		setTimeout(check, 500);
	});

	const inputs = visibleInputs();
	console.log(`[XeroOK] edit form inputs (${inputs.length}):`, inputs.map((el, i) => `[${i}] "${el.value?.slice(0, 50)}"`));

	const conditionValue  = inputs[2]?.value?.trim() ?? "";
	const glRaw           = inputs[5]?.value?.trim() ?? "";
	const glCode          = glRaw.match(/^\d{4}/)?.[0] ?? glRaw;           // "7050 - Miscellaneous" → "7050"
	const glName          = glRaw.replace(/^\d{4}\s*-\s*/, "").trim() || glRaw; // → "Miscellaneous"
	const taxRate         = inputs[6]?.value?.trim() ?? "";
	const ruleName        = inputs[inputs.length - 1]?.value?.trim() ?? conditionValue;

	// Go back to the list
	history.back();
	await new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			if (location.href === urlBefore) { resolve(); return; }
			if (Date.now() - start > 6000) { resolve(); return; }
			setTimeout(check, 200);
		};
		setTimeout(check, 300);
	});
	await sleep(600); // let list re-render

	return {
		xero_rule_id,
		vendor: conditionValue || ruleName,
		condition_value: conditionValue,
		gl_code: glCode,
		gl_name: glName,
		tax_rate: taxRate,
		rule_name: ruleName,
		rule_type: "spend",
		source: "xero_edit_page",
	};
}

async function runBankRulesAutomation() {
	console.log("[XeroOK] Starting auto-create loop");

	let serverRules, xeroRules;
	try {
		[serverRules, xeroRules] = await Promise.all([fetchRulesFromServer(), fetchXeroBankRules()]);
	} catch (err) {
		console.error("[XeroOK] Failed to fetch rules:", err.message);
		injectStatusBadge(`❌ Could not reach server`, "red");
		return;
	}

	// Build set of vendors already in Xero (from MongoDB)
	const existingVendors = new Set(xeroRules.map(r => (r.vendor ?? "").toLowerCase()));
	const missing = serverRules.filter(r => {
		const payee = (r.payee ?? r.vendor ?? "").toLowerCase();
		return payee && !existingVendors.has(payee);
	});

	console.log(`[XeroOK] ${serverRules.length} server rules, ${existingVendors.size} in Xero, ${missing.length} to create`);

	if (missing.length === 0) {
		injectStatusBadge(`✓ All rules already exist in Xero`, "green");
		return;
	}

	let created = 0;
	for (const rule of missing) {
		const payee = rule.payee ?? rule.vendor;
		injectStatusBadge(`⏳ Creating ${created + 1}/${missing.length}: ${payee}…`, "#13B5EA");
		console.log(`[XeroOK] Creating rule ${created + 1}/${missing.length}: ${payee}`);

		try {
			const xero_rule_id = await createXeroRule(rule);
			await saveXeroBankRule({
				vendor: payee,
				xero_rule_id: xero_rule_id ?? undefined,
				gl_code: rule.gl_code ?? rule.gl_account_code,
				gl_name: rule.gl_name ?? rule.gl_account_name,
				rule_type: rule.rule_type ?? "spend",
				condition_value: payee,
			});
			console.log(`[XeroOK] ✓ Saved to MongoDB: "${payee}" id=${xero_rule_id}`);
			created++;
		} catch (err) {
			console.warn(`[XeroOK] ✗ Failed "${payee}":`, err.message);
			injectStatusBadge(`❌ Failed on "${payee}": ${err.message}`, "red");
			return; // stop loop on first error so user can inspect
		}
	}

	injectStatusBadge(`✓ Created ${created}/${missing.length} rules`, "green");
	console.log(`[XeroOK] Auto-create complete — ${created} rules created`);
}

async function runSyncFromPage() {
	console.log("[XeroOK] Syncing existing rules from page to MongoDB");

	// Collect hrefs upfront — the link elements will be removed from DOM as we navigate
	const editHrefs = [...document.querySelectorAll("a[href*='bank-rules/edit']")]
		.map(a => a.href ?? a.getAttribute("href")).filter(Boolean);

	if (editHrefs.length === 0) {
		injectStatusBadge("⚠ No Edit links found — are the rules loaded?", "orange");
		return;
	}

	const rules = [];

	for (let i = 0; i < editHrefs.length; i++) {
		injectStatusBadge(`⏳ Reading rule ${i + 1}/${editHrefs.length}…`, "#13B5EA");
		const href = editHrefs[i];
		const match = href.match(/bank-rules\/edit\/([0-9a-f-]{36})/i);
		const xero_rule_id = match?.[1] ?? null;

		// Find the link in the current DOM (we're back on list after each iteration)
		const linkEl = document.querySelector(`a[href*="${xero_rule_id}"]`);
		if (!linkEl) {
			console.warn(`[XeroOK] Edit link not found in DOM for ${xero_rule_id}`);
			continue;
		}

		try {
			const rule = await readRuleFromEditPage(linkEl);
			console.log(`[XeroOK] read rule ${i + 1}/${editHrefs.length}:`, rule);
			rules.push(rule);
		} catch (err) {
			console.warn(`[XeroOK] failed to read rule ${xero_rule_id}:`, err.message);
		}
	}

	if (rules.length === 0) {
		injectStatusBadge("⚠ Could not read any rules", "orange");
		return;
	}

	try {
		const result = await syncXeroBankRules(rules);
		injectStatusBadge(`✓ Synced ${result.upserted ?? rules.length} rules to MongoDB`, "green");
		console.log(`[XeroOK] Sync complete:`, rules);
	} catch (err) {
		injectStatusBadge(`❌ Sync failed: ${err.message}`, "red");
		console.error(`[XeroOK] sync error:`, err);
	}
}

function injectStatusBadge(text, color) {
	// Ensure toolbar exists (may be on create-rule page with only one button)
	let badge = document.getElementById("xero-ok-badge");
	if (!badge) {
		const bar = getOrCreateToolbar();
		badge = document.createElement("div");
		badge.id = "xero-ok-badge";
		badge.style.cssText = "padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff;";
		bar.appendChild(badge);
	}
	badge.style.display = "block";
	badge.style.background = color;
	badge.textContent = text;
}

// ── Toolbar: persistent bottom-left panel with buttons + status chip ──────────

function getOrCreateToolbar() {
	let bar = document.getElementById("xero-ok-toolbar");
	if (bar) return bar;
	bar = document.createElement("div");
	bar.id = "xero-ok-toolbar";
	bar.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:99999;display:flex;flex-direction:column;align-items:flex-start;gap:6px;font-family:sans-serif;";
	document.body.appendChild(bar);
	return bar;
}

function makeToolbarButton(id, label, bgColor, onClick) {
	const existing = document.getElementById(id);
	if (existing) return existing;
	const btn = document.createElement("button");
	btn.id = id;
	btn.textContent = label;
	btn.style.cssText = `padding:7px 16px;background:${bgColor};color:#fff;border:none;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.2);white-space:nowrap;`;
	btn.onclick = async () => {
		btn.disabled = true;
		btn.textContent = "⏳ Working…";
		await onClick();
		btn.disabled = false;
		btn.textContent = label;
	};
	return btn;
}

function injectBankRulesButton() {
	const bar = getOrCreateToolbar();

	// Row of two buttons side by side
	const row = document.createElement("div");
	row.id = "xero-ok-btn-row";
	row.style.cssText = "display:flex;gap:8px;";

	const syncBtn = makeToolbarButton("xero-ok-sync-btn", "↻ Sync → MongoDB", "#6c757d", runSyncFromPage);
	const autoBtn = makeToolbarButton("xero-ok-rules-btn", "⚡ Auto create rules", "#13B5EA", runBankRulesAutomation);

	row.appendChild(syncBtn);
	row.appendChild(autoBtn);
	bar.appendChild(row);

	// Status chip starts empty — updated by injectStatusBadge
	const chip = document.createElement("div");
	chip.id = "xero-ok-badge";
	chip.style.cssText = "display:none;padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff;";
	bar.appendChild(chip);

	console.log("[XeroOK] Bank Rules buttons injected");
}

async function runFillFormAutomation() {
	// On the Create Rule page — fill the current form with the next missing rule
	let rules;
	try {
		rules = await fetchRulesFromServer();
	} catch (err) {
		injectStatusBadge(`❌ Could not reach server — is npm run server:dev running?`, "red");
		return;
	}

	// Use all server rules — no "existing" check since the user navigated here manually
	const next = rules[0];
	if (!next) {
		injectStatusBadge("✓ No rules from server", "green");
		return;
	}

	const payee = next.payee ?? next.vendor;
	injectStatusBadge(`⏳ Filling: ${payee}…`, "#13B5EA");

	try {
		await createXeroRule(next, { skipNavigate: true });
		injectStatusBadge(`✓ Filled: ${payee}`, "green");
	} catch (err) {
		injectStatusBadge(`❌ Failed: ${err.message}`, "red");
	}
}

function injectFillFormButton() {
	const bar = getOrCreateToolbar();
	const btn = makeToolbarButton("xero-ok-fill-btn", "⚡ Fill from MongoDB", "#13B5EA", runFillFormAutomation);
	bar.appendChild(btn);
	const chip = document.createElement("div");
	chip.id = "xero-ok-badge";
	chip.style.cssText = "display:none;padding:5px 12px;border-radius:5px;font-size:12px;font-weight:600;color:#fff;";
	bar.appendChild(chip);
	console.log("[XeroOK] Create rule fill button injected");
}

// ── SPA navigation watcher ───────────────────────────────────────────────────
// Xero is a SPA — intercept pushState/replaceState so we react to route changes

(function patchHistory() {
	const wrap = (fn) => function (...args) {
		const result = fn.apply(this, args);
		window.dispatchEvent(new Event("xero-ok-navigate"));
		return result;
	};
	history.pushState    = wrap(history.pushState);
	history.replaceState = wrap(history.replaceState);
})();

function onRouteChange() {
	document.getElementById("xero-ok-toolbar")?.remove();

	if (isCreateRulePage()) {
		setTimeout(injectFillFormButton, 800);
	} else if (isBankRulesPage()) {
		setTimeout(injectBankRulesButton, 800);
	}
}

window.addEventListener("xero-ok-navigate", onRouteChange);
window.addEventListener("popstate", onRouteChange);

// Poll for URL changes as a fallback — catches redirects that bypass pushState
// (e.g. Xero's post-save navigation back to the rules list)
let _lastHref = location.href;
setInterval(() => {
	if (location.href !== _lastHref) {
		_lastHref = location.href;
		console.log("[XeroOK] URL change detected by poller:", location.href);
		onRouteChange();
	}
}, 500);

// Also check immediately on load
if (isCreateRulePage()) {
	setTimeout(injectFillFormButton, 800);
} else if (isBankRulesPage()) {
	setTimeout(injectBankRulesButton, 800);
}
