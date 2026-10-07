import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    estimateTokens,
    computeArchiveRange,
    chunk,
    fitArchiveToBudget,
    parseLorebookResponse,
    lorebookKey,
    mergeLorebook,
    shouldAdvanceLorebook,
    planPromptExclusion,
    repairedText,
    stripReasoning,
    extractCompletionText,
    extractStreamText,
    completionErrorText,
    reasoningText,
    describeEmptyAnswer,
    fitStage2Budgets,
    looksTruncatedRevision,
    markAbsorbed,
    reconcileWatermark,
    truncateForPrompt,
    formatMessages,
    perMessageCharLimit,
    pruneChatStates,
    chatStateKey,
    computeTokenStats,
    formatTokens,
    countCoreMemories,
    looksLikeRefusal,
    parseMessageHeader,
    metaStamp,
    shouldDetectHeaders,
    formatMessagesForArchive,
    stripHeaders,
    countExchanges,
    SUMMARIZED_FLAG,
    ORIGINAL_MES_KEY,
    HIDDEN_FLAG,
    PLACEHOLDER,
    recordBlocks,
    appendRecord,
    recordStats,
} from '../core.js';

test('index.js declares its defaults before anything references them', async () => {
    // A `const` used above its own declaration is a ReferenceError at module
    // evaluation time. The whole module then fails to load and the extension
    // silently disappears from SillyTavern's list, so this is worth asserting.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const lines = src.split('\n');

    const declaredAt = new Map();
    for (const [i, line] of lines.entries()) {
        const m = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i + 1);
    }

    const settingsLine = declaredAt.get('DEFAULT_SETTINGS');
    assert.ok(settingsLine, 'DEFAULT_SETTINGS must exist');

    const end = lines.findIndex((l, i) => i + 1 > settingsLine && /^\};/.test(l));
    assert.ok(end > settingsLine, 'DEFAULT_SETTINGS must have a closing brace');
    const block = lines.slice(settingsLine - 1, end + 1).join('\n');

    const used = [...block.matchAll(/([A-Z][A-Z0-9_]{3,})\s*[:,}]/g)].map(m => m[1]);
    assert.ok(used.includes('DEFAULT_GUARDRAIL'),
        'the check must actually be exercising a real reference, not silently passing on an empty list');

    for (const name of new Set(used)) {
        if (name === 'MODULE_NAME') continue;
        const at = declaredAt.get(name);
        assert.ok(at, `${name} is used in DEFAULT_SETTINGS but never declared`);
        assert.ok(
            at < settingsLine,
            `${name} is declared on line ${at} but used on line ${settingsLine}; ` +
            'a const cannot be read before it is initialised',
        );
    }
});

