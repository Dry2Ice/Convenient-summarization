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
   batches and validated before it is committed. Every message arrives numbered
   and labelled with the exchange it belongs to (`[#42 · exchange 21 · reply]`),
   so the model can see which reply answers which request, and the opening
   message is marked as the one with no request before it. The record has to bring
   every one of those numbers back: a batch that drops more than a fifth of its
   messages is rejected rather than committed, because a message the record skips
   is lost from the prompt and the record at once. A refusal, prose without
   timestamps or a missing index holds the watermark where it is.
2. **Exclude.** Absorbed messages are marked with SillyTavern's own
   `is_system` flag — the same one its *Exclude message from prompts* button
   uses. The prompt builder drops them, the chat keeps them in full, and any
   single message can be un-hidden by hand with the eye button.
3. **Summary.** The existing summary, the new archive lines and the live edge of
   the story are merged into a revised summary. This is the largest request the
   extension makes, so it is fitted to the context window *after* the
   instructions have taken their share, and if the backend still says the input
   is too long the material is halved and the request is rebuilt rather than
   repeated unchanged. A revision that comes back a fraction of the length of the
   summary it replaces is treated as a failure: the old summary is kept, because
   a stub would throw away everything the archive preserves.
4. **Lorebook.** Optional pass that extracts permanent world facts from the
   archive.
5. **Inject.** Before the history: the emotional anchors and the archive. After
   the history: causes, emotional landscape, character states, active secrets,
   open threads and the world facts. Both blocks are token-budgeted.

## Settings worth knowing

| Setting | What it does |
| --- | --- |
| Keep last N messages raw | The live tail. Never archived, never excluded, whatever the archive says. Raising it brings those messages back into the prompt immediately. This is the biggest lever on how hard the chat compresses. |
| Everything injected, hard ceiling | The one number that decides the size of every request. The state the model acts on is kept first, the world facts are sacrificed first. |
| Archive when N unarchived messages accumulate | The auto-trigger for a run. |
| Exclude archived messages from the AI prompt | Uses SillyTavern's own flag. Messages stay readable in the chat. |
| My requests: max output tokens | The output limit for archival requests only. The chat's own limit is never touched. 0 sends no override. |
| Give up on one request after | Wall-clock limit for a single request. A request still running after this is cut off, reported and retried instead of hanging the run. 0 removes the limit. |
| Stream archival requests | On by default. Keeps a long generation alive behind a proxy that cuts off requests producing nothing, and shows the arriving characters so a slow run is visibly a working one. Frames are read in whatever shape the provider sends them; a provider that ignores streaming still works. |
| Retry attempts / Delay between retries | How often a failed or empty request is retried, and how long the pause is. The status line counts the pause down. |
| View Current Summary / View Archive | Both panels are hand-editable. A saved summary is what the next run revises, and it can be rolled back. |
| Reset & Re-absorb | Discards the archive, summary and lorebook, releases every message, and re-archives from scratch. |
| Rollback Summary | Restores the previous summary and releases the messages absorbed after it. |

Slash commands: `/summarize`, `/clearsummary`, `/buildlorebook`, `/stop`,
`/chronicle <search>`, `/lorebook <search>`.

The Context budget panel shows what the compression actually bought, including
whether it reached 2x, and says which knob to turn when it did not.

## When a run misbehaves

Every request logs its source, model, prompt size, output limit and how long it
took, and the status line shows the elapsed seconds while a request is in flight,
so a slow run is visibly different from a stuck one. An answer that comes back
empty is reported with its cause rather than as "empty response":

- *spent the whole answer budget on reasoning* — the model thought its way
  through the output limit. Raise **max output tokens**, or archive with a model
  that does not think out loud.
- *cut off by the output limit* — same cause, named from the provider's side.
- *answered with something that is not JSON* — a proxy or gateway answered
  instead of the model.
- *answered with an error* — the backend reported an error inside a successful
  response; the provider's own message is shown.
- *the request did not fit* — the archive lines and the live edge are cut to
  what the window can take after the instructions, and the stage is retried at
  half the material if that is still not enough. The status line names the
  budgets it settled on.

Everything is logged to the browser console under `[enhancedSummary]`: the source,
the model, the prompt size, the budgets, the elapsed time and the reason for
every failure. That line is the fastest way to see which of these it was.

A summary request that outgrows the context window is the failure that looks
least like a model problem: stage 1 sends a fraction of what stage 2 does, so it
succeeds and stage 2 fails identically with every model. The reason is the size
of the request, and it appears in the log as `CAPPED (window)` or
`CAPPED (share)`.

## Notes

- Nothing is written into the message text. The extension only sets a flag, so
  there is no way for it to overwrite a message you wrote.
- Answers are read from every response shape SillyTavern can return: OpenAI and
  everything it wraps into that shape, Anthropic content blocks, Cohere, Mistral,
  Google parts, Ollama and legacy completions. A working model is never reported
  as having returned nothing because its backend used another envelope.
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
