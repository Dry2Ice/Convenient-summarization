/**
 * Pure, side-effect-free logic for the Enhanced Summary System.
 * Kept separate from index.js so it can be unit tested in isolation.
 */

export const SUMMARIZED_FLAG = 'es_summarized';
export const ORIGINAL_MES_KEY = 'es_original_mes';
/** Marks a message this extension excluded from the prompt, so only those are restored. */
export const HIDDEN_FLAG = 'es_prompt_hidden';
export const PLACEHOLDER = '[Absorbed into the story chronicle - hidden from the model.]';

/** Strip markdown emphasis so `**[Day 1 09:12]**` parses like a bare label. */
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
 * Split the record into blocks.
 *
 * The record is a document the model writes, grouped by the time spans it chooses,
 * so the block headings it uses are honoured. Anything it wrote without a heading
 * is cut into windows of roughly the same size, because the lorebook pass still
 * has to walk the whole thing in small requests.
 */
export function recordBlocks(record, { targetChars = 1800 } = {}) {
    const text = String(record ?? '').trim();
    if (!text) return [];

    const chunks = [];
    const lines = text.split('\n');
    let current = [];

    const flush = () => {
        const joined = current.join('\n').trim();
        if (joined) chunks.push(joined);
        current = [];
    };

    for (const line of lines) {
        // A heading starts a new block: it is what the model used to group by.
        if (/^#{1,3}\s/.test(line) && current.some(l => l.trim())) flush();
        current.push(line);

        // An unheaded block still has to stay small enough for one request.
        if (current.join('\n').length >= targetChars && !/^#{1,3}\s/.test(line.trim())) {
            // Only cut on a blank line, so a sentence is never split in half.
            if (line.trim() === '') flush();
        }
    }
    flush();

    if (!chunks.length && text) return [text];
    return chunks;
}

/**
 * Add newly written blocks to the record.
 *
 * Returns the joined document and whether the addition looks like a copy of what
 * is already there: models asked for "just the new part" occasionally answer with
 * the whole document instead, and silently appending that duplicates the history.
 */
export function appendRecord(record, addition) {
    const before = String(record ?? '').trim();
    const extra = String(addition ?? '').trim();
    if (!extra) return { record: before, duplicated: false, added: 0 };
    if (!before) return { record: extra, duplicated: false, added: 1 };

    // Models asked for "just the new part" occasionally answer with the whole
    // document instead, and appending that silently duplicates history. It is
    // caught by comparing against the last block already stored: a re-send repeats
    // it almost word for word, while a genuine continuation shares only names and
    // places.
    const blocks = recordBlocks(before);
    const tail = (blocks[blocks.length - 1] || '').toLowerCase();
    const tailWords = new Set(tail.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3));
    const haystack = extra.toLowerCase();
    let hits = 0;
    for (const word of tailWords) {
        if (haystack.includes(word)) hits++;
    }
    const duplicated = tailWords.size >= 5 && hits / tailWords.size >= 0.7;

    return {
        record: `${before}\n\n${extra}`,
        duplicated,
        added: recordBlocks(extra).length || 1,
    };
}

