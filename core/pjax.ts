import { broadcaster } from './broadcaster';
import { debug, env, uuid } from './env';
import { notify } from '../packages/notify.js';
import { sendPageView, setupGoogleAnalytics } from './gtags.js';

interface PjaxState {
	activeRequestUid: string,
}

interface NavigaitonRequest
{
	body?: string,
	title?: string,
	url: string,
	history: 'push'|'replace',
	ticket: string,
	requestUid: string,
}

class Pjax {
	private state: PjaxState;
	private worker: Worker;
	private serviceWorker: ServiceWorker;
	private navigationRequestQueue: Array<NavigaitonRequest>;

	constructor() {
		this.state = {
			activeRequestUid: null,
		};
		this.worker = null;
		this.serviceWorker = null;
		this.navigationRequestQueue = [];
		this.init();
	}

	/**
	 * Initializes the Pjax class.
	 */
	private init(): void {
		/** Prepare our reload prompt tracking for the session */
		if (!sessionStorage.getItem('prompts'))
		{
			sessionStorage.setItem('prompts', '0');
		}

		/** Hookup Pjax's inbox */
		broadcaster.hookup('pjax', this.inbox.bind(this));

		/** Prepare Google Analytics */
		setupGoogleAnalytics(document.documentElement.dataset.gaId);

		/** Prepare the Pjax Web Worker */
		this.worker = new Worker(`${window.location.origin}/assets/pjax-worker.js`);
		this.worker.onmessage = this.handleWorkerMessage.bind(this);

		/** Attempt to register a service worker */
		if ('serviceWorker' in navigator)
		{
			navigator.serviceWorker
			.register(`${window.location.origin}/service-worker.js`, { scope: '/' })
			.then((reg) => {
				/** Verify the service worker was registered correctly */
				if (navigator.serviceWorker.controller) {
					this.serviceWorker = navigator.serviceWorker.controller;
					navigator.serviceWorker.onmessage = this.handleServiceWorkerMessage.bind(this);

					/** Tell the service worker to get the latest cachebust data */
					this.serviceWorker.postMessage({
						type: 'cachebust',
						url: window.location.href
					});

					/** Tell Pjax to check if the current page is stale */
					broadcaster.message('pjax', { type: 'revision-check' });
				}
			})
			.catch((error) => {
				console.error('Registration failed with ' + error);
			});
		}
		/** Add event listeners */
		window.addEventListener('popstate', this.windowPopstateEvent);
		/** Update the history state with the required `state.url` value */
		window.history.replaceState({ url: window.location.href }, document.title, window.location.href);
		/** Tell Pjax to hijack all viable links */
		broadcaster.message('pjax', { type: 'hijack-links' });
	}

	/**
	 * The public inbox for the Pjax class. All incoming messages sent through the `Broadcaster` will be received here.
	 * @param data - the `MessageData` passed into the inbox by the `Broadcaster` class
	 */
	private inbox(data: MessageData): void {
		const { type } = data;
		switch (type) {
			case 'revision-check':
				this.checkPageRevision();
				break;
			case 'hijack-links':
				this.collectLinks();
				break;
			case 'load':
				this.navigate(data.url, data?.history);
				break;
			case 'navigation-update':
				this.updateHistory(data.title, data.url, data.history);
				this.collectLinks();
				this.checkPageRevision();
				sendPageView(window.location.pathname, document.documentElement.dataset.gaId);
				break;
			case 'css-ready':
				this.swapPjaxContent(data.requestUid);
				break;
			default:
				if (debug) {
					console.warn(`Undefined Pjax message type: ${type}`);
				}
				break;
		}
	}

