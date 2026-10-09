/* Shared by the generated service worker and the Node integrity tests. */
(function (root) {
	'use strict';
	class ReleaseError extends Error {
		constructor(code, message) { super(message); this.code = code; }
	}
	function validateRelease(value) {
		if (!value || value.schema !== 1 || !/^[a-zA-Z0-9_-]{1,96}$/.test(value.id || '') ||
			typeof value.build !== 'string' || value.build.length > 80 ||
			value.base !== `releases/${value.id}/game/` || !Array.isArray(value.files) ||
			value.files.length < 4 || value.files.length > 128) {
			throw new ReleaseError('MANIFEST', 'Некорректное описание обновления.');
		}
		const names = new Set();
		let bytes = 0;
		for (const file of value.files) {
			if (!file || !/^[a-zA-Z0-9_.-]+$/.test(file.path || '') || file.path === '.' || file.path === '..' ||
				names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 * 1024 ||
				!/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
				throw new ReleaseError('MANIFEST', 'Некорректный файл обновления.');
			}
			names.add(file.path); bytes += file.bytes;
		}
		if (bytes > 1024 * 1024 * 1024 || !['index.html', 'index.js', 'index.wasm', 'index.pck'].every((path) => names.has(path))) {
			throw new ReleaseError('MANIFEST', 'Обновление неполное.');
		}
		return value;
	}
	function signature(release) {
		return JSON.stringify([release.id, release.build, release.base,
			[...release.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.bytes, f.sha256])]);
	}
	class ReleaseCache {
		constructor({scope, caches, fetch, crypto, now = () => Date.now()}) {
			this.scope = new URL('./', scope).href;
			this.caches = caches; this.fetch = fetch; this.crypto = crypto; this.now = now;
			this.prefix = `under-pwa-${encodeURIComponent(new URL(this.scope).pathname)}-`;
			this.marker = new URL('__complete__', this.scope).href;
			this.stateUrl = new URL('__latest__', this.scope).href;
			this.jobs = new Map();
		}
		cacheName(release) { return this.prefix + 'release-' + release.id; }
		async network(url, options, timeoutMs) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try { return await this.fetch(url, {...options, signal: controller.signal}); }
			finally { clearTimeout(timer); }
		}
		async readState() {
			const response = await (await this.caches.open(this.prefix + 'state')).match(this.stateUrl);
			if (!response) return null;
			try { return validateRelease(await response.json()); } catch (_) { return null; }
		}
		async remember(release) {
			await (await this.caches.open(this.prefix + 'state')).put(this.stateUrl,
				new Response(JSON.stringify(release), {headers: {'Content-Type': 'application/json'}}));
		}
		async latest() {
			let response;
			try {
				response = await this.network(new URL(`release.json?check=${this.now()}`, this.scope).href,
					{cache: 'no-store', credentials: 'same-origin'}, 15000);
			} catch (error) { throw new ReleaseError('OFFLINE', 'Не удалось проверить обновления.'); }
			if (!response.ok) throw new ReleaseError('SERVER', `Сервер обновлений недоступен (${response.status}).`);
			let release;
			try { release = validateRelease(await response.json()); }
			catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError('MANIFEST', 'Не удалось прочитать обновление.'); }
			// Remember an advertised update BEFORE downloading. A later offline launch must not quietly use an older build.
			await this.remember(release);
			return release;
		}
		async ready(release) {
			const cache = await this.caches.open(this.cacheName(release));
			const response = await cache.match(this.marker);
			if (!response) return false;
			try { if (signature(validateRelease(await response.json())) !== signature(release)) return false; }
			catch (_) { return false; }
			for (const file of release.files) {
				const item = await cache.match(new URL(release.base + file.path, this.scope).href);
				if (!item || item.headers.get('X-Under-Pwa-Sha256') !== file.sha256 ||
					Number(item.headers.get('Content-Length')) !== file.bytes) return false;
			}
			return true;
		}
		async ensure(release, progress = () => {}) {
			validateRelease(release);
			const existing = this.jobs.get(release.id);
			if (existing) return existing;
			const job = this.download(release, progress);
			this.jobs.set(release.id, job);
			try { return await job; } finally { this.jobs.delete(release.id); }
		}
		async download(release, progress) {
			if (await this.ready(release)) return release;
			const name = this.cacheName(release);
			const existingMarker = await (await this.caches.open(name)).match(this.marker);
			if (existingMarker) {
				try {
					if (signature(validateRelease(await existingMarker.json())) !== signature(release)) {
						throw new ReleaseError('MANIFEST', 'Идентификатор готовой сборки был изменён. Сервер должен выпустить новую сборку.');
					}
				} catch (error) { if (error instanceof ReleaseError) throw error; }
			}
			// Every download has a private staging cache. Two worker generations cannot erase one another's accepted release.
			const attempt = this.crypto.randomUUID ? this.crypto.randomUUID() : `${this.now()}-${Math.random()}`;
			const stagingName = this.prefix + 'staging-' + release.id + '-' + attempt;
			const cache = await this.caches.open(stagingName);
			const total = release.files.reduce((sum, f) => sum + f.bytes, 0);
			let loaded = 0;
			progress({loaded, total, file: ''});
			try {
				for (const file of release.files) {
					const url = new URL(release.base + file.path, this.scope).href;
					let response;
					progress({loaded, total, file: file.path});
					try { response = await this.network(url, {cache: 'no-store', credentials: 'same-origin'}, 300000); }
					catch (_) { throw new ReleaseError('DOWNLOAD', 'Загрузка обновления прервалась.'); }
					if (!response.ok) throw new ReleaseError('DOWNLOAD', 'Не удалось загрузить обновление целиком.');
					const buffer = await response.arrayBuffer();
					const digest = Array.from(new Uint8Array(await this.crypto.subtle.digest('SHA-256', buffer)),
						(v) => v.toString(16).padStart(2, '0')).join('');
					if (buffer.byteLength !== file.bytes || digest !== file.sha256) {
						throw new ReleaseError('INTEGRITY', 'Файл обновления повреждён. Повторите загрузку.');
					}
					const headers = new Headers(response.headers);
					// fetch returns decoded bytes; retaining Content-Encoding would be wrong for the reconstructed Response.
					headers.delete('Content-Encoding'); headers.delete('Transfer-Encoding');
					headers.set('Content-Length', String(buffer.byteLength));
					headers.set('X-Under-Pwa-Sha256', digest);
					await cache.put(url, new Response(buffer, {status: 200, headers}));
					loaded += file.bytes; progress({loaded, total, file: file.path});
				}
				const accepted = await this.caches.open(name);
				for (const file of release.files) {
					const url = new URL(release.base + file.path, this.scope).href;
					await accepted.put(url, await cache.match(url));
				}
				// The final marker is the commit barrier. Until this write, no partial release can be played.
				await accepted.put(this.marker, new Response(JSON.stringify(release), {headers: {'Content-Type': 'application/json'}}));
				return release;
			} finally { await this.caches.delete(stagingName); }
		}
		async check(progress) {
			const release = await this.latest();
			await this.ensure(release, progress);
			return {release, offline: false};
		}
		async offlineCandidate() {
			const wanted = await this.readState();
			if (!wanted) return null;
			if (!(await this.ready(wanted))) throw new ReleaseError('UPDATE_PENDING', 'Обновление ещё не загружено. Подключитесь к сети, чтобы закончить загрузку.');
			return wanted;
		}
		async asset(requestUrl) {
			const url = new URL(requestUrl);
			if (url.origin !== new URL(this.scope).origin || !url.pathname.startsWith(new URL(this.scope).pathname)) return null;
			const relative = url.pathname.slice(new URL(this.scope).pathname.length);
			const match = relative.match(/^releases\/([a-zA-Z0-9_-]+)\/game\/([a-zA-Z0-9_.-]+)$/);
			if (!match || url.origin !== new URL(this.scope).origin) return null;
			const cache = await this.caches.open(this.prefix + 'release-' + match[1]);
			const marker = await cache.match(this.marker);
			if (!marker) return new Response('Обновление ещё не готово.', {status: 503});
			let release;
			try { release = validateRelease(await marker.json()); } catch (_) { return new Response('Повреждённая сборка.', {status: 503}); }
			if (!release.files.some((file) => file.path === match[2])) return new Response('Файл не входит в сборку.', {status: 404});
			url.search = ''; url.hash = '';
			return await cache.match(url.href) || new Response('Файл сборки утрачен. Откройте меню и повторите проверку.', {status: 503});
		}
		async prune(activeIds = []) {
			const completed = [];
			for (const name of await this.caches.keys()) {
				if (!name.startsWith(this.prefix + 'release-')) continue;
				const marker = await (await this.caches.open(name)).match(this.marker);
				if (!marker) continue;
				try { completed.push({name, release: validateRelease(await marker.json())}); } catch (_) {}
			}
			completed.sort((a, b) => (b.release.created_utc || '').localeCompare(a.release.created_utc || ''));
			const keep = new Set([...activeIds, ...completed.slice(0, 2).map((item) => item.release.id)]);
			for (const item of completed) if (!keep.has(item.release.id)) await this.caches.delete(item.name);
		}
	}
	root.UnderPwa = {ReleaseCache, ReleaseError, validateRelease};
	if (typeof module !== 'undefined' && module.exports) module.exports = root.UnderPwa;
})(globalThis);