test('every import from core.js is actually exported', async () => {
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const core = await readFile(new URL('../core.js', import.meta.url), 'utf8');

    // Match only the core.js import, not the other imports in the file.
    const importBlock = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/core\.js';/);
    assert.ok(importBlock, 'index.js must import from ./core.js');

    const names = importBlock[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        // Drop any `x as y` alias suffix.
        .map(s => s.split(/\s+as\s+/)[0].trim());

    assert.ok(names.length > 10, 'expected a substantial import list');
    for (const name of names) {
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`).test(core);
        assert.ok(exported, `core.js does not export "${name}"`);
    }
});

test('index.js parses and every const it uses is declared before use', async () => {
    // The failure that made the extension vanish: a const referenced above its
    // own declaration throws ReferenceError at module evaluation, and SillyTavern
    // then drops the extension from its list with no visible cause.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const lines = src.split('\n');

    const declaredAt = new Map();
    const re = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/;
    lines.forEach((line, i) => {
        const m = line.match(re);
        if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i + 1);
    });

    // DEFAULT_SETTINGS is the one that must be fully built from literals.
    const settingsLine = declaredAt.get('DEFAULT_SETTINGS');
    assert.ok(settingsLine, 'DEFAULT_SETTINGS must exist');

    const body = lines.slice(settingsLine - 1, (declaredAt.get('EMPTY_CHAT_STATE') ?? settingsLine + 200) - 1)
        .slice(0, (declaredAt.get('DEFAULT_SETTINGS') + 200) - settingsLine)
        .join('\n');
    const block = body.slice(0, body.indexOf('\n};') + 2);

    const used = [...block.matchAll(/([A-Z][A-Z0-9_]{3,})\s*[:,}]/g)].map(m => m[1]);
    for (const name of new Set(used)) {
        if (name === 'MODULE_NAME') continue;
        const at = declaredAt.get(name);
        assert.ok(at, `${name} is used in DEFAULT_SETTINGS but never declared`);
        assert.ok(at < settingsLine, `${name} is declared on line ${at}, after its use on line ${settingsLine}`);
    }
});

test('estimateTokens scales with length and handles empties', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('a'.repeat(40)), 10);
});

test('computeArchiveRange excludes the raw tail and respects the watermark', () => {
    const r = computeArchiveRange({ chatLength: 30, watermark: -1, keepLast: 10 });
    assert.deepEqual(r, { start: 0, end: 19 });

    const r2 = computeArchiveRange({ chatLength: 30, watermark: 19, keepLast: 10 });
    assert.equal(r2, null);

    const r3 = computeArchiveRange({ chatLength: 30, watermark: 4, keepLast: 10 });
    assert.deepEqual(r3, { start: 5, end: 19 });
});

test('computeArchiveRange returns null when the chat is shorter than the tail', () => {
    assert.equal(computeArchiveRange({ chatLength: 5, watermark: -1, keepLast: 10 }), null);
});

test('chunk splits evenly and preserves order', () => {
    const list = [1, 2, 3, 4, 5, 6, 7];
    assert.deepEqual(chunk(list, 3), [[1, 2, 3], [4, 5, 6], [7]]);
    assert.deepEqual(chunk(list, 100), [list]);
    assert.deepEqual(chunk([], 5), []);
});

test('fitArchiveToBudget keeps the newest lines and reports drops', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ ts: `Day 1 09:${i % 60}`, text: 'x'.repeat(40) }));
    const { lines: kept, dropped } = fitArchiveToBudget(lines, 200);
    assert.ok(kept.length < lines.length);
    assert.equal(kept.length + dropped, lines.length);
    // Newest survives.
    assert.equal(kept[kept.length - 1].text, lines[lines.length - 1].text);
});

test('fitArchiveToBudget handles a zero budget', () => {
    const lines = [{ ts: '', text: 'something' }];
    const { lines: kept, dropped } = fitArchiveToBudget(lines, 0);
    assert.equal(kept.length, 0);
    assert.equal(dropped, 1);
});

test('parseLorebookResponse reads well formed lines', () => {
    const text = [
        'LOREBOOK_ENTRY|Varen Ashford|character|varen,captain|A captain who lost his hand at Keld.',
        'LOREBOOK_ENTRY|Siege of Keld|event|siege,battle|Lasted nine days; the east wall fell on the fourth.',
    ].join('\n');

    const { entries, rejected } = parseLorebookResponse(text);
    assert.equal(rejected, 0);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'Varen Ashford');
    assert.deepEqual(entries[0].keywords, ['varen', 'captain']);
    assert.equal(entries[1].type, 'event');
});

test('parseLorebookResponse rejects bad rows without discarding good ones', () => {
    const text = [
        'LOREBOOK_ENTRY|TooFewFields',
        'LOREBOOK_ENTRY||character|kw|missing name',
        'LOREBOOK_ENTRY|Valid One|character|kw|Solid content here.',
        'LOREBOOK_ENTRY|Bad Type|banana|kw|Wrong type value.',
    ].join('\n');

    const { entries, rejected } = parseLorebookResponse(text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Valid One');
    assert.equal(rejected, 3);
});

test('parseLorebookResponse keeps pipes inside the content', () => {
    const text = 'LOREBOOK_ENTRY|Well|concept|k|a | b | c';
    const { entries } = parseLorebookResponse(text);
    assert.equal(entries[0].content, 'a | b | c');
});

test('lorebookKey normalises for supersede-on-update', () => {
    assert.equal(lorebookKey('  Varen   Ashford '), 'varen_ashford');
    assert.equal(lorebookKey('SIEGE of Keld'), 'siege_of_keld');
});

test('mergeLorebook supersedes an existing entry instead of duplicating', () => {
    const existing = {
        varen: {
            name: 'Varen', type: 'character', keywords: ['varen'],
            content: 'old text', createdAt: 'T0', updatedAt: 'T0',
        },
    };
    const parsed = [{
        name: 'Varen', type: 'character', keywords: ['varen', 'captain'],
        content: 'new and better text',
    }];

    const { next, added } = mergeLorebook(existing, parsed, 'T1');
    assert.equal(added, 0);
    assert.equal(Object.keys(next).length, 1);
    assert.equal(next.varen.content, 'new and better text');
    assert.equal(next.varen.createdAt, 'T0', 'creation time must survive an update');
    assert.equal(next.varen.updatedAt, 'T1');
});

test('mergeLorebook counts genuinely new entries', () => {
    const { next, added } = mergeLorebook({}, [
        { name: 'A', type: 'character', keywords: [], content: 'a' },
        { name: 'B', type: 'event', keywords: [], content: 'b' },
    ], 'T1');
    assert.equal(added, 2);
    assert.equal(Object.keys(next).length, 2);
});

test('shouldAdvanceLorebook blocks progress on empty parse', () => {
    assert.equal(shouldAdvanceLorebook({ parsedCount: 0, rejected: 4, hadResponse: true }), false);
    assert.equal(shouldAdvanceLorebook({ parsedCount: 2, rejected: 0, hadResponse: true }), true);
    assert.equal(shouldAdvanceLorebook({ parsedCount: 2, rejected: 0, hadResponse: false }), false);
});

test('an absorbed message is excluded through SillyTavern\'s own prompt flag', () => {
    // The complaint this replaces: the message text used to be swapped for a
    // placeholder, so the chat lost the text and the model simply saw a note.
    // `is_system` is what the extension's own "Exclude message from prompts"
    // button sets, and it is the flag the prompt builder filters on.
    const chat = [
        { mes: 'user one', is_user: true },
        { mes: 'assistant one', [SUMMARIZED_FLAG]: true },
        { mes: 'assistant two' },
    ];
    const { hide, show } = planPromptExclusion(chat);
    assert.deepEqual(hide, [1]);
    assert.deepEqual(show, []);
});

test('the message text is never touched by exclusion', () => {
    const chat = [{ mes: 'assistant one', [SUMMARIZED_FLAG]: true }];
    const before = chat[0].mes;
    planPromptExclusion(chat);
    assert.equal(chat[0].mes, before, 'the text stays exactly as the user wrote it');
    assert.equal(chat[0][ORIGINAL_MES_KEY], undefined, 'no side copy of the text is needed');
});

test('exclusion is idempotent and never repeats work', () => {
    const chat = [{ mes: 'a', [SUMMARIZED_FLAG]: true, is_system: true, [HIDDEN_FLAG]: true }];
    assert.deepEqual(planPromptExclusion(chat), { hide: [], show: [] });
});

test('a message the user excluded by hand is adopted, and left alone afterwards', () => {
    const chat = [
        { mes: 'user hid this', is_system: true, [SUMMARIZED_FLAG]: true },
        { mes: 'user hid this too', is_system: true },
    ];
    const first = planPromptExclusion(chat);
    assert.deepEqual(first.hide, [0], 'an absorbed message takes ownership so it can be restored');
    assert.deepEqual(first.show, [], 'a message nobody archived is never un-hidden');
});

test('turning exclusion off releases only the messages this extension hid', () => {
    const chat = [
        { mes: 'ours', is_system: true, [HIDDEN_FLAG]: true, [SUMMARIZED_FLAG]: true },
        { mes: 'theirs', is_system: true },
    ];
    assert.deepEqual(planPromptExclusion(chat, { enabled: false }), { hide: [], show: [0] });
});

test('the watermark covers messages whose chat-file flag went missing', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'live' }];
    const { hide, show } = planPromptExclusion(chat, { mark: 1 });
    assert.deepEqual(hide, [0, 1]);
    assert.deepEqual(show, []);
});

test('nothing is excluded when nothing has been archived', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }];
    assert.deepEqual(planPromptExclusion(chat, { mark: -1 }), { hide: [], show: [] });
    assert.deepEqual(planPromptExclusion([], {}), { hide: [], show: [] });
    assert.deepEqual(planPromptExclusion(null, {}), { hide: [], show: [] });
});

test('a message that lost the archive flag is released again', () => {
    const chat = [{ mes: 'a', is_system: true, [HIDDEN_FLAG]: true }];
    assert.deepEqual(planPromptExclusion(chat, { mark: -1 }), { hide: [], show: [0] });
});

test('a placeholder left by an older build gives the original text back', () => {
    const msg = { mes: PLACEHOLDER, [ORIGINAL_MES_KEY]: 'the real message', [SUMMARIZED_FLAG]: true };
    assert.equal(repairedText(msg), 'the real message');
});

test('an edited message is not overwritten by its stale stored original', () => {
    // The user rewrote the message while it was hidden. The stored copy is from
    // before that edit, so the newer text is the one that has to survive.
    const msg = { mes: 'what the user just wrote', [ORIGINAL_MES_KEY]: 'the old text' };
    assert.equal(repairedText(msg), 'what the user just wrote');
});

test('a message with nothing to repair comes back unchanged', () => {
    assert.equal(repairedText({ mes: 'plain' }), 'plain');
    assert.equal(repairedText({}), '');
    assert.equal(repairedText(null), '');
});

test('a leaked reasoning block never reaches the summary or the archive', () => {
    const raw = [
        '<think>The user wants a record of the harbour scene. I should keep it factual.</think>',
        '',
        '### 1. Core Memories',
        'Core Memory: the throw into the water.',
    ].join('\n');

    const clean = stripReasoning(raw);
    assert.ok(!/think/i.test(clean), `reasoning survived: ${clean}`);
    assert.match(clean, /Core Memory: the throw into the water\./);
});

test('a reasoning block in the middle of an answer is removed, the rest kept', () => {
    const clean = stripReasoning('Before.\n<reasoning>hidden</reasoning>\nAfter.');
    assert.equal(clean, 'Before.\n\nAfter.');
});

test('a reasoning block cut off by the output limit takes nothing else with it', () => {
    const clean = stripReasoning('Answer first.\n<think>now I am reasoning and then I');
    assert.equal(clean, 'Answer first.');
});

test('ordinary text is not mistaken for reasoning', () => {
    const summary = '### 2. Plot Summary\nThey thought about it, then acted.\n<think>er';
    assert.equal(stripReasoning('A plain summary with no reasoning at all.'), 'A plain summary with no reasoning at all.');
    assert.ok(stripReasoning(summary).length > 0);
    assert.equal(stripReasoning(''), '');
    assert.equal(stripReasoning(null), '');
});

test('markAbsorbed flags only the requested range', () => {
    const chat = [
        { mes: 'a' }, { mes: 'b' }, { mes: 'c' }, { mes: 'd' },
    ];
    const marked = markAbsorbed(chat, 1, 2);
    assert.equal(marked[0][SUMMARIZED_FLAG], undefined);
    assert.equal(marked[1][SUMMARIZED_FLAG], true);
    assert.equal(marked[2][SUMMARIZED_FLAG], true);
    assert.equal(marked[3][SUMMARIZED_FLAG], undefined);
});

test('markAbsorbed leaves already flagged messages alone', () => {
    const chat = [{ mes: 'a', [SUMMARIZED_FLAG]: true }];
    const marked = markAbsorbed(chat, 0, 0);
    assert.equal(marked[0].mes, 'a');
    assert.equal(marked[0][SUMMARIZED_FLAG], true);
});

test('the watermark is re-derived from the flags when nothing is missing', () => {
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'b', [SUMMARIZED_FLAG]: true },
        { mes: 'live' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 1), { watermark: 1, repaired: 0 });
});

test('flags lost from the chat file are put back instead of re-archiving', () => {
    // Nothing at all is flagged: the file was saved before the flags reached it.
    // The archive already covers these messages, so they are re-flagged.
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];
    assert.deepEqual(reconcileWatermark(chat, 2), { watermark: 2, repaired: 3 });
});

test('a deletion inside the archive moves the watermark onto the last archived message', () => {
    // Message 1 was deleted: everything after it shifted down, so the message
    // now sitting at index 2 was never archived. Trusting the old watermark
    // would drop it out of the prompt and the record at the same time.
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'c', [SUMMARIZED_FLAG]: true },
        { mes: 'd' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 2, { chatChanged: true }), { watermark: 1, repaired: 0 });
});

test('a deletion that removes the end of the archive moves it the same way', () => {
    // b was archived and is now gone, so a is the last archived message and the
    // message behind it is not. Flagging it would hide a message the archive
    // never described.
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'c' },
        { mes: 'd' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 1, { chatChanged: true }), { watermark: 0, repaired: 0 });
});

test('an unarchived message between archived ones is a shifted chat, not a lost flag', () => {
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'c' },
        { mes: 'd', [SUMMARIZED_FLAG]: true },
        { mes: 'e' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 3), { watermark: 2, repaired: 0 });
});

test('a watermark left pointing past the end of the chat is clamped', () => {
    // A regenerate deletes the last message. An out-of-range watermark would
    // make every new message "already archived" and the archive would stall.
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'b', [SUMMARIZED_FLAG]: true },
    ];
    assert.deepEqual(reconcileWatermark(chat, 9, { chatChanged: true }), { watermark: 1, repaired: 0 });
});

test('a deletion after the archive leaves the watermark alone', () => {
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'b', [SUMMARIZED_FLAG]: true },
        { mes: 'live' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 1, { chatChanged: true }), { watermark: 1, repaired: 0 });
});

test('an untouched chat keeps its watermark', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }];
    assert.deepEqual(reconcileWatermark(chat, -1), { watermark: -1, repaired: 0 });
    assert.deepEqual(reconcileWatermark([], 4), { watermark: -1, repaired: 0 });
    assert.deepEqual(reconcileWatermark(null, 4), { watermark: -1, repaired: 0 });
});

test('a message excluded by the user is transparent to the watermark', () => {
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true },
        { mes: 'hidden by hand', is_system: true },
        { mes: 'c', [SUMMARIZED_FLAG]: true },
        { mes: 'live' },
    ];
    assert.deepEqual(reconcileWatermark(chat, 2), { watermark: 2, repaired: 0 });
});

test('truncateForPrompt leaves short text alone', () => {
    const r = truncateForPrompt('short enough', 100);
    assert.equal(r.truncated, false);
    assert.equal(r.text, 'short enough');
});

test('truncateForPrompt marks the cut and keeps a non-empty head', () => {
    const long = 'x'.repeat(5000);
    const r = truncateForPrompt(long, 500);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 500);
    assert.match(r.text, /\[\+\d+ chars\]$/);
    assert.ok(r.text.startsWith('x'));
});

test('truncateForPrompt never exceeds the budget, even a tiny one', () => {
    const r = truncateForPrompt('y'.repeat(300), 5);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 64, `length ${r.text.length} must respect the floor of 64`);
});

test('formatMessages caps each message and labels the roles', () => {
    const out = formatMessages([
        { is_user: true, mes: 'a'.repeat(4000) },
        { is_user: false, name: 'Serath', mes: 'b'.repeat(4000) },
    ], { maxChars: 300 });
    assert.match(out, /\[0\] User: a/);
    assert.match(out, /\[1\] Serath: b/);
    assert.ok(out.length < 1200, 'both messages should have been truncated');
    assert.match(out, /chars\]/);
});

test('perMessageCharLimit splits the budget evenly', () => {
    assert.equal(perMessageCharLimit(4000, 10), 400);
    assert.equal(perMessageCharLimit(4000, 0), 4000, 'no messages means the ceiling');
});

test('perMessageCharLimit respects the floor and ceiling', () => {
    assert.equal(perMessageCharLimit(100, 50), 200);
    assert.equal(perMessageCharLimit(10_000_000, 2), 4000);
});

test('pruneChatStates keeps the most recently touched states', () => {
    const states = {
        a: { touchedAt: 100 },
        b: { touchedAt: 300 },
        c: { touchedAt: 200 },
    };
    const { next, dropped } = pruneChatStates(states, 2);
    assert.equal(dropped, 1);
    assert.deepEqual(Object.keys(next).sort(), ['b', 'c']);
});

test('pruneChatStates is a no-op below the limit', () => {
    const states = { a: { touchedAt: 1 } };
    const { next, dropped } = pruneChatStates(states, 10);
    assert.equal(dropped, 0);
    assert.equal(next, states);
});

test('chatStateKey separates group chats from solo chats', () => {
    assert.equal(chatStateKey(3, 'group'), 'group:3');
    assert.equal(chatStateKey(3, 'solo'), 'solo:3');
    assert.notEqual(chatStateKey(3, 'group'), chatStateKey(3, 'solo'));
    assert.equal(chatStateKey(null, 'solo'), null);
    assert.equal(chatStateKey('', 'solo'), null);
});

test('parseMessageHeader reads a full roleplay header', () => {
    const raw = [
        'Date: July 13, 2025',
        'Time: 8:31 AM',
        'Day of the week: Sunday',
        "Location: Front porch of Rebecca's beach house near the marina",
        'Weather: Morning sun clear overhead; warm calm sea breeze',
        '',
        'Rebecca leaned on the rail and looked out at the water.',
    ].join('\n');

    const r = parseMessageHeader(raw);
    assert.equal(r.found, true);
    assert.equal(r.meta.date, 'July 13, 2025');
    assert.equal(r.meta.time, '8:31 AM');
    assert.equal(r.meta.weekday, 'Sunday');
    assert.match(r.meta.location, /Front porch/);
    assert.match(r.meta.weather, /Morning sun/);
    assert.equal(r.body, 'Rebecca leaned on the rail and looked out at the water.');
});

test('parseMessageHeader leaves ordinary prose untouched', () => {
    const raw = 'Varen walked into the room and looked around.';
    const r = parseMessageHeader(raw);
    assert.equal(r.found, false);
    assert.equal(r.body, raw);
});

test('parseMessageHeader does not mistake a sentence containing a colon', () => {
    const raw = 'He said: I am not going. Then he left.';
    const r = parseMessageHeader(raw);
    assert.equal(r.found, false);
    assert.equal(r.body, raw);
});

test('parseMessageHeader handles an empty message', () => {
    const r = parseMessageHeader('');
    assert.equal(r.found, false);
    assert.equal(r.body, '');
    assert.deepEqual(parseMessageHeader(null).meta, {});
});

test('metaStamp joins date and time only when present', () => {
    assert.equal(metaStamp({ date: 'July 13, 2025', time: '8:31 AM' }), 'July 13, 2025 8:31 AM');
    assert.equal(metaStamp({ location: 'The pier' }), '');
    assert.equal(metaStamp(null), '');
});

test('shouldDetectHeaders needs a majority of messages', () => {
    const withH = 'Date: July 13, 2025\nTime: 8:31 AM\nLocation: Pier\n\nBody here.';
    const without = 'Just a plain message.';
    assert.equal(shouldDetectHeaders(Array(6).fill({ mes: withH })), true);
    assert.equal(shouldDetectHeaders(Array(6).fill({ mes: without })), false);
    assert.equal(shouldDetectHeaders([{ mes: withH }, { mes: without }]), false);
});

test('shouldDetectHeaders ignores system messages and tiny chats', () => {
    const withH = 'Date: July 13, 2025\nTime: 8:31 AM\nLocation: Pier\n\nBody.';
    assert.equal(shouldDetectHeaders([{ mes: withH }, { mes: withH }]), false, 'needs at least four messages');
    assert.equal(shouldDetectHeaders([
        { mes: withH, is_system: true }, { mes: withH, is_system: true },
        { mes: withH, is_system: true }, { mes: withH, is_system: true },
    ]), false, 'system messages do not count as evidence');
});

test('formatMessagesForArchive hands the model real stamps and places', () => {
    const msgs = [
        { is_user: true, name: 'Sergey', mes: 'Where are we going?' },
        {
            is_user: false,
            name: 'Julia',
            mes: 'Date: July 13, 2025\nTime: 8:31 AM\nLocation: Front porch\n\nRebecca leaned on the rail.',
        },
    ];
    const out = formatMessagesForArchive(msgs, { useHeaders: true });
    assert.match(out, /\[#0 · exchange 1 · user\]/);
    // Speakers are named, never "User"/"Assistant": those words end up copied
    // into the record itself.
    assert.match(out, /Sergey: Where are we going\?/);
    assert.match(out, /\[#1 · exchange 1 · reply\] July 13, 2025 8:31 AM \| Front porch/);
    assert.match(out, /Julia: Rebecca leaned on the rail/);
    assert.ok(!/\bUser:/.test(out), 'the word "User" must never appear as a speaker');
    assert.ok(!/\bAssistant/.test(out), 'nor "Assistant"');
    assert.ok(!out.includes('Weather:'), 'the header itself must not be repeated in the body');
});

test('a message titled with the chat name is not presented as a speaker', () => {
    // A group chat that titled a message with the chat's own name produced lines
    // like "Assistant (My Chat) described Ruby climbing the ladder".
    const out = formatMessagesForArchive([
        { is_user: false, name: 'Someone Is In Your Room', mes: 'Ruby climbed the ladder.' },
        { is_user: false, extra: { type: 'narrator' }, mes: 'The rain had stopped by then.' },
        { is_user: false, mes: 'No name at all.' },
    ], { useHeaders: false, title: 'Someone Is In Your Room' });

    assert.ok(!/Someone Is In Your Room: Ruby climbed/.test(out), 'the chat title is not a speaker');
    assert.match(out, /The character: Ruby climbed the ladder\./);
    assert.match(out, /Narrator: The rain had stopped by then\./);
});

test('a block that starts mid-conversation keeps the chat\'s own numbering', () => {
    // The seam and a run's own messages are two blocks of one chat. Numbered from
    // zero each, they put a different message under the same "#0", which reads as
    // the same message being handed over twice — once to write up, once to leave
    // alone — and the model resolves that contradiction badly.
    const seam = [
        { is_user: false, is_system: true, name: 'Julia', mes: 'the tail of exchange 3' },
        { is_user: true, name: 'Julie', mes: 'and the start of exchange 4' },
    ];
    const out = formatMessagesForArchive(seam, {
        useHeaders: false, includeHidden: true, startIndex: 40, startExchange: 3,
    });

    assert.match(out, /\[#40 · exchange 3 · reply\]/, 'continues the exchange, not an "opening"');
    assert.match(out, /\[#41 · exchange 4 · user\]/);
    // A real conversation still opens the way it always did.
    const opening = formatMessagesForArchive([{ is_user: false, name: 'Julia', mes: 'The rain had stopped.' }], { useHeaders: false });
    assert.match(opening, /\[#0 · exchange 0 · opening\]/);
});

test('an absorbed message survives only when the caller asks for it', () => {
    // The seam and a run's own messages are hidden by the time they are sent.
    // Filtered out by default, the seam block came back empty and the prompt
    // claimed nothing had been recorded before it — the opposite of the truth.
    const absorbed = { is_user: false, is_system: true, name: 'Julia', mes: 'The kettle clicked off.' };
    const live = { is_user: false, name: 'Julia', mes: 'She came back from the window.' };

    assert.ok(!formatMessagesForArchive([absorbed], { useHeaders: false }).includes('kettle'),
        'hidden messages are dropped by default');

    const withHidden = formatMessagesForArchive([absorbed, live], { useHeaders: false, includeHidden: true });
    assert.match(withHidden, /Julia: The kettle clicked off\./);
    assert.match(withHidden, /Julia: She came back from the window\./);
    // The label that marks a message as excluded must never be its speaker.
    assert.ok(!/System:/.test(withHidden), 'an absorbed message is not a system message to the model');
});

test('a hidden message has its header stripped like any other', () => {
    // Otherwise the summary request prints the Date/Time twice: once stripped
    // from the block, once left inline in the body.
    const out = stripHeaders([{
        is_user: false, is_system: true, name: 'Julia',
        mes: 'Date: July 13, 2025\nTime: 8:31 AM\nLocation: Pier\n\nBody.',
    }]);
    assert.match(out[0].mes, /Body\./);
    assert.ok(!/^Date:/m.test(out[0].mes), 'the header is gone even though the message is hidden');
    assert.equal(out[0].name, 'Julia', 'nothing else about the message changed');
});

test('formatMessagesForArchive can leave the header inline when disabled', () => {
    const msgs = [{ is_user: false, name: 'Julia', mes: 'Date: July 13, 2025\nLocation: Pier\n\nBody.' }];
    const out = formatMessagesForArchive(msgs, { useHeaders: false });
    assert.match(out, /\[#0 · exchange 0 · opening\]/);
    assert.match(out, /Julia: Date: July 13, 2025/);
});

test('stripHeaders removes the block but keeps the message intact otherwise', () => {
    const msgs = [
        { is_user: false, mes: 'Date: July 13, 2025\nLocation: Pier\n\nBody text.', name: 'Rebecca' },
        { is_user: true, mes: 'Plain message.' },
    ];
    const out = stripHeaders(msgs);
    assert.equal(out[0].mes, 'Body text.');
    assert.equal(out[0].name, 'Rebecca');
    assert.equal(out[1].mes, 'Plain message.');
});

test('stripHeaders strips a header and leaves headerless text alone', () => {
    const msgs = [
        { mes: 'Date: July 13, 2025\n\nSystem.' },
        { is_user: true, mes: 'Plain.' },
    ];
    const out = stripHeaders(msgs);
    assert.equal(out[0].mes, 'System.');
    assert.equal(out[1], msgs[1], 'a message with no header is passed through untouched');
});

test('the extension owns its output limit instead of inheriting the chat one', () => {
    // The chat's generation setting governs the chat. Requests made by this
    // extension must use the extension's own value, and 0 must mean "no
    // override" rather than "fall back to something else silently".
    const resolve = (setting) => {
        const limit = Number(setting);
        if (Number.isFinite(limit) && limit > 0) return Math.max(256, Math.floor(limit));
        return null;
    };
    assert.equal(resolve(8192), 8192);
    assert.equal(resolve(0), null, 'zero means send no override at all');
    assert.equal(resolve(-5), null);
    assert.equal(resolve(undefined), null);
    assert.equal(resolve(10), 256, 'a floor keeps a nonsense value from producing nothing');
});

test('the live tail is never excluded', () => {
    // The messages that stay raw must reach the model, so the plan has to leave
    // the tail out even though it sits right next to the archived region.
    const chat = [
        { mes: 'archived', [SUMMARIZED_FLAG]: true },
        { mes: 'live text' },
        { mes: 'more live text' },
    ];
    assert.deepEqual(planPromptExclusion(chat), { hide: [0], show: [] });
});

test('an archived message that fell into the raw tail comes back into the prompt', () => {
    // The archive was built while the tail was 10, so the six archived messages
    // are hidden. The user then asked for 20 and the extra messages have to
    // become readable again even though the archive still describes them —
    // otherwise the setting does nothing at all.
    const archived = (i) => ({ mes: 'old ' + i, [SUMMARIZED_FLAG]: true, is_system: true, [HIDDEN_FLAG]: true });
    const chat = Array.from({ length: 16 }, (_, i) => (i < 6 ? archived(i) : { mes: 'new ' + i }));

    assert.deepEqual(planPromptExclusion(chat, { keepLast: 20 }), { hide: [], show: [0, 1, 2, 3, 4, 5] });
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 10 }), { hide: [], show: [] },
        'a ten-message tail of a sixteen-message chat is indices 6 to 15');
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 11 }), { hide: [], show: [5] },
        'index 5 becomes the first raw message');
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 3 }), { hide: [], show: [] },
        'a smaller tail changes nothing, the archived messages stay excluded');
});

test('a message that was archived but never hidden is hidden as soon as it leaves the tail', () => {
    const chat = Array.from({ length: 16 }, (_, i) =>
        (i < 6 ? { mes: 'old ' + i, [SUMMARIZED_FLAG]: true } : { mes: 'new ' + i }));

    assert.deepEqual(planPromptExclusion(chat, { keepLast: 20 }), { hide: [], show: [] },
        'everything is inside a twenty-message tail');
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 3 }), { hide: [0, 1, 2, 3, 4, 5], show: [] });
});

test('the tail is left alone whatever the watermark says', () => {
    const chat = [
        { mes: 'a', [SUMMARIZED_FLAG]: true, is_system: true, [HIDDEN_FLAG]: true },
        { mes: 'b', [SUMMARIZED_FLAG]: true, is_system: true, [HIDDEN_FLAG]: true },
        { mes: 'c' },
    ];
    // A watermark covering the whole chat must not drag the tail in with it:
    // keepLast 1 keeps only index 2 raw, keepLast 2 releases the archived
    // message that just fell inside the tail.
    assert.deepEqual(planPromptExclusion(chat, { mark: 2, keepLast: 1 }), { hide: [], show: [] });
    assert.deepEqual(planPromptExclusion(chat, { mark: 2, keepLast: 2 }), { hide: [], show: [1] });
});

test('a message the user excluded by hand inside the tail is left excluded', () => {
    const chat = [
        { mes: 'theirs', is_system: true },
        { mes: 'ours', is_system: true, [HIDDEN_FLAG]: true, [SUMMARIZED_FLAG]: true },
    ];
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 2 }), { hide: [], show: [1] });
    assert.deepEqual(planPromptExclusion(chat, { keepLast: 0 }), { hide: [], show: [] });
});

test('reconciling flags restores messages the chat file forgot to mark', () => {
    // The watermark is stored in settings, the flags in the chat file. If they
    // disagree the message would be neither hidden nor archived again.
    const mark = (chat, watermark) => chat.map((m, i) => {
        if (i > watermark || !m || m.is_system || m[SUMMARIZED_FLAG]) return m;
        return { ...m, [SUMMARIZED_FLAG]: true };
    });

    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];
    const fixed = mark(chat, 1);
    assert.equal(fixed[0][SUMMARIZED_FLAG], true);
    assert.equal(fixed[1][SUMMARIZED_FLAG], true);
    assert.equal(fixed[2][SUMMARIZED_FLAG], undefined, 'beyond the watermark stays raw');
});

test('reconciling is a no-op when the flags are already correct', () => {
    const chat = [{ mes: 'a', [SUMMARIZED_FLAG]: true }, { mes: 'b' }];
    const before = JSON.stringify(chat);
    const mark = (c, w) => c.map((m, i) => (i > w || !m || m[SUMMARIZED_FLAG] ? m : { ...m, [SUMMARIZED_FLAG]: true }));
    assert.equal(JSON.stringify(mark(chat, 0)), before);
});

test('a negative watermark marks nothing', () => {
    const chat = [{ mes: 'a' }];
    const mark = (c, w) => {
        if (w < 0) return c;
        return c;
    };
    assert.equal(mark(chat, -1)[0][SUMMARIZED_FLAG], undefined);
});

test('token accounting shows what compression actually bought', () => {
    const t = computeTokenStats({
        absorbedCount: 280,
        absorbedTokens: 42000,
        liveTokens: 6000,
        archiveTokens: 3000,
        summaryTokens: 2500,
        lorebookTokens: 1200,
        budgetTokens: 9000,
    });
    assert.equal(t.injectedTokens, 6700);
    assert.equal(t.beforeTokens, 48000);
    assert.equal(t.effectiveTokens, 12700);
    assert.equal(t.savedTokens, 35300);
    assert.equal(t.isExpansion, false);
    assert.ok(t.ratio < 0.3, 'the point of the exercise is a much smaller prompt');
});

test('token accounting admits when compression is costing more than it saves', () => {
    const t = computeTokenStats({
        absorbedTokens: 1000, liveTokens: 100,
        archiveTokens: 900, summaryTokens: 800, lorebookTokens: 400,
    });
    assert.equal(t.effectiveTokens, 2200);
    assert.equal(t.beforeTokens, 1100);
    assert.equal(t.savedTokens, -1100, 'a negative saving must be visible, not hidden');
    assert.equal(t.isExpansion, true);
});

test('token accounting handles an untouched chat', () => {
    const t = computeTokenStats({ liveTokens: 5000 });
    assert.equal(t.injectedTokens, 0);
    assert.equal(t.beforeTokens, 5000);
    assert.equal(t.effectiveTokens, 5000);
    assert.equal(t.savedTokens, 0);
    assert.equal(t.ratio, 1);
    assert.equal(t.isExpansion, false);
});

test('formatTokens stays compact and readable', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(42000), '42.0k');
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatTokens(NaN), '0');
});

test('core memories are counted so a lossy revision is detectable', () => {
    const summary = [
        '### 1. Core Memories',
        'Core Memory: first one',
        'Core Memory: second one',
        '### 2. Plot Summary',
        'Core Memory: not really a header but counted',
    ].join('\n');
    assert.equal(countCoreMemories(summary), 3);
    assert.equal(countCoreMemories(''), 0);
    assert.equal(countCoreMemories(null), 0);
    assert.ok(countCoreMemories(summary) > countCoreMemories('nothing here'));
});

test('a revision that dropped core memories reads as a loss', () => {
    const before = 'Core Memory: a\nCore Memory: b\nCore Memory: c';
    const after = 'Core Memory: a';
    assert.ok(countCoreMemories(before) > countCoreMemories(after));
    assert.equal(countCoreMemories(before) - countCoreMemories(after), 2);
});

test('a refusal is recognised instead of being archived as content', () => {
    // The model answering "I can't help with that" must never become a record
    // line, so the refusals people actually emit are matched explicitly.
    const refusals = [
        "I'm sorry, but I can't help with that request.",
        'I cannot write this content.',
        "Sorry, I can't do that.",
        'Извините, я не могу выполнить этот запрос.',
        'К сожалению, я не могу продолжить.',
        'I am unable to provide that.',
    ];
    for (const r of refusals) {
        assert.equal(looksLikeRefusal(r), true, `should be caught: ${r}`);
    }
});

test('a real record is not mistaken for a refusal', () => {
    const records = [
        '[July 12, 2025 1:15 PM] Rebecca and Ruby stand at the railing.',
        'I cannot recall the exact wording, so I recorded what happened instead.',
        "The user said sorry, and then the scene moved on.",
        '',
    ];
    assert.equal(looksLikeRefusal(''), false);
    for (const r of records) {
        assert.equal(looksLikeRefusal(r), false, `should pass: ${r}`);
    }
});

test('a refusal buried deep in the text is not caught by the leading check', () => {
    // Detection is deliberately anchored, so a real record is never rejected.
    const late = '[July 12, 2025 1:15 PM] Something happened.\n\nI am sorry, but I cannot continue.';
    assert.equal(looksLikeRefusal(late), false);
});

test('ordinary words that are also refusal verbs do not trigger detection', () => {
    // Regression: an ungrouped alternation would match the bare verb anywhere,
    // so any record containing "do", "continue" or "share" looked like a refusal.
    const records = [
        '[Day 1 09:12] Rebecca asks Sergey to continue the game.',
        '[Day 1 09:14] They agree to share the oars.',
        '[Day 1 09:16] Sergey does not want to provide an answer.',
        'She writes: I cannot do this to you.',
    ];
    for (const r of records) {
        assert.equal(looksLikeRefusal(r), false, `should pass: ${r}`);
    }
});

test('a genuine refusal is still caught at the start', () => {
    assert.equal(looksLikeRefusal("I cannot provide that content."), true);
    assert.equal(looksLikeRefusal("I can't help with that."), true);
    assert.equal(looksLikeRefusal("I cannot continue with this request."), true);
});

test('the archive and the summary are told to keep different jobs', async () => {
    // The two records used to overlap: the summary restated the events, so the
    // same context was paid for twice and the emotional layer was drowned out.
    // The prompts are the only place this split can be enforced, so it is
    // asserted rather than assumed.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const grab = (name) => {
        const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
        assert.ok(m, `${name} must exist`);
        return m[1];
    };

    const chronicle = grab('CHRONICLE_PROMPT_TEMPLATE');
    assert.match(chronicle, /It is a record of events, not a transcript/i,
        'the record must never turn into a per-message transcript');
    assert.match(chronicle, /Keep what carries the story/i);
    assert.match(chronicle, /WHAT THE RECORD IS FOR/i);

    const summary = grab('SUMMARY_PROMPT_TEMPLATE');
    assert.match(summary, /DIVISION OF LABOUR/i);
    assert.match(summary, /if the archive already says it, do not write it again/i);
    assert.match(summary, /Never restate the archive/i);
    // The injector looks these up by name, so renaming one silently stops it
    // from ever being injected again.
    for (const section of ['Core Memories', 'Key Events', 'Character Truths', 'Relationship Dynamics', 'Secrets', 'Open Threads']) {
        assert.ok(summary.includes(section), `the summary prompt must keep the "${section}" section`);
    }

    const stage2 = grab('SUMMARY_STAGE2_FRAMING');
    assert.match(stage2, /A summary that repeats the card, the record or the recent messages has failed/i);

    // The structural template used to be appended raw, so the model was handed
    // the same brief twice and ended with literal {{summary}} and
    // {{new_messages}} where it was supposed to answer.
    assert.ok(!src.includes('SUMMARY_STAGE2_HEADER'), 'the duplicated stage 2 header must be gone');
    assert.match(src, /function buildStage2Prompt\(/);
    assert.match(src, /'\{\{new_messages\}\}': hasMessagesSlot \? material : ''/);
});

test('the summary request is fitted to the window once the instructions are counted', () => {
    // The stage 2 request is the biggest one the extension makes, and the
    // instructions are several thousand tokens of it. Budgeting only the
    // material is how it outgrew the window and came back as an error.
    const fitted = fitStage2Budgets({
        window: 32768,
        share: 0.3,
        overheadTokens: 5000,
        archiveTokens: 12000,
        recentTokens: 6000,
    });
    assert.equal(fitted.capped, true);
    assert.equal(fitted.cappedBy, 'window');
    assert.ok(fitted.archive + fitted.recent <= fitted.usable,
        `blocks ${fitted.archive}+${fitted.recent} must fit in ${fitted.usable}`);
    assert.ok(fitted.recent > 0, 'the live edge is what the summary must reflect');
    assert.ok(fitted.archive > 0, 'the record still has to be there');
});

test('a small window takes a larger share rather than losing the summary entirely', () => {
    // A third of a 16k window cannot even hold the instructions, and a summary
    // that never runs is worse than one that takes most of the window.
    const fitted = fitStage2Budgets({
        window: 16384,
        share: 0.3,
        overheadTokens: 5000,
        archiveTokens: 12000,
        recentTokens: 6000,
    });
    assert.equal(fitted.cappedBy, 'share');
    assert.ok(fitted.archive > 0 && fitted.recent > 0);
    assert.ok(fitted.archive + fitted.recent <= fitted.usable);
});

test('a request that already fits is left exactly as configured', () => {
    const fitted = fitStage2Budgets({
        window: 200000,
        overheadTokens: 5000,
        archiveTokens: 12000,
        recentTokens: 6000,
    });
    assert.deepEqual(
        { archive: fitted.archive, recent: fitted.recent, capped: fitted.capped },
        { archive: 12000, recent: 6000, capped: false },
    );
});

test('an unknown context window means no cap, and says so', () => {
    const fitted = fitStage2Budgets({ window: 0, archiveTokens: 12000, recentTokens: 6000 });
    assert.equal(fitted.capped, false);
    assert.equal(fitted.cappedBy, null);
    assert.equal(fitted.archive, 12000);
});

test('instructions that alone outgrow the window stop the request instead of sending it', () => {
    const fitted = fitStage2Budgets({ window: 8000, overheadTokens: 9000, archiveTokens: 4000, recentTokens: 2000 });
    assert.equal(fitted.capped, true);
    assert.equal(fitted.cappedBy, 'overhead');
    assert.equal(fitted.archive, 0);
    assert.equal(fitted.recent, 0);
});

test('a stub cannot quietly replace a real summary', () => {
    const long = 'x'.repeat(8000);
    assert.equal(looksTruncatedRevision(long, 'too short'), true);
    assert.equal(looksTruncatedRevision(long, ''), true);
    // A genuine compression of an over-long summary is allowed through.
    assert.equal(looksTruncatedRevision(long, 'y'.repeat(5000)), false);
    // Nothing to compare against: the first summary is always accepted.
    assert.equal(looksTruncatedRevision('', 'brand new summary'), false);
    assert.equal(looksTruncatedRevision(null, null), false);
});

test('every request carries a timeout and the cancel signal', async () => {
    // A fetch made without a signal cannot be timed out or stopped: one stalled
    // upstream request then hangs the whole run with nothing on screen, which is
    // what "it just spins forever" meant.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');

    const fetches = [...src.matchAll(/(?<![\w.])await fetch\(/g)];
    assert.equal(fetches.length, 1,
        'exactly one fetch may exist: the one inside fetchWithTimeout, which every request goes through');

    assert.match(src, /function fetchWithTimeout\(/);
    assert.match(src, /signal: controller\.signal/);
    assert.match(src, /setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}/);
    // The run's own cancel signal has to reach the same controller.
    assert.match(src, /runSignal\.addEventListener\('abort', onRunAbort, \{ once: true \}\)/);
    assert.match(src, /requestTimeoutSeconds/);
});

test('the answer is read out of every response shape SillyTavern can return', () => {
    // ST wraps most sources back into the OpenAI shape but passes Cohere, Mistral,
    // AI21 and non-OpenAI custom endpoints through untouched. Reading only
    // choices[0] made working models look like they returned nothing.
    assert.equal(extractCompletionText({ choices: [{ message: { content: 'openai' } }] }), 'openai');
    assert.equal(extractCompletionText({ choices: [{ text: 'legacy' }] }), 'legacy');
    assert.equal(extractCompletionText({ message: { content: 'mistral' } }), 'mistral');
    assert.equal(extractCompletionText({ content: [{ type: 'text', text: 'claude' }] }), 'claude');
    assert.equal(extractCompletionText({ text: 'cohere' }), 'cohere');
    assert.equal(extractCompletionText({ generations: [{ text: 'old style' }] }), 'old style');
    assert.equal(extractCompletionText({ response: 'ollama' }), 'ollama');
    assert.equal(extractCompletionText({ output_text: 'responses api' }), 'responses api');
});

test('Google-style parts are joined and thinking parts are left out', () => {
    const google = {
        candidates: [{
            content: {
                parts: [
                    { text: 'reasoning that must not leak', thought: true },
                    { text: 'the answer' },
                ],
            },
        }],
    };
    assert.equal(extractCompletionText(google), 'the answer');
});

test('a response with nothing usable in it reads as empty rather than as junk', () => {
    assert.equal(extractCompletionText({ choices: [{ message: { content: '' } }] }), '');
    assert.equal(extractCompletionText({ choices: [{ message: { content: null } }] }), '');
    assert.equal(extractCompletionText({ choices: [{ message: { content: [] } }] }), '');
    assert.equal(extractCompletionText({}), '');
    assert.equal(extractCompletionText(null), '');
    assert.equal(extractCompletionText(undefined), '');
});

test('an error the backend hides inside a 200 response is not mistaken for an empty answer', () => {
    // Google answers 200 with an error object when nothing could be generated.
    assert.equal(completionErrorText({ error: { message: 'API key not valid' } }), 'API key not valid');
    assert.equal(completionErrorText({ error: 'plain string error' }), 'plain string error');
    assert.equal(completionErrorText({ choices: [] }), '');
});

test('reasoning returned separately from the answer is recognised', () => {
    const payload = { choices: [{ message: { content: '', reasoning_content: 'the model thought about it' } }] };
    assert.match(reasoningText(payload), /thought about it/);
    assert.equal(reasoningText({ choices: [{ message: { content: 'answer' } }] }), '');
    assert.equal(reasoningText(null), '');
});

test('an empty answer says which of the causes it was', () => {
    assert.match(describeEmptyAnswer({ reasoning: 'thinking...' }), /spent the whole answer budget on reasoning/);
    assert.match(describeEmptyAnswer({ finishReason: 'length' }), /cut off by the output limit/);
    assert.match(describeEmptyAnswer({ parsed: false, contentType: 'text/html' }), /text\/html instead of JSON/);
    assert.match(describeEmptyAnswer({ finishReason: 'stop' }), /finish_reason: stop/);
    assert.match(describeEmptyAnswer({}), /empty answer/);
});

test('a backend error inside a 200 is classified, not echoed', () => {
    // The bare phrase a relayed endpoint returns when it cannot serve the
    // request. Saying it again teaches nobody anything.
    assert.match(describeEmptyAnswer({ error: 'Request error' }), /refused the request before generating/);
    // A free or relayed backend that is momentarily out of capacity: the same
    // request is fine later, so this must not read as a prompt problem.
    assert.match(describeEmptyAnswer({ error: 'no available provider' }), /temporarily unable to serve/);
    assert.match(describeEmptyAnswer({ error: 'upstream busy, try again' }), /temporarily unable to serve/);
    assert.match(describeEmptyAnswer({ error: 'content filtered by policy' }), /will not archive this chat/);
    assert.match(describeEmptyAnswer({ error: 'input too large for this model' }), /too large/);
    assert.match(describeEmptyAnswer({ error: 'invalid api key' }), /connection or key problem/);
    // Whatever the class, the provider's own words survive.
    assert.match(describeEmptyAnswer({ error: 'Request error' }), /Request error/);
});

test('a streamed answer is assembled from whatever frames the provider sends', () => {
    // Streaming is what keeps a long generation alive behind a proxy, and ST
    // pipes the provider's own events through untouched, so the frames are in
    // whatever shape that provider uses.
    const openai = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":", world"}}]}',
        '',
        'data: [DONE]',
        '',
    ].join('\n');
    const a = extractStreamText(openai);
    assert.equal(a.text, 'Hello, world');
    assert.equal(a.frames, 3);
    assert.equal(a.streamed, true);
    assert.equal(a.error, '');

    const claude = [
        'event: message_start\ndata: {"type":"message_start"}',
        '',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
        '',
        'event: message_stop\ndata: {"type":"message_stop"}',
        '',
    ].join('\n');
    assert.equal(extractStreamText(claude).text, 'Hi');

    const gemini = [
        'data: {"candidates":[{"content":{"parts":[{"text":"one "}]}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[{"text":"two"}]}}]}',
        '',
    ].join('\n');
    assert.equal(extractStreamText(gemini).text, 'one two');

    const cohere = 'data: {"event":"content-delta","text":"chunk"}\n';
    assert.equal(extractStreamText(cohere).text, 'chunk');
});

test('a provider that ignores streaming still answers', () => {
    // The body comes back as one object, so it is read as one object.
    const whole = extractStreamText(JSON.stringify({ choices: [{ message: { content: 'whole body' } }] }));
    assert.equal(whole.text, 'whole body');
    assert.equal(whole.streamed, false);
    assert.equal(extractStreamText('not json at all').text, '');
    assert.equal(extractStreamText('').text, '');
});

test('an error inside a stream frame is not lost', () => {
    const body = 'data: {"error":{"message":"context length exceeded"}}\n\n';
    const r = extractStreamText(body);
    assert.equal(r.text, '');
    assert.match(r.error, /context length exceeded/);
});

test('reasoning streamed in its own frames is recognised as reasoning', () => {
    const body = [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}',
        '',
    ].join('\n');
    const r = extractStreamText(body);
    assert.equal(r.text, '');
    assert.match(r.reasoning, /thinking hard/);
});

test('a reset is written to disk at once, not on the debounce', async () => {
    // A queued reset dies with the page. The reload brings back the old watermark
    // and the old archive, and the next run then summarizes only what arrived
    // after the last one — which looks exactly like the reset never happened.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ saveSettings, saveSettingsDebounced,/,
        'the immediate save has to be imported');
    assert.match(src, /function saveSettingsNow\(\)/);

    const lines = src.split('\n');
    const critical = [
        ['resetStateForRebuild', /EMPTY_CHAT_STATE/],
        ['reabsorb', /Object\.assign\(state, EMPTY_CHAT_STATE\(\)\)/],
        ['clear summary', /state\.record = '';/],
        ['clear record', /state\.record = '';/],
        ['clear lorebook', /state\.lorebook = \{\};/],
    ];

    for (const [what, marker] of critical) {
        const at = lines.findIndex((line, i) => marker.test(line) &&
            lines.slice(i, i + 6).some(l => /saveSettings/.test(l)));
        assert.ok(at >= 0, `${what} must save its state`);
        const window = lines.slice(at, at + 6).join('\n');
        assert.ok(/saveSettingsNow\(\)/.test(window),
            `${what} writes through immediately so a reload cannot undo it`);
    }
});

test('the summary is told to be the fifth source, not a copy of the other four', async () => {
    // The request that matters: the model already receives the character card, the
    // record and the last exchanges. Everything the summary repeats is tokens
    // spent saying what is already there.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const framing = src.match(/const SUMMARY_STAGE2_FRAMING = `([\s\S]*?)`;/)[1];

assert.match(framing, /FOUR SOURCES OF TRUTH/);
    assert.match(framing, /CHARACTER CARD/);
    assert.match(framing, /MOST RECENT EXCHANGES/i);
    assert.match(framing, /Do NOT restate the card/i);
    assert.match(framing, /Do NOT restate the record/i);
    assert.match(framing, /Do NOT describe the last few exchanges/i);
    // The record is a document in blocks of time now, not one line per message.
    assert.ok(!/one factual line per message/.test(framing),
        'the record must not be described to the model as a per-message transcript');
    // The old brief pushed the opposite way: present-moment first, always.
    assert.ok(!/Weight them heavily when\s+determining the CURRENT/i.test(framing),
        'the summary must not be steered towards the present moment any more');

    const template = src.match(/const SUMMARY_PROMPT_TEMPLATE = `([\s\S]*?)`;/)[1];
    for (const section of [
        'Core Memories',
        'Key Events & Consequences',
        'Character Truths',
        'Relationship Dynamics',
        'Secrets & Knowledge',
        'Open Threads',
        'Motifs & References',
    ]) {
        assert.ok(template.includes(section), `the structure must keep "${section}"`);
    }
    assert.match(template, /never restate the character card/i);
    assert.match(template, /never describe the immediate scene/i);
    assert.match(template, /who these people turned out to be/i);
    assert.ok(!/Current Emotional Landscape|Current Character States/.test(template),
        'the state-reporting headings are gone');
});

test('a renamed section is still injected under its old name', async () => {
    // A summary written before the rename is still sitting in chat files. If the
    // injector only knew the new names, those sections would quietly stop being
    // injected and nobody would find out until the context looked thin.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const pairs = [
        ["['Key Events', 'Plot Summary']", 'Key Events', 'Plot Summary'],
        ["['Character Truths', 'Character States']", 'Character Truths', 'Character States'],
        ["['Relationship Dynamics', 'Emotional Arc']", 'Relationship Dynamics', 'Emotional Arc'],
        ["['Open Threads', 'Future Plot Hooks']", 'Open Threads', 'Future Plot Hooks'],
    ];
    for (const [literal, current, legacy] of pairs) {
        assert.ok(src.includes(literal), `${current} must fall back to ${legacy}`);
    }
    assert.match(src, /function extractSection\(summary, sectionNames\)/);
    assert.match(src, /Array\.isArray\(sectionNames\) \? sectionNames : \[sectionNames\]/);
});

test('a markdown table of headers is read as the real date and time', () => {
    // This is the shape modern roleplay templates actually use, and it was not
    // recognised at all: the header stayed in the body as noise, detection said
    // "no headers", and the archivist was then told to invent times for a chat
    // that had a date on every single message.
    const msg = [
        '| 📅 Date | 🗓️ Weekday | 🕒 Time | 📍 Location | 🌤️ Weather |',
        '|---|---|---|---|---|',
        "| October 24, 2026 | Thursday | 08:38 PM | Sergey's Apartment, Bathroom | Clear, cold, 31°F |",
        '',
        'Sergey sets the phone down and looks at her.',
        '"You actually came."',
    ].join('\n');

    const r = parseMessageHeader(msg);
    assert.equal(r.found, true);
    assert.equal(r.meta.date, 'October 24, 2026');
    assert.equal(r.meta.time, '08:38 PM');
    assert.equal(r.meta.location, "Sergey's Apartment, Bathroom");
    assert.equal(r.meta.weather, 'Clear, cold, 31°F');
    assert.equal(metaStamp(r.meta), 'October 24, 2026 08:38 PM');
    assert.ok(!r.body.includes('October 24'), 'the table must not stay in the body');
    assert.match(r.body, /Sergey sets the phone down/);

    assert.equal(shouldDetectHeaders([{ mes: msg }, { mes: msg }, { mes: msg }, { mes: msg }]), true,
        'a table header counts as a header for detection');
});

test('a table that is part of the prose is not mistaken for a header', () => {
    const prose = [
        'He opened the file and the table below showed the damage:',
        '',
        '| Item | Cost |',
        '|---|---|',
        '| Hull | 4000 |',
    ].join('\n');
    const r = parseMessageHeader(prose);
    assert.equal(r.found, false, 'a table in the middle of the prose is content');
    assert.equal(r.body, prose);
});

test('decorated keys are still keys', () => {
    const bold = '**Date:** July 13, 2025\n**Time:** 8:31 AM\n**Location:** Pier\n\nBody.';
    const r = parseMessageHeader(bold);
    assert.equal(r.found, true);
    assert.equal(metaStamp(r.meta), 'July 13, 2025 8:31 AM');
    assert.equal(r.meta.location, 'Pier');
    assert.match(r.body, /^Body\./, 'the emphasis must not end up in the value');
});

test('both stages share one temperature and one top p', async () => {
    // They do the same kind of work — restate material in a fixed format — and
    // they used to sample differently, with top p 1 letting the model reach any
    // token in the tail. That is where stray fragments came from.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /function samplingFor\(\)/);
    assert.match(src, /summaryTemperature: 0\.6/, 'the default temperature is 0.6');
    assert.match(src, /summaryTopP: 0\.8/, 'the default top p is 0.8');

    // Every request body takes its sampling from there, not from a constant.
    const bodies = src.match(/temperature: sampling\.temperature,\s*\n\s*top_p: sampling\.top_p,/g) || [];
    assert.ok(bodies.length >= 1, 'the direct request must use the shared sampling');
    assert.ok(!/top_p: 1,/.test(src), 'top p 1 is gone');
    assert.ok(!/temperature: 0\.3/.test(src), 'the old hardcoded 0.3 is gone');
    assert.match(src, /id="es_top_p"/, 'the top p is settable');
});

test('the record is a document the model writes, in blocks it chooses itself', async () => {
    // The failure this replaces: a line per message became a transcript, so the
    // record carried a sentence for every gesture and never said what mattered.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const chronicle = src.match(/const CHRONICLE_PROMPT_TEMPLATE = `([\s\S]*?)`;/)[1];

    assert.match(chronicle, /Group by scene or by stretch of time rather than by message/);
    assert.match(chronicle, /Small talk, gestures, weather, food, repeated motions/);
    assert.match(chronicle, /place\s+events in plausible stretches of the day/i);
    assert.match(chronicle, /approximate/);
    assert.match(chronicle, /Output only the new blocks/);

    // The per-message machinery is gone: nothing may force a line per message.
    assert.ok(!/ONE (OUTPUT )?LINE PER INPUT LINE/i.test(chronicle));
    assert.ok(!/\[#\d+\]/.test(chronicle), 'no per-message index is demanded any more');
    assert.ok(!src.includes('verifyChronicleCoverage'), 'no coverage gate remains');
    assert.ok(!src.includes('validateChronicleResponse'));
    assert.ok(!src.includes('parseChronicleBlock'));
    assert.ok(!src.includes('sortArchiveLines'));

    // An embedded conversation is written down by what it said.
    assert.match(chronicle, /a conversation inside it/i);
    assert.match(chronicle, /Never write that someone typed, sent or stopped typing/i);

    // The record lives as one text field, not as parsed lines.
    assert.match(src, /record: '',/);
    assert.match(src, /state\.record = condensed;/);
});

test('times are the model\'s to place, and a real header is used when there is one', async () => {
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /Where a message carries a real date and time/);
    assert.match(src, /The messages carry no timestamps at all, so work every time out of the material itself/);
    // Nothing may order the record by a clock the model wrote.
    assert.ok(!/sortArchiveLines|timestampValue\(/.test(src));
});

test('both stages are given the record, the seam and the new material, each labelled', async () => {
    // Without the seam the model sees a finished document and then new material,
    // and guesses what happened in between. Without the labels it cannot tell
    // what it already has from what it is being asked to add.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const chronicle = src.match(/const CHRONICLE_PROMPT_TEMPLATE = `([\s\S]*?)`;/)[1];

    for (const slot of ['{{current_record}}', '{{recent_archived}}', '{{new_messages}}']) {
        assert.ok(chronicle.includes(slot), `the record prompt must carry ${slot}`);
        assert.ok(src.includes(`'${slot}'`), `${slot} must actually be filled`);
    }
    assert.match(chronicle, /THE RECORD SO FAR/);
    assert.match(chronicle, /THE SEAM — ALREADY RECORDED, CONTEXT ONLY/);
    assert.match(chronicle, /NEW MESSAGES — THESE ARE THE ONES TO WRITE UP/);
    assert.match(chronicle, /Do\s+not write them up again/i);

    // The tail of the record, not the whole of it: whole blocks, from the end.
    assert.match(src, /function recordTailText\(maxTokens\)/);
    assert.match(src, /recordTailText\(recordTailBudget\)/);

    // Stage 2 gets the same three things, under labels the framing explains.
    assert.match(src, /newMessagesText: material\.newMessagesText/);
    assert.match(src, /seamText: material\.seamText/);
    assert.match(src, /NEW MESSAGES — this run just absorbed these/);
    assert.match(src, /THE SEAM — the last messages before those, already summarised/);
    const framing = src.match(/const SUMMARY_STAGE2_FRAMING = `([\s\S]*?)`;/)[1];
    assert.match(framing, /THE INPUT IS LABELLED, AND THE LABELS ARE TRUE/);
    assert.match(framing, /Do not\s+re-report them as new developments/i);

    // The messages absorbed in this run are shown to stage 2 as themselves; they
    // are hidden from the prompt by then, so the record is their only other trace.
    assert.match(src, /const archivedThisRun = \[\]/);
    assert.match(src, /archivedThisRun\.push\(\.\.\.batch\)/);
    assert.match(src, /formatMessagesForArchive\(stripHeaders\(archivedThisRun\)/);
    assert.match(src, /includeHidden: true/,
        'a run\'s own messages and the seam are hidden by the time they are sent');

    // And the seam is configurable, because how much is enough is a judgement
    // the user has to be able to make.
    assert.match(src, /overlapMessages: 6/);
    assert.match(src, /absorbedMessages\(overlapLimit\)/);
});

test('the record is trimmed by whole blocks, never by splitting one', async () => {
    // A block without its heading leaves the reader without the time it belongs to.
    const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /recordBlocks\(getRecord\(\)\)/);
    assert.match(src, /omitted for length/);
});

test('the record is split on the headings the model wrote', () => {
    const record = [
        '## Day 1 — evening, his apartment',
        '20:40-21:10  Dinner, and the cake from work.',
        '21:10-21:25  He said he loved her.',
        '',
        '## Day 2 — morning',
        '08:00-08:20  She left before he woke.',
    ].join('\n');

    const blocks = recordBlocks(record);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /## Day 1/);
    assert.match(blocks[0], /Dinner/);
    assert.match(blocks[1], /## Day 2/);
    assert.ok(!blocks[1].includes('Dinner'), 'a block keeps only its own material');

    assert.deepEqual(recordBlocks(''), []);
    assert.deepEqual(recordBlocks(null), []);
});

test('a record written without headings still comes back in workable pieces', () => {
    const flat = Array.from({ length: 8 }, (_, i) =>
        `20:${String(i * 3).padStart(2, '0')} something happened number ${i} and it mattered.`).join('\n\n');
    // No headings to split on, so the window does it — and nothing may be lost.
    const blocks = recordBlocks(flat, { targetChars: 200 });
    assert.ok(blocks.length > 1, 'long flat text has to be cut somewhere');
    assert.ok(blocks.every(b => b.trim().length > 0));
    assert.ok(blocks.join(' ').includes('number 7'), 'nothing is lost by the split');
    // Short enough text is left as one piece rather than shredded.
    assert.deepEqual(recordBlocks('one short block'), ['one short block']);
});

test('appending keeps the document whole and spots a re-sent whole record', () => {
    const first = '## Day 1\n20:00-21:00  He told her about the letter he never sent and she did not answer him at all.';
    const second = '## Day 2\n08:00-08:10  She took the spare key and left the coffee unwashed in the sink.';

    const one = appendRecord('', first);
    assert.equal(one.record, first);
    assert.equal(one.duplicated, false);
    assert.equal(one.added, 1);

    const two = appendRecord(one.record, second);
    assert.ok(two.record.startsWith(first));
    assert.ok(two.record.includes(second));
    assert.equal(two.duplicated, false, 'a genuine continuation is not a re-send');
    assert.equal(two.added, 1);

    // The model answering with the entire document instead of the new part is
    // the one failure mode worth catching: appending it duplicates history.
    const resent = appendRecord(one.record, `${first}\n\n${second}`);
    assert.equal(resent.duplicated, true);

    // A continuation that happens to share names and places is still a continuation.
    const shared = appendRecord(one.record,
        '## Day 2\n08:00-08:10  The letter was on the table where he had left it and she read every word twice.');
    assert.equal(shared.duplicated, false);

    assert.equal(appendRecord('something', '').record, 'something');
    assert.equal(appendRecord('something', '   ').added, 0);
});

test('record stats say what the panel needs', () => {
    const record = '## Day 1\n20:00-20:30  A thing happened.\n\n## Day 2\n08:00-08:10  Another thing.';
    const stats = recordStats(record);
    assert.equal(stats.blocks, 2);
    assert.ok(stats.words > 10);
    assert.equal(stats.tokens, Math.ceil(record.trim().length / 4));
    assert.deepEqual(recordStats(''), { blocks: 0, words: 0, tokens: 0 });
});

test('countExchanges counts user turns and never returns zero', () => {
    assert.equal(countExchanges([
        { is_user: true }, { is_user: false },
        { is_user: true }, { is_user: false },
    ]), 2);

    assert.equal(countExchanges([{ is_user: false }, { is_user: false }]), 1);
    assert.equal(countExchanges([]), 0);
    assert.equal(countExchanges([{ is_user: false }]), 1);
});