	/**
	 * Handles messages from the Service Worker.
	 * @param e - the `MessageEvent` object
	 */
	private handleServiceWorkerMessage(e: MessageEvent): void {
		const { type } = e.data;
		switch (type) {
			case 'page-refresh':
				let promptCount = parseInt(sessionStorage.getItem('prompts'));
				promptCount = promptCount + 1;
				sessionStorage.setItem('prompts', `${ promptCount }`);
				notify({
					message: 'A new version of this page is available.',
					closeable: true,
					force: true,
					duration: Infinity,
					buttons: [
						{
							label: 'Reload',
							callback: () => {
								window.location.reload();
							},
						},
					],
				});
				break;
			case 'set-max-prompts':
				sessionStorage.setItem('maxPrompts', `${ e.data.max }`);
				const currentPromptCount = sessionStorage.getItem('prompts');
				if (parseInt(currentPromptCount) >= e.data.max)
				{
					sessionStorage.setItem('prompts', '0');
					this.serviceWorker.postMessage({
						type: 'clear-content-cache'
					});
				}
				break;
			default:
				if (debug) {
					console.error(`Undefined Service Worker response message type: ${type}`);
				}
				break;
		}
	}

	/**
	 * Handles messages from the Pjax Web Worker.
	 * @param e - the `MessageEvent` object
	 */
	private handleWorkerMessage(e: MessageEvent): void {
		const { type } = e.data;
		switch (type) {
			case 'revision-check':
				if (e.data.status === 'stale') {
					this.serviceWorker.postMessage({
						type: 'page-refresh',
						url: e.data.url,
						network: env.connection,
					});
				}
				break;
			case 'pjax':
				this.handlePjaxResponse(e.data.requestId, e.data.status, e.data.url, e.data?.body, e.data?.error)
				break;
			default:
				if (debug) {
					console.error(`Undefined Pjax Worker response message type: ${type}`);
				}
				break;
		}
	}

	/**
	 * Creates and sends a navigation request to the Pjax web worker and queues navigation request.
	 * @param url - the URL of the requested page
	 * @param history - how Pjax should handle the windows history manipulation
	 */
	private navigate(url:string, history:'push'|'replace' = 'push'): void
	{
		/** TODO: update loading animation to use custom Pjax hanging transition animation */
		const requestUid = uuid();
		this.state.activeRequestUid = requestUid;
		const navigationRequest:NavigaitonRequest = {
			url: url,
			history: history,
			requestUid: requestUid,
			ticket: env.startLoading()
		};
		this.navigationRequestQueue.push(navigationRequest);
		this.worker.postMessage({
			type: 'pjax',
			requestId: requestUid,
			url: url
		});
	}

	/**
	 * Handles the windows `popstate` event.
	 * @param e - the `PopStateEvent` object
	 */
	private hijackPopstate(e:PopStateEvent): void
	{
		/** Only hijack the event when the `history.state` object contains a URL */
		if (e.state?.url)
		{
			/** Tells the Pjax class to load the URL stored in this windows history.
			 * In order to preserve the timeline navigation the history will use `replace` instead of `push`.
			 */
			broadcaster.message('pjax', {
				type: 'load',
				url: e.state.url,
				history: 'replace',
			});
		}
	}
	private windowPopstateEvent:EventListener = this.hijackPopstate.bind(this);

	/**
	 * Handles history manipulation by replacing or pushing the new state into the windows history timeline.
	 * @param title - the new document title
	 * @param url - the new pages URL
	 * @param history - how the window history should be manipulated
	 */
	private updateHistory(title:string, url:string, history:'push'|'replace'): void
	{
		if (history === 'replace')
		{
			window.history.replaceState({
				url: url,
			}, title, url);
		}
		else
		{
			window.history.pushState({
				url: url,
			}, title, url);
		}
	}

	/**
	 * Called when the `click` event fires on a Pjax tracked anchor element.
	 * @param e - click `Event`
	 */
	private hijackRequest(e:Event): void
	{
		e.preventDefault();
		const target = e.currentTarget as HTMLAnchorElement;
		/** Tell Pjax to load the clicked elements page */
		broadcaster.message('pjax', {
			type: 'load',
			url: target.href,
		});
	}
	private handleLinkClick:EventListener = this.hijackRequest.bind(this);

	/**
	 * Collect all anchor elements with a `href` attribute and add a click event listener.
	 * Ignored links are:
	 * - any link with a `no-pjax` attribute
	 * - any link with a `no-pjax` class
	 * - any link with a `target` attribute
	 */
	private collectLinks(): void
	{
		const unregisteredLinks = Array.from(document.body.querySelectorAll('a[href]:not([pjax-tracked]):not([no-pjax]):not([target]):not(.no-pjax)'));
		if (unregisteredLinks.length)
		{
			unregisteredLinks.map((link:HTMLAnchorElement) => {
				link.setAttribute('pjax-tracked', 'true');
				link.addEventListener('click', this.handleLinkClick);
			});
		}
	}

