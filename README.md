# Convenient Summarization

A SillyTavern extension that compresses long chats without losing the parts that
matter, using SillyTavern's own prompt-exclusion flag so the conversation stays
readable while the model receives a compressed version of it.

Two documents replace the raw history:

- **Chronological archive** — one short line per message: what was said and
  done. Facts only, no interpretation.
- **Current Summary** — everything the archive cannot hold: feelings and subtext,
  motives and misreadings, how the relationships moved, what each character knows
  and hides, the cost of every live secret, the promises and debts still unpaid,
  and where the story is heading.

The split is what makes it cheap: neither document repeats the other, so no
context is paid for twice.

## Install

Extensions → Install from URL, or in a browser:

```
https://github.com/Dry2Ice/Convenient-summarization
```

Manual install: clone this repository into
`SillyTavern/data/default-user/extensions/Convenient-summarization` and restart
SillyTavern.

## How it works

1. **Archive.** Everything older than the raw tail is sent to the model in
   batches, one line per message, and validated before it is committed. A batch
   that refuses, rambles or loses timestamps is rejected and retried, so the
   watermark never advances over history that was not recorded.
2. **Exclude.** Absorbed messages are marked with SillyTavern's own
   `is_system` flag — the same one its *Exclude message from prompts* button
   uses. The prompt builder drops them, the chat keeps them in full, and any
   single message can be un-hidden by hand with the eye button.
3. **Summary.** The existing summary, the new archive lines and the live edge of
   the story are merged into a revised summary.
4. **Lorebook.** Optional pass that extracts permanent world facts from the
   archive.
5. **Inject.** Before the history: the emotional anchors and the archive. After
   the history: causes, emotional landscape, character states, active secrets,
   open threads and the world facts. Both blocks are token-budgeted.

## Settings worth knowing

| Setting | What it does |
| --- | --- |
| Keep last N messages raw | The live tail. Never archived, never excluded, whatever the archive says. Raising it brings those messages back into the prompt immediately. |
| Archive when N unarchived messages accumulate | The auto-trigger for a run. |
| Exclude archived messages from the AI prompt | Uses SillyTavern's own flag. Messages stay readable in the chat. |
| View Current Summary / View Archive | Both panels are hand-editable. A saved summary is what the next run revises, and it can be rolled back. |
| Reset & Re-absorb | Discards the archive, summary and lorebook, releases every message, and re-archives from scratch. |
| Rollback Summary | Restores the previous summary and releases the messages absorbed after it. |

Slash commands: `/summarize`, `/clearsummary`, `/buildlorebook`, `/stop`,
`/chronicle <search>`, `/lorebook <search>`.

## Notes

- Nothing is written into the message text. The extension only sets a flag, so
  there is no way for it to overwrite a message you wrote.
- Per-chat state is kept separately for every chat and group.
- Archived messages whose chat file lost its flag are re-marked from the
  watermark; a deleted message shifts the watermark back onto the last message
  the archive really covers.
- Reasoning leaked into a model's visible output (`<think>...</think>`) is
  stripped before anything is stored.
- A provider-side content filter cannot be bypassed by a prompt. If archiving
  fails on such a provider, point the separate summarization endpoint at another
  one.

## Development

```
npm test
```

The pure logic lives in `core.js` and is covered by `node:test`; `index.js` holds
the SillyTavern wiring. No build step, no dependencies.
