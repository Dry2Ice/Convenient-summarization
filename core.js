/**
 * Pure, side-effect-free logic for the Enhanced Summary System.
 * Kept separate from index.js so it can be unit tested in isolation.
 */

export const SUMMARIZED_FLAG = 'es_summarized';
export const ORIGINAL_MES_KEY = 'es_original_mes';
/** Marks a message this extension excluded from the prompt, so only those are restored. */
export const HIDDEN_FLAG = 'es_prompt_hidden';
export const PLACEHOLDER = '[Absorbed into the story chronicle - hidden from the model.]';

const CHRONICLE_NOISE_RE = /^(here (is|are)|output|chronolog\w*|record|===|```|\[note|note:|sure|certainly|of course)/i;

/** Strip markdown emphasis so `**[Day 1 09:12]**` parses like a bare label. */
export function stripEmphasis(line) {
    return String(line).replace(/[*_`~>#|]/g, '').trim();
}

const REASONING_BLOCK_RE = /<(think|thinking|thought|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const REASONING_TAIL_RE = /<(?:think|thinking|thought|reasoning|scratchpad)\b[^>]*>[\s\S]*$/i;
const REASONING_CLOSE_RE = /<\/(?:think|thinking|thought|reasoning|scratchpad)\s*>/gi;

/**
 * Remove a reasoning block the model left in its answer.
 *
 * Several backends put the chain of thought inside the visible content instead
 * of a separate field, and some streams it unterminated when the output limit
 * cuts the reply short. Whatever survives has to go: a summary must not open
 * with a page of internal monologue, and none of it belongs in the archive.
 */
export function stripReasoning(text) {
    if (!text) return '';
    let out = String(text);
    out = out.replace(REASONING_BLOCK_RE, '');
    // An unterminated block means the reply was cut mid-thought, so everything
    // from the opening tag onwards is reasoning and there is no answer to keep.
    out = out.replace(REASONING_TAIL_RE, '');
    out = out.replace(REASONING_CLOSE_RE, '');
    return out.trim();
}

/** Roughly four characters per token. Good enough for budgeting, not billing. */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

/**
 * Parse the archivist output into timestamped lines.
 * A line only counts as parsed if it actually carries a timestamp, unless
 * allowUndated is set.
 */
export function parseChronicleBlock(text, { allowUndated = false } = {}) {
    if (!text) return { entries: [], datedCount: 0, totalNonEmpty: 0 };

    const entries = [];
    let datedCount = 0;
    let totalNonEmpty = 0;

    const lineRe = /^\s*[[(]?\s*(?:Day\s*(\d+)[^\])]*?(\d{1,2}:\d{2})|\d{4}-\d{2}-\d{2}[T\s]*(\d{1,2}:\d{2})?|(\d{1,2}:\d{2}))\s*[\])]?\s*(.*)$/;

    for (const raw of String(text).split('\n')) {
        const stripped = stripEmphasis(raw);
        const line = raw.trim();
        if (!line) continue;
        if (CHRONICLE_NOISE_RE.test(line)) continue;
        if (/^```/.test(line)) continue;

        totalNonEmpty++;

        // A bracketed label is taken verbatim whenever it looks like a stamp.
        // Real headers produce "July 12, 2025 1:15 PM", which no fixed pattern
        // would ever match.
        const bracket = stripped.match(/^\s*[[(]\s*([^)\]]{1,64}?)\s*[\])]\s*(.*)$/);
        if (bracket && isTimestampLabel(bracket[1])) {
            const body = bracket[2].trim();
            if (body) {
                datedCount++;
                entries.push({ ts: bracket[1].trim(), text: body });
                continue;
            }
        }

        const m = stripped.match(lineRe);
        if (!m) {
            if (allowUndated) entries.push({ ts: '', text: stripped });
            continue;
        }

        const day = m[1] ? `Day ${m[1]}` : '';
        const time = m[2] || m[3] || m[4] || '';
        const ts = [day, time].filter(Boolean).join(' ');
        const body = (m[5] || '').trim();
        if (!body) continue;

        datedCount++;
        entries.push({ ts, text: body });
    }

    return { entries, datedCount, totalNonEmpty };
}

/**
 * Read the archive back after a hand edit in the archive panel.
 *
 * The panel is plain text, one `[timestamp] line` per row, so a line that
 * carries a bracketed stamp is split into its two parts and anything else is
 * kept as an undated line rather than discarded. Order is preserved: the panel
 * is a record of what was written, not a proposal to re-sort.
 */
export function parseArchiveText(text) {
    const entries = [];
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        const m = line.match(/^\[\s*([^\]]{1,64}?)\s*\]\s*(.+)$/);
        if (m) {
            entries.push({ ts: m[1].trim(), text: m[2].trim() });
            continue;
        }
        entries.push({ ts: '', text: line });
    }
    return entries;
}

/**
 * Decide whether a chronicle response is trustworthy enough to commit.
 * Guards against the model refusing, rambling, or emitting prose without
 * timestamps — in any of those cases the watermark must not move.
 */
export function validateChronicleResponse({ entries, datedCount, totalNonEmpty }, expectedMessages) {
    const expected = Math.max(1, expectedMessages || 1);
    const problems = [];

    if (!entries.length) {
        return { ok: false, problems: ['no usable lines parsed'] };
    }
    if (!datedCount) {
        problems.push('no line carried a timestamp');
    }

    const datedRatio = datedCount / Math.max(1, totalNonEmpty);
    if (datedRatio < 0.5) {
        problems.push(`only ${Math.round(datedRatio * 100)}% of lines had timestamps`);
    }

    const coverage = entries.length / expected;
    if (coverage < 0.4) {
        problems.push(`only ${entries.length} lines for ${expected} messages (${Math.round(coverage * 100)}%)`);
    }
    if (coverage > 1.5) {
        problems.push(`${entries.length} lines for ${expected} messages — possible duplication`);
    }

    return { ok: problems.length === 0, problems };
}

/**
 * Index range that still needs archiving: everything after the watermark,
 * excluding the tail that stays raw. Returns the slice bounds.
 */
export function computeArchiveRange({ chatLength, watermark, keepLast }) {
    const lastEligible = chatLength - keepLast - 1;
    if (lastEligible < 0) return null;
    const start = Math.max(0, (watermark ?? -1) + 1);
    if (start > lastEligible) return null;
    return { start, end: lastEligible };
}

/** Split a list into fixed-size batches. */
export function chunk(list, size) {
    const n = Math.max(1, size | 0);
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
}

/**
 * Fit a list of {ts, text} lines into a token budget, keeping the most recent
 * lines and reporting how many were dropped. Oldest lines are dropped first.
 */
export function fitArchiveToBudget(lines, budgetTokens) {
    const list = Array.isArray(lines) ? lines : [];
    const budget = Math.max(0, budgetTokens);
    if (!list.length || !budget) return { lines: [], dropped: list.length, used: 0 };

    const reversed = list.slice().reverse();
    const kept = [];
    let used = 0;
    let dropped = 0;

    for (const entry of reversed) {
        const cost = estimateTokens((entry.ts ? `[${entry.ts}] ` : '') + entry.text);
        if (used + cost > budget) {
            dropped = list.length - kept.length;
            break;
        }
        used += cost;
        kept.push(entry);
    }

    kept.reverse();
    return { lines: kept, dropped, used };
}

/**
 * Select the archive lines most worth including in a structured summary.
 * Scores by overlap with recent text, favours recency, and always keeps the
 * newest lines so the live edge of the story is never starved.
 */
export function selectRelevantArchive(lines, recentText, { budgetTokens, headroom = 0.6 } = {}) {
    const list = Array.isArray(lines) ? lines : [];
    if (!list.length) return { lines: [], dropped: 0, used: 0 };

    const budget = Math.max(0, budgetTokens) * Math.max(0.1, Math.min(1, headroom));
    if (!budget) return { lines: [], dropped: list.length, used: 0 };

    // Every word the model used in its own prompt is evidence of what it cares
    // about right now, so the first tokens are kept as well as the long ones.
    const words = String(recentText || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_']+/u)
        .filter(Boolean);
    const terms = new Set(words.filter(t => t.length > 2));

    const scored = list.map((entry, i) => {
        const hay = `${entry.ts} ${entry.text}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (hay.includes(term)) score += term.length > 6 ? 2 : 1;
        }
        // Relevance dominates recency: a line the model just talked about is
        // worth more than a merely recent one. Recency only breaks ties.
        const recency = (i / Math.max(1, list.length - 1)) * 6;
        return { entry, i, score: score * 10 + recency };
    });

    // Always retain the newest tail, then fill the remaining budget by score.
    // The tail is capped by the budget too, so a huge or verbose tail can never
    // starve out the high-scoring older lines.
    const tailCount = Math.max(1, Math.floor(list.length * 0.25));
    const chosen = new Set();
    let used = 0;
    let tailUsed = 0;
    const tailCap = budget * 0.4;

    for (let i = list.length - tailCount; i < list.length; i++) {
        const cost = estimateTokens(list[i].text);
        if (tailUsed + cost > tailCap) break;
        tailUsed += cost;
        chosen.add(i);
        used += cost;
    }

    const candidates = scored
        .filter(s => !chosen.has(s.i))
        .sort((a, b) => b.score - a.score);

    for (const c of candidates) {
        const cost = estimateTokens(c.entry.text);
        if (used + cost > budget) continue;
        chosen.add(c.i);
        used += cost;
    }

    const kept = [...chosen].sort((a, b) => a - b).map(i => list[i]);
    return { lines: kept, dropped: list.length - kept.length, used };
}