	/**
	 * Handles the Pjax response from the web worker.
	 * This method will update the `NavigationRequest` object and continue with the transition or will remove the stale request or will fallback to traditional (native) page navigaiton when an error occurs.
	 * @param requestId - the navigation request's unique ID
	 * @param status - the response status of the request
	 * @param url - the requested URL
	 * @param body - the body text of the requested page
	 * @param error - the error message of the failed request
	 */
	private handlePjaxResponse(requestId:string, status:string, url:string, body?:string, error?:string)
	{
		const request = this.getNavigaitonRequest(requestId);
		if (requestId === this.state.activeRequestUid)
		{
			if (status === 'ok')
			{
				const tempDocument:HTMLDocument = document.implementation.createHTMLDocument('pjax-temp-document');
				tempDocument.documentElement.innerHTML = body;
				const currentMain = document.body.querySelector('main');
				const main = tempDocument.querySelector(`main[data-id="${ currentMain.dataset.id }"]`);
				if (main && currentMain)
				{
					/** Tells the runtime class to parse the incoming HTML for any new CSS files */
					broadcaster.message('runtime', {
						type: 'parse',
						body: main.innerHTML,
						requestUid: requestId,
					});
					request.body = main.innerHTML;
					request.title = tempDocument.title;
				}
				else
				{
					if (debug)
					{
						console.error('Failed to find the new and current main elements');
					}
					window.location.href = url;
				}
			}
			else
			{
				if (debug)
				{
					console.error(`Failed to fetch page: ${ url }. Server responded with: ${ error }`);
				}
				window.location.href = url;
			}
		}
		else
		{
			env.stopLoading(request.ticket);
			this.removeNavigationRequest(request.requestUid);
			if (status !== 'ok' && debug)
			{
				console.error(`Failed to fetch page: ${ url }. Server responded with: ${ error }`);
			}
		}
	}

	/**
	 * 
	 * @param requestUid - the navigation request unique id
	 */
	private swapPjaxContent(requestUid:string)
	{
		const request = this.getNavigaitonRequest(requestUid);
		if (request.requestUid === this.state.activeRequestUid)
		{
			/** Updates content */
			const currentMain = document.body.querySelector('main');
			currentMain.innerHTML = request.body;
			document.title = request.title;

			/** Tells the Pjax class to update the navigation */
			broadcaster.message('pjax', {
				type: 'navigation-update',
				url: request.url,
				title: request.title,
				history: request.history,
			});

			/** Tells the Runtime class to mount any new web components */
			broadcaster.message('runtime', {
				type: 'mount-components',
			});
		}
		env.stopLoading(request.ticket);
		this.removeNavigationRequest(request.requestUid);
	}

	/**
	 * Removes the `NavigationRequest` object from the queue.
	 * @param requestId - the unique ID of the `NavigationRequest` object
	 */
	private removeNavigationRequest(requestId:string): void
	{
		for (let i = 0; i < this.navigationRequestQueue.length; i++)
		{
			if (this.navigationRequestQueue[i].requestUid === requestId)
			{
				this.navigationRequestQueue.splice(i, 1);
				break;
			}
		}
	}

	/**
	 * Gets the `NavigationRequest` object from the queue.
	 * @param requestId - the unique ID of the `NavigationRequest` object
	 */
	private getNavigaitonRequest(requestId:string): NavigaitonRequest
	{
		for (let i = 0; i < this.navigationRequestQueue.length; i++)
		{
			if (this.navigationRequestQueue[i].requestUid === requestId)
			{
				return this.navigationRequestQueue[i];
			}
		}

		return null;
	}

	/**
	 * Sends a `revision-check` message to the Pjax web worker.
	 */
	private checkPageRevision() {
		this.worker.postMessage({
			type: 'revision-check',
			url: window.location.href,
		});
	}
}
new Pjax();
