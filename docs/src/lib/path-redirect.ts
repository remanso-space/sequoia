// Cloudflare Workers compatibility patches for @atproto libraries.
//
// 1. Workers don't support `redirect: 'error'` — simulate it with 'manual'.
// 2. Workers don't support the standard `cache` option in Request — strip it.

function sanitizeInit(init?: RequestInit): RequestInit | undefined {
	if (!init) return init;
	const { cache, redirect, ...rest } = init;
	return {
		...rest,
		// Workers only support 'follow' and 'manual'
		redirect: redirect === "error" ? "manual" : redirect,
		// Workers don't support standard cache modes — omit entirely
		...(cache ? {} : {}),
	};
}

const errorRedirectRequests = new WeakSet<Request>();
const OriginalRequest = globalThis.Request;

globalThis.Request = class extends OriginalRequest {
	constructor(input: RequestInfo | URL, init?: RequestInit) {
		super(input, sanitizeInit(init));
		if (init?.redirect === "error") {
			errorRedirectRequests.add(this);
		}
	}
} as typeof Request;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const cleanInit = sanitizeInit(init);
	const response = await originalFetch(input, cleanInit);

	// Simulate redirect: 'error' — throw on 3xx
	const wantsRedirectError =
		init?.redirect === "error" ||
		(input instanceof Request && errorRedirectRequests.has(input));

	if (wantsRedirectError && response.status >= 300 && response.status < 400) {
		throw new TypeError("unexpected redirect");
	}

	return response;
}) as typeof fetch;