/**
 * Parse `LOREBOOK_ENTRY|name|type|keywords|content` lines.
 * Returns entries and a count of how many lines were rejected.
 */
export function parseLorebookResponse(text) {
    const out = { entries: [], rejected: 0 };
    if (!text) return out;

    const validTypes = new Set(['character', 'event', 'location', 'faction', 'item', 'concept']);

    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('LOREBOOK_ENTRY')) continue;

        const parts = line.split('|');
        if (parts.length < 5) {
            out.rejected++;
            continue;
        }

        const [, name, type, keywords, ...rest] = parts;
        const content = rest.join('|').trim();
        const cleanType = String(type || '').trim().toLowerCase();

        if (!name?.trim() || !content || !validTypes.has(cleanType)) {
            out.rejected++;
            continue;
        }

        out.entries.push({
            name: name.trim(),
            type: cleanType,
            keywords: String(keywords || '')
                .split(',')
                .map(k => k.trim().toLowerCase())
                .filter(Boolean),
            content,
        });
    }

    return out;
}

/** Stable key for a lorebook entry so updates supersede rather than duplicate. */
export function lorebookKey(name) {
    return String(name).trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Apply parsed lorebook entries onto an existing map, superseding by key.
 * Returns the next map and how many entries were new.
 */
export function mergeLorebook(existing, parsed, timestamp) {
    const next = { ...(existing || {}) };
    let added = 0;

    for (const entry of parsed) {
        const key = lorebookKey(entry.name);
        if (!next[key]) added++;
        next[key] = {
            name: entry.name,
            type: entry.type,
            keywords: entry.keywords,
            content: entry.content,
            createdAt: next[key]?.createdAt || timestamp,
            updatedAt: timestamp,
        };
    }

    return { next, added };
}

/** Decide whether the lorebook watermark for a batch may advance. */
export function shouldAdvanceLorebook({ parsedCount, rejected, hadResponse }) {
    if (!hadResponse) return false;
    if (parsedCount === 0) return false;
    return true;
}

/**
 * Work out which messages have to be excluded from the prompt.
 *
 * SillyTavern's own "Exclude message from prompts" button sets `is_system`,
 * and its prompt assembly drops every `is_system` message, so that flag is used
 * directly here instead of rewriting the message text. The message stays fully
 * readable in the chat and can be un-hidden by hand like any other.
 *
 * Only a message this extension hid is ever un-hidden again, so one the user
 * excluded by hand keeps its state.
 *
 * `keepLast` is the raw tail the user asked to stay readable. It wins over the
 * archive: raising the number has to bring those messages back into the prompt
 * immediately, and it does not un-archive them either — as soon as newer
 * messages push them out of the tail they are excluded again, since the flag
 * that says they were absorbed is still on them.
 */
export function planPromptExclusion(chat, { mark = -1, enabled = true, keepLast = 0 } = {}) {
    const hide = [];
    const show = [];
    const list = Array.isArray(chat) ? chat : [];
    const tailStart = list.length - 1 - Math.max(0, keepLast | 0);

    for (let i = 0; i < list.length; i++) {
        const msg = list[i];
        if (!msg) continue;

        if (i > tailStart) {
            if (msg.is_system && msg[HIDDEN_FLAG]) show.push(i);
            continue;
        }

        // The watermark is the source of truth: a message inside the archived
        // range must be excluded even when the chat file lost its flag.
        const absorbed = Boolean(msg[SUMMARIZED_FLAG]) || (i <= mark && !msg.is_system);
        const wanted = Boolean(enabled && absorbed);

        if (wanted) {
            // Already excluded is still listed when the ownership is not
            // recorded, which happens when the message was excluded by hand
            // before it was archived.
            if (!msg.is_system || !msg[HIDDEN_FLAG]) hide.push(i);
        } else if (msg.is_system && msg[HIDDEN_FLAG]) {
            show.push(i);
        }
    }

    return { hide, show };
}

/**
 * The text a message should carry.
 *
 * Older builds replaced the text of an absorbed message with a placeholder and
 * kept the original in a side field. The original is restored only while the
 * text is still that placeholder: once the message was edited the stored copy
 * is stale, and the newer text is the one the user wrote.
 */
export function repairedText(msg) {
    if (!msg) return '';
    if (msg[ORIGINAL_MES_KEY] === undefined) return msg.mes ?? '';
    return String(msg.mes ?? '').trim() === PLACEHOLDER ? msg[ORIGINAL_MES_KEY] : msg.mes;
}

/**
 * Read the assistant text out of whatever the backend answered with.
 *
 * SillyTavern rewrites most sources back into the OpenAI shape, but several pass
 * the provider's own JSON through untouched: Cohere answers with message.content
 * as an array of blocks, Mistral and AI21 with their own envelopes, and a custom
 * endpoint that is not OpenAI-compatible with something else again. Assuming one
 * shape is how a perfectly working model gets reported as "returned an empty
 * response" and then retried until the run gives up.
 */
export function extractCompletionText(data) {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;

    // OpenAI, and everything SillyTavern wraps into that shape.
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
        if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
        const message = choice.message || choice.delta || {};
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) return joinBlocks(message.content);
    }

    // Anthropic, and any endpoint that answers with content blocks.
    if (Array.isArray(data.content)) return joinBlocks(data.content);
    if (typeof data.message?.content === 'string') return data.message.content;
    if (Array.isArray(data.message?.content)) return joinBlocks(data.message.content);

    // Cohere and the legacy completion APIs.
    if (typeof data.text === 'string') return data.text;
    const legacy = Array.isArray(data.generations) ? data.generations[0] : null;
    if (typeof legacy?.text === 'string') return legacy.text;

    // Google, which splits the answer over parts and flags thinking parts.
    const parts = data.candidates?.[0]?.content?.parts ?? data.candidates?.[0]?.output?.parts;
    if (Array.isArray(parts)) {
        const text = parts
            .filter(part => part && !part.thought && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n\n');
        if (text) return text;
    }

    // Ollama and the OpenAI Responses API.
    if (typeof data.response === 'string') return data.response;
    if (typeof data.output_text === 'string') return data.output_text;

    return '';
}

