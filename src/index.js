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
			return new Response(`Update triggered.`, { status: 200 });
		}
		return new Response('Not found.', { status: 404 });
	},

	async updateData(yearsToUpdate, env) {
		let allEvents = [];
		const existingFile = await env.BUCKET.get('events.json');
		if (existingFile) {
			allEvents = await existingFile.json();
		}

		// 1. Remove events belonging to the years we are about to refresh
		allEvents = allEvents.filter((e) => !yearsToUpdate.includes(e.year));

		for (let i = 0; i < yearsToUpdate.length; i++) {
			const year = yearsToUpdate[i];
			try {
				const apiResponse = await this.fetchYearHTML(year, env);
				const htmlString = apiResponse.result;

				if (htmlString) {
					// 2. Extract events and validate they actually belong to the intended year
					const yearEvents = this.extractEvents(htmlString, year);
					allEvents.push(...yearEvents);
				}
			} catch (err) {
				console.error(`Error scraping ${year}: ${err.message}`);
			}

			if (i < yearsToUpdate.length - 1) await delay(3000);
		}

		// 3. Global Deduplication pass
		// We use a Map with a composite key (date + title) to ensure uniqueness
		const uniqueMap = new Map();
		allEvents.forEach((event) => {
			const key = `${event.start_date}-${event.title}`;
			// If duplicate found, we prefer the one that actually matches its labeled year
			if (!uniqueMap.has(key)) {
				uniqueMap.set(key, event);
			}
		});

		// Convert back to array and sort
		const finalData = Array.from(uniqueMap.values());
		finalData.sort((a, b) => a.start_date - b.start_date);

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
				body: JSON.stringify({
					url: targetUrl,
					gotoOptions: {
						waitUntil: 'networkidle0',
					},
				}),
			});

			const data = await response.json();
			if (response.ok && data.success) return data;
			if (response.status === 429) {
				retries--;
				await delay(5000);
				continue;
			}
			throw new Error(`API Error: ${response.status}`);
		}
	},

	extractEvents(html, intendedYear) {
		const $ = cheerio.load(html);
		const events = [];

		$('.Press-table tbody tr').each((_, el) => {
			if ($(el).find('th').length > 0) return;
			const cols = $(el).find('td');
			if (cols.length < 2) return;

			const dateStr = $(cols[0]).text().trim();
			const dates = this.parseDates(dateStr);

			// PROTECTION 1: If we can't parse a date, or the date's year
			// doesn't match the year we are scraping, skip it.
			if (!dates || dates.start.getUTCFullYear() !== intendedYear) {
				return;
			}

			const titleCell = $(cols[1]);
			const badgeText = titleCell.find('.badge').text().trim();
			const titleClone = titleCell.clone();
			titleClone.find('.badge').remove();
			const title = titleClone.text().trim().replace(/\s+/g, ' ');

			const link = titleCell.find('a').attr('href');
			const contentUrl = link ? (link.startsWith('http') ? link : `https://www.bnm.gov.my${link}`) : null;

			events.push({
				year: intendedYear,
				title,
				date_str: dateStr,
				start_date: dates.start.getTime(),
				end_date: dates.end.getTime(),
				event_type: badgeText || null,
				content_url: contentUrl,
			});
		});

		return events;
	},

	parseDates(dateStr) {
		const cleaned = dateStr.replace(/\*/g, '').trim();
		const months = {
			Jan: 0,
			Feb: 1,
			Mar: 2,
			Apr: 3,
			May: 4,
			Jun: 5,
			Jul: 6,
			Aug: 7,
			Sep: 8,
			Oct: 9,
			Nov: 10,
			Dec: 11,
		};

		// Range: "20-23 Mar. 2026"
		const range = cleaned.match(/^(\d+)-(\d+)\s+([A-Za-z]+)\.?\s+(\d{4})$/);
		if (range) {
			const m = months[range[3].substring(0, 3)];
			const y = parseInt(range[4]);
			return {
				start: new Date(Date.UTC(y, m, parseInt(range[1]))),
				end: new Date(Date.UTC(y, m, parseInt(range[2]))),
			};
		}

		// Single: "1 Jan. 2026"
		const single = cleaned.match(/^(\d+)\s+([A-Za-z]+)\.?\s+(\d{4})$/);
		if (single) {
			const m = months[single[2].substring(0, 3)];
			const y = parseInt(single[3]);
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
			ics += `UID:${e.start_date}-${e.title.replace(/\s+/g, '')}@bnm.gov.my\r\n`;
			ics += 'END:VEVENT\r\n';
		}
		ics += 'END:VCALENDAR';
		return ics;
	},
};