/** What the status panel needs to say about the record. */
export function recordStats(record) {
    const text = String(record ?? '').trim();
    const blocks = recordBlocks(text);
    return {
        blocks: blocks.length,
        words: text ? text.split(/\s+/).length : 0,
        tokens: estimateTokens(text),
    };
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
 * Read the answer out of a streamed response, whatever shape its frames are in.
 *
 * With streaming on, SillyTavern pipes the provider's own server-sent events
 * straight through, so every `data:` frame is one object of that provider's
 * shape: an OpenAI delta, an Anthropic text delta, a Google part, a Cohere text
 * field. Running each frame through the same extractor and concatenating the
 * pieces handles all of them without a parser per provider.
 *
 * A body that turns out not to be a stream at all is read as one object, so a
 * backend that ignores `stream: true` keeps working unchanged.
 */
export function extractStreamText(raw) {
    const body = String(raw ?? '');
    const empty = { text: '', reasoning: '', frames: 0, error: '', streamed: false };
    if (!body.trim()) return empty;

    if (!/^\s*(data:|event:|id:|retry:)/m.test(body)) {
        let data;
        try {
            data = JSON.parse(body);
        } catch {
            return empty;
        }
        return {
            text: extractCompletionText(data),
            reasoning: reasoningText(data),
            frames: 1,
            error: completionErrorText(data),
            streamed: false,
        };
    }

    let text = '';
    let reasoning = '';
    let frames = 0;
    let error = '';

    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice('data:'.length).trim();
        // The terminator frame carries no content.
        if (!payload || payload === '[DONE]') continue;

        let data;
        try {
            data = JSON.parse(payload);
        } catch {
            continue;
        }

        frames++;
        if (!error) error = completionErrorText(data);
        reasoning += reasoningText(data);
        text += extractCompletionText(data);
    }

    return { text, reasoning, frames, error, streamed: true };
}

/**
 * Split the two variable blocks of the summary request into what is actually
 * left of the context window.
 *
 * The scaffolding is not free: the guardrail, the framing and the structural
 * template run to several thousand tokens, and the summary request is the single
 * largest one the extension makes. Budgeting the archive and the live edge as if
 * that scaffolding were free is how the request silently outgrows the window —
 * the backend then answers with an error, which reads as an empty response and
 * happens again on every retry, with every model, because the cause is the size
 * of the request and not the model.
 *
 * With no window to go by there is nothing to scale against, so the configured
 * amounts stand and the caller is told the request is uncapped.
 */
export function fitStage2Budgets({
    window = 0,
    share = 0.3,
    overheadTokens = 0,
    archiveTokens = 0,
    recentTokens = 0,
    reserve = 2000,
    outputTokens = 0,
} = {}) {
    const archive = Math.max(0, archiveTokens);
    const recent = Math.max(0, recentTokens);
    const requested = archive + recent;
    // The room an answer needs is taken off before the material is sized. Asking
    // for 64k of output on a request of 80k is a request the backend cannot
    // honour whatever the material says, and it fails in a way that looks like
    // the model misbehaving.
    const output = Math.max(0, Math.floor(Number(outputTokens) || 0));

    const known = Number.isFinite(window) && window > 0;
    if (!known) {
        return { archive, recent, requested, usable: Infinity, capped: false, cappedBy: null, output };
    }

    const ratio = Math.max(0.05, Math.min(0.9, Number(share) || 0.3));
    let usable = Math.floor(window * ratio) - Math.max(0, reserve) - Math.max(0, overheadTokens) - output;

    // The summary request genuinely needs a large share of a small window, so a
    // third of it being too small for the instructions is not a reason to give
    // up: the share is raised before the request is abandoned.
    let cappedBy = 'window';
    if (usable <= 0) {
        usable = Math.floor(window * 0.9) - Math.max(0, reserve) - Math.max(0, overheadTokens);
        cappedBy = 'share';
    }

    // Nothing at all fits: better an honest zero than a request that cannot.
    if (usable <= 0) return { archive: 0, recent: 0, requested, usable: 0, capped: true, cappedBy: 'overhead', output };

    if (requested <= usable) {
        return { archive, recent, requested, usable, capped: cappedBy === 'share', cappedBy: cappedBy === 'share' ? 'share' : null, output };
    }

    // The live edge is what the summary must reflect, so it keeps its configured
    // share of what is left rather than being cut first.
    const recentShare = requested > 0 ? recent / requested : 0;
    const recentKept = Math.min(recent, Math.floor(usable * Math.min(0.6, Math.max(0.2, recentShare))));
    const archiveKept = Math.max(0, usable - recentKept);

    return {
        archive: archiveKept,
        recent: Math.min(recent, recentKept),
        requested,
        usable,
        capped: true,
        cappedBy,
        output,
    };
}

