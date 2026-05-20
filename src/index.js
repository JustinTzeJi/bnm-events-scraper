import * as cheerio from 'cheerio';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
	async scheduled(event, env, ctx) {
		const currentYear = new Date().getFullYear();
		ctx.waitUntil(this.updateData([currentYear, currentYear + 1], env));
	},

	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/init') {
			const startYear = parseInt(url.searchParams.get('start') || '2011', 10);
			const endYear = parseInt(url.searchParams.get('end') || '2026', 10);
			const years = [];
			for (let y = startYear; y <= endYear; y++) years.push(y);
			await this.updateData(years, env);
			return new Response(`Update initiated. Check logs.`, { status: 200 });
		}
		return new Response('Not found', { status: 404 });
	},

	async updateData(yearsToUpdate, env) {
		let allEvents = [];
		const existingFile = await env.BUCKET.get('events.json');
		if (existingFile) {
			allEvents = await existingFile.json();
		}

		for (let i = 0; i < yearsToUpdate.length; i++) {
			const year = yearsToUpdate[i];
			console.log(`[PROCESS] Fetching year: ${year}`);

			try {
				const apiResponse = await this.fetchYearHTML(year, env);
				const htmlString = apiResponse.result;

				if (htmlString) {
					const yearEvents = this.extractEvents(htmlString, year);

					if (yearEvents.length > 0) {
						console.log(`[SUCCESS] Extracted ${yearEvents.length} events for ${year}. Updating archive...`);
						// ONLY remove old data for this specific year if we got new data
						allEvents = allEvents.filter((e) => e.year !== year);
						allEvents.push(...yearEvents);
					} else {
						console.warn(`[SKIP] No valid events found for ${year}. Keeping existing archive data.`);
					}
				}
			} catch (err) {
				console.error(`[ERROR] Year ${year} failed: ${err.message}`);
			}

			if (i < yearsToUpdate.length - 1) await delay(3000);
		}

		// Global Deduplication
		const uniqueMap = new Map();
		allEvents.forEach((event) => {
			const key = `${event.start_date}-${event.title}`;
			uniqueMap.set(key, event);
		});

		const finalData = Array.from(uniqueMap.values());
		finalData.sort((a, b) => a.start_date - b.start_date);

		if (finalData.length === 0) {
			console.error('[CRITICAL] Final data is empty. Aborting R2 write to prevent data loss.');
			return;
		}

		await Promise.all([
			env.BUCKET.put('events.json', JSON.stringify(finalData, null, 2), {
				httpMetadata: { contentType: 'application/json' },
			}),
			env.BUCKET.put('events.ics', this.generateICS(finalData), {
				httpMetadata: { contentType: 'text/calendar' },
			}),
		]);
	},

	async fetchYearHTML(year, env) {
		const targetUrl = `https://www.bnm.gov.my/web/guest/upcoming-events/-/tag/events-${year}`;
		let retries = 3;
		while (retries > 0) {
			const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.CF_API_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ url: targetUrl }),
			});

			const data = await response.json();
			if (response.ok && data.success) return data;
			if (response.status === 429) {
				retries--;
				await delay(5000);
				continue;
			}
			throw new Error(`Browser Rendering API status ${response.status}`);
		}
	},

	extractEvents(html, intendedYear) {
		const $ = cheerio.load(html);
		const events = [];

		$('.Press-table tbody tr').each((_, el) => {
			if ($(el).find('th').length > 0) return;
			const cols = $(el).find('td');
			if (cols.length < 2) return;

			const rawDate = $(cols[0]).text().trim().replace(/\s+/g, ' ');
			const dates = this.parseDates(rawDate);

			if (!dates) {
				console.log(`[DEBUG] Skipping row: Could not parse date "${rawDate}"`);
				return;
			}

			if (dates.start.getUTCFullYear() !== intendedYear) {
				console.log(`[DEBUG] Skipping row: Found year ${dates.start.getUTCFullYear()} but expected ${intendedYear}`);
				return;
			}

			const titleCell = $(cols[1]);
			const badgeText = titleCell.find('.badge').text().trim() || null;

			const titleClone = titleCell.clone();
			titleClone.find('.badge').remove();
			const title = titleClone.text().trim().replace(/\s+/g, ' ');

			const link = titleCell.find('a').attr('href');
			const contentUrl = link ? (link.startsWith('http') ? link : `https://www.bnm.gov.my${link}`) : null;

			events.push({
				year: intendedYear,
				title,
				date_str: rawDate,
				start_date: dates.start.getTime(),
				end_date: dates.end.getTime(),
				event_type: badgeText,
				content_url: contentUrl,
			});
		});

		return events;
	},

	parseDates(dateStr) {
		// BNM uses various spaces and dots. We strip them and lowercase for matching.
		const cleaned = dateStr.replace(/\*/g, '').replace(/\./g, '').trim().replace(/\s+/g, ' ');

		const months = {
			jan: 0,
			feb: 1,
			mar: 2,
			apr: 3,
			may: 4,
			jun: 5,
			jul: 6,
			aug: 7,
			sep: 8,
			oct: 9,
			nov: 10,
			dec: 11,
		};

		// Robust regex for Range: "20-23 Mar 2026"
		const range = cleaned.match(/^(\d+)-(\d+)\s+([A-Za-z]+)\s+(\d{4})$/);
		if (range) {
			const m = months[range[3].toLowerCase().substring(0, 3)];
			const y = parseInt(range[4]);
			if (m === undefined) return null;
			return {
				start: new Date(Date.UTC(y, m, parseInt(range[1]))),
				end: new Date(Date.UTC(y, m, parseInt(range[2]))),
			};
		}

		// Robust regex for Single: "1 Jan 2026"
		const single = cleaned.match(/^(\d+)\s+([A-Za-z]+)\s+(\d{4})$/);
		if (single) {
			const m = months[single[2].toLowerCase().substring(0, 3)];
			const y = parseInt(single[3]);
			if (m === undefined) return null;
			const d = new Date(Date.UTC(y, m, parseInt(single[1])));
			return { start: d, end: d };
		}

		return null;
	},

	generateICS(events) {
		let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BNM//EN\r\nCALSCALE:GREGORIAN\r\n';
		for (const e of events) {
			const summary = e.event_type ? `[${e.event_type}] ${e.title}` : e.title;
			const start = new Date(e.start_date)
				.toISOString()
				.replace(/-|:|\.\d+/g, '')
				.split('T')[0];
			const endObj = new Date(e.end_date);
			endObj.setUTCDate(endObj.getUTCDate() + 1);
			const end = endObj
				.toISOString()
				.replace(/-|:|\.\d+/g, '')
				.split('T')[0];

			ics += 'BEGIN:VEVENT\r\n';
			ics += `SUMMARY:${summary}\r\n`;
			ics += `DTSTART;VALUE=DATE:${start}\r\n`;
			ics += `DTEND;VALUE=DATE:${end}\r\n`;
			ics += `DESCRIPTION:Date: ${e.date_str}${e.content_url ? '\\nLink: ' + e.content_url : ''}\r\n`;
			ics += `UID:${e.start_date}-${e.title.substring(0, 20).replace(/\s+/g, '')}@bnm.gov.my\r\n`;
			ics += 'END:VEVENT\r\n';
		}
		ics += 'END:VCALENDAR';
		return ics;
	},
};