function joinBlocks(blocks) {
    return (blocks || [])
        .map(block => {
            if (typeof block === 'string') return block;
            return typeof block?.text === 'string' ? block.text : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

/** An error the backend reported inside an otherwise successful response. */
export function completionErrorText(data) {
    const error = data?.error;
    if (!error) return '';
    if (typeof error === 'string') return error.slice(0, 300);
    return String(error.message || error.msg || error.detail || '').slice(0, 300);
}

/** The chain of thought a provider returned separately from the answer. */
export function reasoningText(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const separate = choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content ?? data?.reasoning_content;
    if (typeof separate === 'string') return separate;
    if (Array.isArray(separate)) {
        return separate.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    return '';
}

/**
 * Explain an answer that turned out to be empty, instead of leaving "empty
 * response" on screen with no idea which of the four causes it actually was.
 */
export function describeEmptyAnswer({ error = '', reasoning = '', finishReason = '', parsed = true, contentType = '' } = {}) {
    if (error) return `the backend answered with an error: ${error}`;
    if (reasoning) {
        return 'the model spent the whole answer budget on reasoning and returned no answer — raise "max output tokens", or archive with a model that does not think out loud';
    }
    if (finishReason === 'length') {
        return 'the answer was cut off by the output limit before it held anything usable — raise "max output tokens"';
    }
    if (!parsed) {
        return `the backend answered with ${contentType || 'something that is not JSON'} instead of JSON`;
    }
    if (finishReason) return `the model returned an empty answer (finish_reason: ${finishReason})`;
    return 'the model returned an empty answer';
}

/** Mark the messages of one batch as absorbed, without touching other flags. */
export function markAbsorbed(chat, from, to) {
    return chat.map((msg, i) => {
        if (i < from || i > to) return msg;
        if (!msg || msg.is_system || msg[SUMMARIZED_FLAG]) return msg;
        return { ...msg, [SUMMARIZED_FLAG]: true };
    });
}

/**
 * Re-derive the watermark from the flags the messages themselves carry.
 *
 * The watermark is a chat index, so anything that removes a message moves it
 * onto a different one. SillyTavern reports a deletion as the new chat length
 * rather than the index it removed, so the position cannot be recovered from
 * the event; the flags can be read instead, because they travel with their
 * message.
 *
 * Two situations need different answers:
 *
 * - Unarchived messages *after* an archived one: the chat shifted underneath
 *   the watermark. The record stays, and the watermark follows the flags back,
 *   so the message that took the vacated place is archived properly instead of
 *   being quietly declared archived and lost.
 * - Unarchived messages *before* any archived one, in a chat that has not lost
 *   messages: the chat file was saved before the flags reached it. The archive
 *   already covers them, so they are re-flagged rather than archived twice.
 *
 * `chatChanged` tells the two apart: it is set when the chat is shorter than it
 * was the last time this ran, which only a deletion can do, and the deletion may
 * equally well have removed the tail of the archived region. Without it, the
 * second case would flag messages the archive never covered.
 *
 * A watermark past the end of the chat is a leftover from deleted messages and
 * is clamped, because an out-of-range watermark would stall the archive for
 * good: every new message would already be "archived".
 */
export function reconcileWatermark(chat, mark, { chatChanged = false } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    if (typeof mark !== 'number' || mark < 0) return { watermark: -1, repaired: 0 };
    if (!list.length) return { watermark: -1, repaired: 0 };

    const limit = Math.min(mark, list.length - 1);

    let firstGap = -1;
    let lastFlagged = -1;
    let unflagged = 0;
    let gapFollowedByArchive = false;

    for (let i = 0; i <= limit; i++) {
        const msg = list[i];
        if (!msg || msg.is_system) continue;

        if (msg[SUMMARIZED_FLAG]) {
            lastFlagged = i;
            if (firstGap >= 0) gapFollowedByArchive = true;
        } else {
            unflagged++;
            if (firstGap < 0) firstGap = i;
        }
    }

    if (firstGap < 0) {
        // Nothing is missing inside the range; only a chat that got shorter can
        // still leave the watermark pointing past its end.
        return { watermark: Math.min(mark, list.length - 1), repaired: 0 };
    }
    if (chatChanged || gapFollowedByArchive) {
        return { watermark: lastFlagged, repaired: 0 };
    }
    return { watermark: mark, repaired: unflagged };
}

/**
 * Truncate long messages for a budgeted prompt. Keeps the head, marks the cut
 * so the model knows material was elided, and never returns an empty body.
 */
export function truncateForPrompt(text, maxChars) {
    const src = String(text ?? '');
    const max = Math.max(64, maxChars | 0);
    if (src.length <= max) return { text: src, truncated: false };

    // The marker must always fit inside the budget, otherwise the reported
    // length would exceed the very limit it is meant to respect.
    let marker = `… [+${src.length} chars]`;
    let head = src.slice(0, Math.max(0, max - marker.length));
    if (head.length === 0) {
        // No room for a body: emit the marker alone rather than overshooting.
        return { text: marker.slice(0, max), truncated: true };
    }
    if (head.length + marker.length > max) {
        marker = '…';
        head = src.slice(0, max - 1);
    }
    return { text: `${head}${marker}`, truncated: true };
}

/** Format messages for a prompt, capping each one so one long reply cannot dominate. */
export function formatMessages(messages, { maxChars = 1200 } = {}) {
    return (messages || [])
        .filter(Boolean)
        .map((m, i) => {
            const role = m.is_user ? 'User' : (m.is_system ? 'System' : 'Assistant');
            const name = m.name || role;
            const { text } = truncateForPrompt(m.mes, maxChars);
            return `[${i}] ${name}: ${text}`;
        })
        .join('\n\n');
}

/** A per-message budget, so a long total is spread evenly instead of truncating one. */
export function perMessageCharLimit(totalBudgetChars, count, { floor = 200, ceil = 4000 } = {}) {
    if (count <= 0) return ceil;
    return Math.max(floor, Math.min(ceil, Math.floor(totalBudgetChars / count)));
}

const TIME_RE = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
const DAY_LABEL_RE = /\bday\s*\d+\b/i;
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;

/**
 * A label counts as a timestamp when it carries a clock time, a day number or a
 * real calendar date. Real roleplay headers produce things like
 * "July 12, 2025 1:15 PM", so the parser must not insist on a rigid pattern.
 */
export function isTimestampLabel(text) {
    if (!text) return false;
    const s = String(text);
    if (TIME_RE.test(s)) return true;
    if (DAY_LABEL_RE.test(s)) return true;
    if (MONTH_RE.test(s) && YEAR_RE.test(s)) return true;
    return YEAR_RE.test(s);
}

/** Parse a timestamp label into a sortable value. Unparseable labels sort last. */
export function timestampValue(ts) {
    if (!ts) return Infinity;
    const s = String(ts);

    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const monthMatch = s.match(MONTH_RE);
    const dayMatch = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b(?=[,\s])/);
    const yearMatch = s.match(YEAR_RE);
    const timeMatch = s.match(TIME_RE);
    const dayLabel = s.match(DAY_LABEL_RE);

    const hasCalendar = Boolean(monthMatch || yearMatch);
    if (!hasCalendar && !dayLabel && !timeMatch) return Infinity;

    let month = 0;
    if (monthMatch) month = months[monthMatch[1].slice(0, 3).toLowerCase()] ?? 0;

    const day = dayMatch ? Number(dayMatch[1]) : (dayLabel ? Number(dayLabel[0].replace(/\D/g, '')) : 1);
    const year = yearMatch ? Number(yearMatch[0]) : 2000;

    let hours = 0;
    let minutes = 0;
    if (timeMatch) {
        hours = Number(timeMatch[1]);
        minutes = Number(timeMatch[2]);
        if (/pm/i.test(timeMatch[3] || '') && hours < 12) hours += 12;
        if (/am/i.test(timeMatch[3] || '') && hours === 12) hours = 0;
    }

    return year * 31536000 + month * 2592000 + day * 86400 + hours * 3600 + minutes * 60;
}

/**
 * Order archive lines by their timestamp while keeping unparseable lines in
 * place relative to their neighbours — a model that restarts its day counter
 * must not silently reshuffle everything before it.
 */
export function sortArchiveLines(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const withKey = list.map((entry, i) => ({ entry, i, key: timestampValue(entry.ts) }));
    const runnable = withKey.every(w => Number.isFinite(w.key));
    if (!runnable) return list;

    return withKey
        .slice()
        .sort((a, b) => (a.key - b.key) || (a.i - b.i))
        .map(w => w.entry);
}

/** Keep the N most recently touched chat states and drop the rest. */
export function pruneChatStates(states, limit) {
    const map = (states && typeof states === 'object') ? states : {};
    const keys = Object.keys(map);
    const max = Math.max(1, limit | 0);
    if (keys.length <= max) return { next: map, dropped: 0 };

    const sorted = keys
        .map(k => ({ key: k, touched: map[k]?.touchedAt ?? 0 }))
        .sort((a, b) => b.touched - a.touched);

    const keep = sorted.slice(0, max).map(e => e.key);
    const next = {};
    for (const k of keep) next[k] = map[k];
    return { next, dropped: keys.length - keep.length };
}

/** A stable per-chat key. Group chats reuse bare indexes, so the type is mixed in. */
export function chatStateKey(chatId, chatType) {
    if (chatId === undefined || chatId === null || chatId === '') return null;
    const type = chatType ? String(chatType) : 'solo';
    return `${type}:${chatId}`;
}

/**
 * Read a leading `Key: value` metadata header, which roleplay templates commonly
 * place at the top of every message (Date / Time / Location / Weather ...).
 * Returns the parsed fields plus the body with the header removed, so prompts
 * spend tokens on prose instead of on repeated boilerplate.
 */
export function parseMessageHeader(text) {
    const src = String(text ?? '');
    const lines = src.split('\n');
    const meta = {};
    let consumed = 0;

    for (const raw of lines) {
        if (consumed >= 12) break;
        const line = raw.trim();
        if (!line) {
            // A blank line ends the header, but only after something was found.
            if (consumed > 0) { consumed++; break; }
            continue;
        }
        const m = line.match(/^([A-Za-z][A-Za-z \/]{1,24}?)\s*:\s*(.+)$/);
        if (!m) {
            if (consumed === 0) return { found: false, meta: {}, body: src };
            break;
        }
        const key = m[1].trim().toLowerCase();
        const value = m[2].trim();
        if (!value) {
            if (consumed === 0) return { found: false, meta: {}, body: src };
            break;
        }

        if (key.includes('date')) meta.date = value;
        else if (key.includes('time')) meta.time = value;
        else if (key.includes('day of') || key === 'day') meta.weekday = value;
        else if (key.includes('location') || key === 'setting' || key === 'place') meta.location = value;
        else if (key.includes('weather') || key.includes('sky')) meta.weather = value;
        else if (key.includes('character') || key.includes('present')) meta.characters = value;
        else meta[key] = value;

        consumed++;
    }

    const hasUseful = Boolean(meta.date || meta.time || meta.location);
    if (consumed === 0 || !hasUseful) {
        return { found: false, meta: {}, body: src };
    }

    return { found: true, meta, body: lines.slice(consumed).join('\n').replace(/^\n+/, '') };
}

/** Human-readable stamp from a parsed header, e.g. "July 13, 2025 8:31 AM". */
export function metaStamp(meta) {
    if (!meta) return '';
    return [meta.date, meta.time].filter(Boolean).join(' ');
}

/** True when most messages carry a usable header, so stripping is safe. */
export function shouldDetectHeaders(messages) {
    const list = (messages || []).filter(m => m && !m.is_system);
    if (list.length < 4) return false;
    const withHeader = list.filter(m => parseMessageHeader(m.mes).found).length;
    return withHeader / list.length >= 0.5;
}

/**
 * Format messages for the archivist, handing it the real date, time and place
 * from each header instead of leaving it to invent them.
 */
export function formatMessagesForArchive(messages, { maxChars = 1200, useHeaders = true } = {}) {
    return (messages || [])
        .filter(m => m && !m.is_system)
        .map((m, i) => {
            const role = m.is_user ? 'User' : 'Assistant';
            const name = m.name ? ` (${m.name})` : '';
            const parsed = useHeaders ? parseMessageHeader(m.mes) : { found: false, meta: {}, body: m.mes };
            const { text } = truncateForPrompt(parsed.body, maxChars);

            const bits = [];
            const stamp = metaStamp(parsed.meta);
            if (stamp) bits.push(stamp);
            if (parsed.meta.location) bits.push(parsed.meta.location);
            const head = bits.length ? `#${i} | ${bits.join(' | ')}` : `#${i}`;

            return `${head}\n${role}${name}: ${text}`;
        })
        .join('\n\n');
}

/** Remove headers from a batch of messages without otherwise altering them. */
export function stripHeaders(messages) {
    return (messages || []).map(m => {
        if (!m || m.is_system) return m;
        const parsed = parseMessageHeader(m.mes);
        return parsed.found ? { ...m, mes: parsed.body } : m;
    });
}


/**
 * Detect a refusal in place of the requested output.
 *
 * The verb after "I cannot" matters: "I cannot help with that" is a refusal,
 * while "I cannot recall the exact wording" is a perfectly good record. Only
 * task-refusal verbs are matched, and only at the very start of the response.
 */
const REFUSAL_VERBS = 'help|do|assist|comply|provide|write|create|generate|produce|process|fulfil|fulfill|continue|engage|share';

export function looksLikeRefusal(text) {
    if (!text) return false;
    const head = String(text).trim().slice(0, 300).toLowerCase();

    if (/^(извин|sorry|к сожалению|я не могу|я не смогу|не могу выполнить|as an ai|я как ии)/i.test(head)) return true;
    if (/^i(?:'?m| am)?\s?unable|^unable to|^i apologi/i.test(head)) return true;
    if (/^i'?m sorry\b|^i'?m afraid/i.test(head)) return true;

    // The verb list must be grouped: `^i cannot\s+a|b` would anchor only the
    // first branch and then match the bare word "b" anywhere in the text.
    if (new RegExp(`^i cannot\\s+(?:${REFUSAL_VERBS})\\b`, 'i').test(head)) return true;
    if (new RegExp(`^i can'?t\\s+(?:${REFUSAL_VERBS})\\b`, 'i').test(head)) return true;

    return false;
}

/** Format a token count compactly for the status panel. */
export function formatTokens(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
    if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1) + 'k';
    return String(Math.round(v));
}

/**
 * Token accounting: what the absorbed history used to cost, what the model
 * receives now, and the difference. Pure so it can be verified directly.
 */
export function computeTokenStats({ absorbedCount = 0, absorbedTokens = 0, liveTokens = 0, archiveTokens = 0, summaryTokens = 0, lorebookTokens = 0, budgetTokens = 0 } = {}) {
    const injectedTokens = archiveTokens + summaryTokens + lorebookTokens;
    const effectiveTokens = liveTokens + injectedTokens;
    const beforeTokens = absorbedTokens + liveTokens;
    const savedTokens = beforeTokens - effectiveTokens;

    return {
        absorbedCount,
        absorbedTokens,
        liveTokens,
        archiveTokens,
        summaryTokens,
        lorebookTokens,
        injectedTokens,
        beforeTokens,
        effectiveTokens,
        savedTokens,
        ratio: beforeTokens > 0 ? effectiveTokens / beforeTokens : 1,
        budgetShare: budgetTokens > 0 ? injectedTokens / budgetTokens : 0,
        // Worth saying out loud: compression that costs more than it saves is a bug.
        isExpansion: effectiveTokens > beforeTokens,
    };
}

/** Count core memories so a revision that silently drops them can be spotted. */
export function countCoreMemories(summary) {
    if (!summary) return 0;
    return (String(summary).match(/^\s*[-*]?\s*Core Memory\s*:/gim) || []).length;
}

/** Count exchanges (a user turn plus the assistant turn answering it). */
export function countExchanges(messages) {
    const list = (messages || []).filter(m => m && !m.is_system);
    if (!list.length) return 0;
    let count = 0;
    for (const m of list) {
        if (m.is_user) count++;
    }
    // A leading assistant turn still counts as part of the first exchange.
    return Math.max(1, count || Math.ceil(list.length / 2));
}
