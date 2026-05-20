import * as cheerio from 'cheerio';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
	async scheduled(event, env, ctx) {
		const currentYear = new Date().getFullYear();
		// Daily: refresh this year and next year
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
			return new Response(`Update initiated. Check R2 in a few minutes.`, { status: 200 });
		}
		return new Response('Use /init?start=2011&end=2026', { status: 404 });
	},

	async updateData(yearsToUpdate, env) {
		let allEvents = [];
		const existingFile = await env.BUCKET.get('events.json');
		if (existingFile) {
			try {
				allEvents = await existingFile.json();
			} catch (e) {
				allEvents = [];
			}
		}

		for (let i = 0; i < yearsToUpdate.length; i++) {
			const year = yearsToUpdate[i];
			console.log(`[LOG] Scraping year: ${year}`);

			try {
				const apiResponse = await this.fetchYearHTML(year, env);
				const htmlString = apiResponse.result;

				if (htmlString) {
					const yearEvents = this.extractEvents(htmlString, year);

					if (yearEvents.length > 0) {
						// Remove old version of this year before adding new
						allEvents = allEvents.filter((e) => e.year !== year);
						allEvents.push(...yearEvents);
						console.log(`[LOG] Added ${yearEvents.length} events for ${year}`);
					} else {
						console.warn(`[WARN] No valid events found for ${year}. Skipping update for this year.`);
					}
				}
			} catch (err) {
				console.error(`[ERROR] Year ${year} failed: ${err.message}`);
			}

			// Space out requests for Browser Rendering rate limits
			if (i < yearsToUpdate.length - 1) await delay(3500);
		}

		// Global Deduplication (Key: Timestamp + Title)
		const uniqueMap = new Map();
		allEvents.forEach((e) => {
			const key = `${e.start_date}-${e.title}`;
			uniqueMap.set(key, e);
		});

		const finalData = Array.from(uniqueMap.values());
		finalData.sort((a, b) => a.start_date - b.start_date);

		if (finalData.length > 0) {
			await Promise.all([
				env.BUCKET.put('events.json', JSON.stringify(finalData, null, 2), {
					httpMetadata: { contentType: 'application/json' },
				}),
				env.BUCKET.put('events.ics', this.generateICS(finalData), {
					httpMetadata: { contentType: 'text/calendar' },
				}),
			]);
			console.log(`[DONE] Successfully saved ${finalData.length} total events to R2.`);
		}
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
				console.log('Rate limited. Waiting 10s...');
				retries--;
				await delay(10000);
				continue;
			}
			throw new Error(`API error ${response.status}`);
		}
	},

	extractEvents(html, intendedYear) {
		const $ = cheerio.load(html);
		const events = [];

		// Target rows in any table
		$('table tr').each((_, el) => {
			const cols = $(el).find('td');
			if (cols.length < 2) return;

			// Extract text, handling <p> tags and non-breaking spaces
			const rawDate = $(cols[0])
				.text()
				.replace(/\u00a0/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			const dates = this.parseDates(rawDate);

			// Validation: Skip if date invalid OR if BNM redirected us to a different year's page
			if (!dates || dates.start.getUTCFullYear() !== intendedYear) return;

			const titleCell = $(cols[1]);
			const badge = titleCell.find('.badge').text().trim();

			const titleClone = titleCell.clone();
			titleClone.find('.badge').remove();
			const title = titleClone.text().trim().replace(/\s+/g, ' ');

			const link = titleCell.find('a').attr('href');
			const contentUrl = link ? (link.startsWith('http') ? link : `https://www.bnm.gov.my${link}`) : null;

			events.push({
				year: intendedYear,
				title: title,
				date_str: rawDate,
				start_date: dates.start.getTime(),
				end_date: dates.end.getTime(),
				event_type: badge || null,
				content_url: contentUrl || null,
			});
		});

		return events;
	},

	parseDates(dateStr) {
		// Normalize: remove dots (Jan. -> Jan), collapse spaces
		const cleaned = dateStr.replace(/\*/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();

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

		// Range: "17-18 Feb 2026" or "17–18 Feb 2026" (handling different dash types)
		const range = cleaned.match(/^(\d+)[-–](\d+)\s+([A-Za-z]+)\s+(\d{4})$/);
		if (range) {
			const m = months[range[3].toLowerCase().substring(0, 3)];
			const y = parseInt(range[4]);
			if (m === undefined) return null;
			return {
				start: new Date(Date.UTC(y, m, parseInt(range[1]))),
				end: new Date(Date.UTC(y, m, parseInt(range[2]))),
			};
		}

		// Single: "01 Jan 2021" or "1 Jan 2026"
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
			// Logic: [Type] Title if Type exists, else just Title
			const summary = e.event_type ? `[${e.event_type}] ${e.title}` : e.title;

			const start = new Date(e.start_date)
				.toISOString()
				.replace(/-|:|\.\d+/g, '')
				.split('T')[0];
			const endObj = new Date(e.end_date);
			endObj.setUTCDate(endObj.getUTCDate() + 1); // ICS end date is exclusive
			const end = endObj
				.toISOString()
				.replace(/-|:|\.\d+/g, '')
				.split('T')[0];

			ics += 'BEGIN:VEVENT\r\n';
			ics += `SUMMARY:${summary}\r\n`;
			ics += `DTSTART;VALUE=DATE:${start}\r\n`;
			ics += `DTEND;VALUE=DATE:${end}\r\n`;
			ics += `DESCRIPTION:Date: ${e.date_str}${e.content_url ? '\\nURL: ' + e.content_url : ''}\r\n`;
			// Unique UID based on time and a slice of title
			ics += `UID:${e.start_date}-${e.title.substring(0, 15).replace(/[^a-zA-Z0-9]/g, '')}@bnm.gov.my\r\n`;
			ics += 'END:VEVENT\r\n';
		}
		ics += 'END:VCALENDAR';
		return ics;
	},
};
