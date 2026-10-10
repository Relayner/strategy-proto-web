/* Shared by the generated service worker and the Node integrity tests. */
(function (root) {
	'use strict';
	const MAX_PROGRESS_OBSERVERS = 64;
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
		constructor({scope, caches, fetch, crypto, now = () => Date.now(), metadataTimeoutMs = 15000,
			assetTimeoutMs = 900000, assetIdleTimeoutMs = 60000}) {
			this.scope = new URL('./', scope).href;
			this.caches = caches; this.fetch = fetch; this.crypto = crypto; this.now = now;
			this.metadataTimeoutMs = metadataTimeoutMs; this.assetTimeoutMs = assetTimeoutMs;
			this.assetIdleTimeoutMs = assetIdleTimeoutMs;
			this.prefix = `under-pwa-${encodeURIComponent(new URL(this.scope).pathname)}-`;
			this.marker = new URL('__complete__', this.scope).href;
			this.stateUrl = new URL('__latest__', this.scope).href;
			this.jobs = new Map();
		}
		cacheName(release) { return this.prefix + 'release-' + release.id; }
		async network(url, options, timeoutMs, consume) {
			const controller = new AbortController();
			let timer;
			const deadline = new Promise((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error('Update request timed out.'));
				}, timeoutMs);
			});
			// The deadline includes the body, not just response headers. Race also bounds
			// transports which ignore abort; consume must not write state or cache data.
			const request = (async () => {
				const response = await this.fetch(url, {...options, signal: controller.signal});
				if (controller.signal.aborted) throw new Error('Update request timed out.');
				return consume(response);
			})();
			try { return await Promise.race([request, deadline]); }
			finally { clearTimeout(timer); }
		}
		async streamAsset(url, file, progress) {
			const controller = new AbortController();
			let reader, buffer, idleTimer, totalTimer, closed = false, cancelled = false;
			const cancel = () => {
				if (!reader || cancelled) return;
				cancelled = true;
				// Cleanup must not wait for a transport which ignores abort or cancellation.
				try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
			};
			const checkOpen = () => {
				if (closed || controller.signal.aborted) throw new Error('Update request timed out.');
			};
			let expire;
			const deadline = new Promise((_, reject) => {
				expire = () => {
					closed = true; buffer = null;
					controller.abort(); cancel();
					reject(new Error('Update request timed out.'));
				};
				totalTimer = setTimeout(expire, this.assetTimeoutMs);
			});
			const resetIdle = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(expire, this.assetIdleTimeoutMs);
			};
			resetIdle(); // Includes waiting for response headers.
			const request = (async () => {
				const response = await this.fetch(url, {cache: 'no-store', credentials: 'same-origin', signal: controller.signal});
				checkOpen();
				if (!response.ok) throw new ReleaseError('DOWNLOAD', 'Не удалось загрузить обновление целиком.');
				resetIdle();
				// fetch exposes decoded bytes, so Content-Length may describe a compressed body.
				// Bound allocation and every copy to the integrity manifest, never that header.
				buffer = new Uint8Array(file.bytes);
				if (!response.body) {
					if (file.bytes !== 0) throw new ReleaseError('INTEGRITY', 'Файл обновления повреждён. Повторите загрузку.');
					return {response, buffer: buffer.buffer};
				}
				reader = response.body.getReader();
				let received = 0;
				while (true) {
					const {done, value} = await reader.read();
					checkOpen(); // Ignored abort must not copy bytes or publish late progress.
					if (done) break;
					if (!(value instanceof Uint8Array) || value.byteLength > file.bytes - received) {
						throw new ReleaseError('INTEGRITY', 'Файл обновления повреждён. Повторите загрузку.');
					}
					if (value.byteLength === 0) continue;
					buffer.set(value, received); received += value.byteLength;
					resetIdle();
					progress(received);
				}
				if (received !== file.bytes) throw new ReleaseError('INTEGRITY', 'Файл обновления повреждён. Повторите загрузку.');
				return {response, buffer: buffer.buffer};
			})();
			try { return await Promise.race([request, deadline]); }
			finally {
				closed = true; buffer = null;
				clearTimeout(idleTimer); clearTimeout(totalTimer);
				cancel();
				if (reader) { try { reader.releaseLock(); } catch (_) {} }
			}
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
			let release;
			try {
				release = await this.network(new URL(`release.json?check=${this.now()}`, this.scope).href,
					{cache: 'no-store', credentials: 'same-origin'}, this.metadataTimeoutMs, async (response) => {
						if (!response.ok) throw new ReleaseError('SERVER', `Сервер обновлений недоступен (${response.status}).`);
						try { return validateRelease(await response.json()); }
						catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError('MANIFEST', 'Не удалось прочитать обновление.'); }
					});
			} catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError('OFFLINE', 'Не удалось проверить обновления.'); }
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
		async reuseCandidates(release) {
			const completed = [];
			for (const name of await this.caches.keys()) {
				if (!name.startsWith(this.prefix + 'release-') || name === this.cacheName(release)) continue;
				const cache = await this.caches.open(name);
				const marker = await cache.match(this.marker);
				if (!marker) continue;
				try {
					const prior = validateRelease(await marker.json());
					if (name === this.cacheName(prior)) completed.push({release: prior, cache});
				} catch (_) {}
			}
			completed.sort((a, b) => String(b.release.created_utc || '').localeCompare(String(a.release.created_utc || '')));
			const candidates = [];
			for (const item of completed) {
				if (await this.ready(item.release)) candidates.push(item);
				// Bound local body reads to the two most recent complete releases.
				if (candidates.length === 2) break;
			}
			return candidates;
		}
		async digest(buffer) {
			return Array.from(new Uint8Array(await this.crypto.subtle.digest('SHA-256', buffer)),
				(v) => v.toString(16).padStart(2, '0')).join('');
		}
		async reusable(file, candidates) {
			for (const item of candidates) {
				if (!item.release.files.some((prior) => prior.path === file.path && prior.bytes === file.bytes && prior.sha256 === file.sha256)) continue;
				try {
					const response = await item.cache.match(new URL(item.release.base + file.path, this.scope).href);
					if (!response || response.headers.get('X-Under-Pwa-Sha256') !== file.sha256 ||
						Number(response.headers.get('Content-Length')) !== file.bytes) continue;
					// Metadata alone cannot establish integrity. Recheck actual cached bytes,
					// one file at a time, before putting them under the new release URL.
					const buffer = await response.arrayBuffer();
					if (buffer.byteLength !== file.bytes) continue;
					const digest = await this.digest(buffer);
					if (digest === file.sha256) return {response, buffer, digest};
				} catch (_) {} // A missing or corrupt old file is repaired by the network path.
			}
			return null;
		}
		observe(job, progress) {
			if (typeof progress !== 'function') return;
			// Retain only current observers and one latest snapshot, never a byte history.
			if (!job.observers.has(progress) && job.observers.size >= MAX_PROGRESS_OBSERVERS) job.observers.delete(job.observers.values().next().value);
			job.observers.add(progress);
			if (job.progress) this.notify(job, progress);
		}
		notify(job, progress) {
			try {
				// One closed/disconnected port must not stop the shared integrity job or
				// change another client's snapshot. False is an optional observer opt-out.
				if (progress({...job.progress}) === false) job.observers.delete(progress);
			} catch (_) { job.observers.delete(progress); }
		}
		publish(job, progress) {
			job.progress = {...progress};
			for (const observer of [...job.observers]) this.notify(job, observer);
		}
		async ensure(release, progress) {
			validateRelease(release);
			let job = this.jobs.get(release.id);
			if (job && job.signature !== signature(release)) {
				throw new ReleaseError('MANIFEST', 'Идентификатор загружаемой сборки был изменён. Сервер должен выпустить новую сборку.');
			}
			if (!job) {
				job = {signature: signature(release), observers: new Set(), progress: null, promise: null};
				this.jobs.set(release.id, job);
				this.observe(job, progress);
				job.promise = this.download(release, (item) => this.publish(job, item)).finally(() => {
					job.observers.clear(); job.progress = null;
					if (this.jobs.get(release.id) === job) this.jobs.delete(release.id);
				});
			} else this.observe(job, progress); // Reconnect gets the latest bytes before its next network chunk.
			try { return await job.promise; }
			finally { job.observers.delete(progress); }
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
			let loaded = 0, reused = 0;
			progress({loaded, total, reused, file: ''});
			try {
				const candidates = await this.reuseCandidates(release);
				for (const file of release.files) {
					const url = new URL(release.base + file.path, this.scope).href;
					let response, buffer, digest;
					progress({loaded, total, reused, file: file.path});
					const cached = await this.reusable(file, candidates);
					if (cached) ({response, buffer, digest} = cached);
					else {
						try {
							({response, buffer} = await this.streamAsset(url, file,
								(received) => progress({loaded: loaded + received, total, reused, file: file.path})));
						}
						catch (error) { throw error instanceof ReleaseError ? error : new ReleaseError('DOWNLOAD', 'Загрузка обновления прервалась.'); }
						digest = await this.digest(buffer);
					}
					if (buffer.byteLength !== file.bytes || digest !== file.sha256) {
						throw new ReleaseError('INTEGRITY', 'Файл обновления повреждён. Повторите загрузку.');
					}
					const headers = new Headers(response.headers);
					// fetch returns decoded bytes; retaining Content-Encoding would be wrong for the reconstructed Response.
					headers.delete('Content-Encoding'); headers.delete('Transfer-Encoding');
					headers.set('Content-Length', String(buffer.byteLength));
					headers.set('X-Under-Pwa-Sha256', digest);
					await cache.put(url, new Response(buffer, {status: 200, headers}));
					loaded += file.bytes;
					if (cached) reused += file.bytes;
					progress({loaded, total, reused, file: file.path});
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
		async check(progress, activeReleaseId = null) {
			if (activeReleaseId !== null && (typeof activeReleaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(activeReleaseId))) {
				throw new ReleaseError('MANIFEST', 'Некорректная активная сборка.');
			}
			const release = await this.latest();
			// Only metadata and committed-cache headers are read while an engine is alive.
			// Remembering the new descriptor above still blocks obsolete offline fallback.
			if (activeReleaseId !== null) {
				if (activeReleaseId !== release.id || !(await this.ready(release))) {
					return {release, offline: false, retireRequired: true};
				}
				return {release, offline: false};
			}
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

/* e1228e930e51f693 and the integrity core are injected by package_under_pwa.py. */
'use strict';
const SHELL_VERSION = 'e1228e930e51f693';
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
	if (event.data && event.data.type === 'PING') { port.postMessage({type: 'PONG', protocol: 1, workerShell: SHELL_VERSION}); return; }
	if (!event.data || event.data.type !== 'CHECK') return;
	event.waitUntil((async () => {
		try {
			const result = await releases.check((progress) => port.postMessage({type: 'PROGRESS', ...progress}),
				event.data.activeReleaseId ?? null);
			if (result.retireRequired) {
				port.postMessage({type: 'RETIRE_REQUIRED', ...result});
				return;
			}
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