/* 19e922b39a6fc1d5 and the integrity core are injected by package_under_pwa.py. */
'use strict';
const SHELL_VERSION = '19e922b39a6fc1d5';
const SCOPE = self.registration.scope;
const releases = new UnderPwa.ReleaseCache({scope: SCOPE, caches, fetch: self.fetch.bind(self), crypto});
const SHELL_CACHE = releases.prefix + 'shell-' + SHELL_VERSION;
const SHELL_FILES = ['index.html', 'index.manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const rootUrl = new URL('index.html', SCOPE).href;

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(SHELL_CACHE);
		for (const path of SHELL_FILES) {
			const url = new URL(path, SCOPE).href;
			const response = await fetch(new URL(path + '?shell=' + SHELL_VERSION, SCOPE).href, {cache: 'no-store'});
			if (!response.ok) throw new Error('Incomplete app shell');
			await cache.put(url, response);
		}
		await self.skipWaiting();
	})());
});
self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		await self.clients.claim();
		for (const name of await caches.keys()) {
			if (name.startsWith(releases.prefix + 'shell-') && name !== SHELL_CACHE) await caches.delete(name);
		}
	})());
});
self.addEventListener('message', (event) => {
	const port = event.ports && event.ports[0];
	if (!port || !event.source || !event.source.url || !event.source.url.startsWith(SCOPE)) return;
	if (event.data && event.data.type === 'PING') { port.postMessage({type: 'PONG', protocol: 1}); return; }
	if (!event.data || event.data.type !== 'CHECK') return;
	event.waitUntil((async () => {
		try {
			const result = await releases.check((progress) => port.postMessage({type: 'PROGRESS', ...progress}));
			port.postMessage({type: 'READY', ...result});
			const clients = await self.clients.matchAll({includeUncontrolled: true});
			const active = clients.map((client) => client.url.match(/\/releases\/([a-zA-Z0-9_-]+)\/game\//)?.[1]).filter(Boolean);
			await releases.prune(active);
		} catch (error) {
			let offline = null;
			if (error.code === 'OFFLINE') {
				try { offline = await releases.offlineCandidate(); }
				catch (pending) { error = pending; }
			}
			port.postMessage({type: 'ERROR', code: error.code || 'STORAGE', message: error.message, offline});
		}
	})());
});
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET' || !url.href.startsWith(SCOPE)) return;
	const relative = url.pathname.slice(new URL(SCOPE).pathname.length);
	if (relative === 'release.json') {
		event.respondWith(fetch(event.request, {cache: 'no-store'}));
		return;
	}
	if (relative.startsWith('releases/')) {
		event.respondWith(releases.asset(url.href).then((response) => response || new Response('Файл не найден.', {status: 404})));
		return;
	}
	if (relative === '' || relative === 'index.html') {
		event.respondWith((async () => {
			try {
				const response = await fetch(new URL('index.html?check=' + Date.now(), SCOPE).href, {cache: 'no-store'});
				if (!response.ok) throw new Error('App unavailable');
				await (await caches.open(SHELL_CACHE)).put(rootUrl, response.clone());
				return response;
			} catch (_) {
				return await (await caches.open(SHELL_CACHE)).match(rootUrl) || new Response('Для первого запуска нужна сеть.', {status: 503});
			}
		})());
		return;
	}
	if (SHELL_FILES.includes(relative)) {
		event.respondWith((async () => {
			try {
				const response = await fetch(event.request, {cache: 'no-store'});
				if (response.ok) return response;
			} catch (_) {}
			return await (await caches.open(SHELL_CACHE)).match(new URL(relative, SCOPE).href) || new Response('', {status: 503});
		})());
	}
});