/**
 * A revision this much shorter than the summary it replaces is not a better
 * summary, it is a truncated or refused one. Storing it would silently throw
 * away everything the archive was built to preserve.
 */
export function looksTruncatedRevision(previous, next, { floor = 0.35, minimumTokens = 40 } = {}) {
    const before = String(previous || '').trim();
    const after = String(next || '').trim();
    if (!before) return false;
    if (estimateTokens(after) >= minimumTokens && after.length >= before.length * floor) return false;
    return true;
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

    // One Anthropic streaming frame: the text arrives as a delta of a block.
    if (typeof data.delta?.text === 'string') return data.delta.text;

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

/**
 * The chain of thought a provider returned separately from the answer.
 *
 * Every field the various providers use is read, not just the one ST happens to
 * normalise. A gateway that returns reasoning under its own name would otherwise
 * be invisible here, and a response with reasoning in an unread field is
 * indistinguishable from one with no answer at all.
 */
export function reasoningText(data) {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const fromChoice = choice
        ? (choice.message ?? choice.delta ?? choice)
        : null;

    const parts = [];
    const collect = (value) => {
        if (typeof value === 'string' && value) parts.push(value);
        else if (Array.isArray(value)) {
            for (const part of value) {
                if (typeof part === 'string') parts.push(part);
                else if (part && typeof part.text === 'string') parts.push(part.text);
            }
        }
    };

    collect(fromChoice?.reasoning_content);
    collect(fromChoice?.reasoning);
    collect(fromChoice?.thinking);
    collect(fromChoice?.thinking_content);
    collect(data.reasoning_content);
    collect(data.reasoning);
    collect(data.thinking);
    collect(data.thinking_content);

    // Google marks its thinking parts rather than naming a field for them.
    const googleParts = data.candidates?.[0]?.content?.parts ?? data.candidates?.[0]?.output?.parts;
    if (Array.isArray(googleParts)) {
        for (const part of googleParts) {
            if (part && part.thought && typeof part.text === 'string') parts.push(part.text);
        }
    }

    return parts.join('');
}

/** The shape a response arrived in, so a missed field is visible in the log. */
export function responseShape(data) {
    if (data === null || data === undefined) return 'nothing';
    if (typeof data === 'string') return 'a bare string';
    const top = Object.keys(data).filter(k => !['id', 'object', 'created', 'model', 'usage', 'system_fingerprint'].includes(k));
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const inner = choice ? Object.keys(choice.message ?? choice.delta ?? choice) : [];
    const parts = [
        top.length ? top.join(', ') : '(no fields)',
        inner.length ? `choice: ${inner.join(', ')}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
}

/**
 * Why a body that arrived successfully carried no usable answer.
 *
 * A backend error inside a 200 response is the case worth explaining: the
 * provider accepted the request and then failed to serve it, and its own wording
 * ("Request error", "upstream timeout") says nothing about what to do next. It
 * gets classified here so the status line can say whether to wait, shrink the
 * request, change endpoint, or stop trying.
 */
export function describeEmptyAnswer({ error = '', reasoning = '', reasoningTokens = 0, fields = '', finishReason = '', parsed = true, contentType = '' } = {}) {
    if (error) {
        const said = String(error).slice(0, 200);
        if (/content[_ -]?filter|safety|policy|blocked by|prohibited|nsfw|illegal/i.test(said)) {
            return `the backend refused this material (${said}) — its filter stopped the request before any text came back. That backend will not archive this chat; point summarization at another endpoint.`;
        }
        if (/unavailable|overload|busy|capacity|temporar|try again|upstream|no available|exhaust|queue/i.test(said)) {
            return `the backend was temporarily unable to serve the request (${said}). Nothing is wrong with the request — the same one usually works on a later attempt, or from a different endpoint.`;
        }
        if (/too large|too long|token|limit exceeded|context|payload|request size|413|400/i.test(said)) {
            return `the backend rejected the request as too large (${said}). Lower the recent-answer or record budget, or lower the output limit.`;
        }
        if (/unauthor|forbidden|api key|401|403|invalid.*key|quota|credit|balance/i.test(said)) {
            return `the backend refused the request itself (${said}). This is a connection or key problem, not a prompt problem.`;
        }
        return `the backend answered with an error and no text (${said}). It refused the request before generating — retrying usually helps when the connection is a free or relayed one.`;
    }
    if (reasoning) {
        // What is known: reasoning came back and no answer came back. What was
        // not known, and was previously claimed anyway: that the reasoning used up
        // the output budget. A measured figure is put in its place, and the shape
        // of the response is quoted so an answer hiding in an unread field shows
        // up as a field rather than as a mystery.
        const volume = reasoningTokens > 0 ? ` ~${reasoningTokens} tokens of it` : '';
        const shape = fields ? ` The response carried: ${fields}.` : '';
        return `the model returned reasoning${volume} and no answer at all.`
            + (reasoningTokens > 0
                ? ' Whether that filled the output budget or not is not knowable from here — compare it with the output limit in the log.'
                : '')
            + shape
            + ' If the figure is far below the output limit, the answer arrived somewhere this extension does not read yet, and the log says what to look for.';
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

/** Parse a timestamp label into a sortable value. Unparseable labels sort last. */
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

    // A markdown table of headers is the other common shape, and the common one
    // in modern roleplay templates:
    //
    //   | 📅 Date | 🕓 Time | 📍 Location | 🌤️ Weather |
    //   |---|---|---|---|
    //   | October 24, 2026 | 08:38 PM | Sergey's Apartment | Clear, cold |
    //
    // It was not recognised at all, and every consequence followed from that:
    // the header was left in the body as noise, detection reported "no headers",
    // and the archivist was told to invent times for a chat that had them.
    const table = parseTableHeader(lines);
    if (table) return table;

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
        // **Date:** and 📅 Date: are the same field with decoration.
        const m = line.match(/^[*_\s]*([^\s:*_][A-Za-z][A-Za-z0-9 \/]{0,24}?)[*_\s]*:\s*(.+)$/);
        if (!m) {
            if (consumed === 0) return { found: false, meta: {}, body: src };
            break;
        }
        const key = normalizeHeaderKey(m[1]);
        // **Date:** puts its emphasis after the colon, so the decoration is
        // trimmed off the value too.
        const value = m[2].replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '').trim();
        if (!key || !value) {
            if (consumed === 0) return { found: false, meta: {}, body: src };
            break;
        }

        assignHeaderMeta(meta, key, value);
        consumed++;
    }

    const hasUseful = Boolean(meta.date || meta.time || meta.location);
    if (consumed === 0 || !hasUseful) {
        return { found: false, meta: {}, body: src };
    }

    return { found: true, meta, body: lines.slice(consumed).join('\n').replace(/^\n+/, '') };
}

/**
 * Read a two-row markdown table of headers. Only the first row is treated as the
 * header and only the second as its values, which is what these templates emit.
 */
function parseTableHeader(lines) {
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i + 2 >= lines.length) return null;

    const header = lines[i].match(/^\s*\|(.+)\|\s*$/);
    const separator = lines[i + 1];
    const values = lines[i + 2].match(/^\s*\|(.+)\|\s*$/);
    if (!header || !values) return null;
    // The separator row is what makes it a table: |---|---|---|---|
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(separator)) return null;

    const keys = header[1].split('|').map(normalizeHeaderKey);
    const cells = values[1].split('|').map(cell => cell.trim());
    const meta = {};
    keys.forEach((key, index) => {
        const value = cells[index];
        if (key && value) assignHeaderMeta(meta, key, value);
    });

    if (!meta.date && !meta.time && !meta.location) return null;

    let consumed = i + 3;
    // A table that sits at the very top with a blank line after it is a header;
    // a table further down is part of the prose.
    if (i > 0) return null;

    return {
        found: true,
        meta,
        body: lines.slice(consumed).join('\n').replace(/^\n+/, ''),
    };
}

/** `📅 Date`, `**Date**` and `Date` all mean the same field. */
function normalizeHeaderKey(raw) {
    return String(raw ?? '')
        .replace(/[*_`#]/g, ' ')
        .replace(/[^\p{L}\p{N} \/]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function assignHeaderMeta(meta, key, value) {
    if (key.includes('date')) meta.date = value;
    else if (key.includes('time') || key.includes('clock')) meta.time = value;
    else if (key.includes('day of') || key === 'day' || key.includes('weekday')) meta.weekday = value;
    else if (key.includes('location') || key === 'setting' || key === 'place') meta.location = value;
    else if (key.includes('weather') || key.includes('sky')) meta.weather = value;
    else if (key.includes('character') || key.includes('present')) meta.characters = value;
    else meta[key] = value;
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
 *
 * Every line is indexed and labelled with the exchange it belongs to, so the
 * model can see which reply answers which request — and an opening message,
 * which has no request before it, is marked as such instead of looking like a
 * reply to nothing. The index is also what the record has to bring back.
 */
export function formatMessagesForArchive(messages, { maxChars = 1200, useHeaders = true, startIndex = 0, startExchange = 0, title = '', includeHidden = false } = {}) {
    // Hidden messages are dropped unless the caller has already decided which
    // ones it wants: the seam and a run's own messages are absorbed by the time
    // they are sent, so refusing them here would empty the block silently.
    const list = (messages || []).filter(m => m && (includeHidden || !m.is_system));
    const chatTitle = String(title || '').trim().toLowerCase();
    // The numbering continues the chat's, so the same message cannot appear as
    // "#0" twice in one prompt — which reads as the model being handed the same
    // message twice, once to write up and once to leave alone.
    let exchange = Math.max(0, Math.floor(startExchange) || 0);
    const firstExchange = exchange;
    let awaitingReply = false;

    return list.map((m, i) => {
        const isUser = Boolean(m.is_user);
        if (isUser) {
            exchange++;
            awaitingReply = true;
        }
        // An assistant turn with no request before it opens the conversation —
        // unless the block itself starts halfway through an earlier exchange, in
        // which case the request is before the block and the turn is a reply.
        const startsMidExchange = i === 0 && firstExchange > 0 && !awaitingReply;
        const role = isUser ? 'user'
            : (startsMidExchange ? 'reply' : (exchange === firstExchange ? 'opening' : (awaitingReply ? 'reply' : 'extra')));
        if (!isUser) awaitingReply = false;

        // The speaker is named, never "User" or "Assistant": those labels end up
        // copied into the record. A group chat that titles its messages with the
        // chat name is not a speaker either.
        const name = String(m.name || '').trim();
        const isTitle = chatTitle && name.toLowerCase() === chatTitle;
        const speaker = m.extra?.type === 'narrator'
            ? 'Narrator'
            : (isTitle ? (isUser ? 'The user' : 'The character') : (name || (isUser ? 'The user' : 'The character')));

        const parsed = useHeaders ? parseMessageHeader(m.mes) : { found: false, meta: {}, body: m.mes };
        const { text } = truncateForPrompt(parsed.body, maxChars);

        const bits = [];
        const stamp = metaStamp(parsed.meta);
        if (stamp) bits.push(stamp);
        if (parsed.meta.location) bits.push(parsed.meta.location);
        const head = bits.length ? `${bits.join(' | ')} |` : '';

        return `[#${startIndex + i} · exchange ${exchange} · ${role}]${head ? ' ' + head : ''}\n${speaker}: ${text}`;
    }).join('\n\n');
}

/**
 * Remove headers from a batch of messages without otherwise altering them.
 *
 * Applied to hidden messages too: a run's own messages are absorbed by the time
 * they reach the summary request, and leaving their Date/Time headers in the body
 * would print the header twice — once stripped, once inline.
 */
export function stripHeaders(messages) {
    return (messages || []).map(m => {
        if (!m) return m;
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
