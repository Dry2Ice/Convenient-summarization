# Convenient Summarization

A SillyTavern extension that compresses long chats without losing the parts that
matter, using SillyTavern's own prompt-exclusion flag so the conversation stays
readable while the model receives a compressed version of it.

Two documents replace the raw history:

- **The Record** — a chronology the model writes, in blocks of time. It works
  out the times from the text: real `Date`/`Time` headers from your template when
  there are any, plausible stretches of the day when there are not, and it says so
  when a time is approximate. It groups by scene rather than by message, keeps
  what carries the story and lets the rest go, and never rewrites or reorders
  history. When it grows past its budget the model condenses the whole document
  itself, keeping the turning points and the time blocks.
- **Current Summary** — the story bible. The model already receives the
  character card, the record and the last exchanges in full, so the summary
  carries only what none of them does: the decisive events and what they
  changed, who these characters turned out to be in this story, how the
  relationships actually work and what shifted them, where the power sits, who
  knows and hides what, and everything still in play. Sections: Core Memories, Key
  Events & Consequences, Character Truths, Relationship Dynamics, Secrets &
  Knowledge, Open Threads, Motifs & References. Both documents are hand-editable.

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

1. **Record.** Everything older than the raw tail is sent to the model in
   batches. Every message arrives numbered and labelled with the exchange it
   belongs to (`[#42 · exchange 21 · reply]`), so the model can see which reply
   answers which request, and the opening message is marked as the one with no
   request before it. What comes back is appended to the record as new time
   blocks, written in the model's own words.

   There is no line format and nothing is parsed or rejected afterwards. That is
   deliberate: when the record was one line per message, it became a compressed
   transcript — a sentence for every gesture, and almost never a key event. The
   model is asked instead to group by scene, keep what carries the story, and let
   the rest go, in whatever shape reads best.

   Times are the model's to work out: real Date/Time/Location headers from your
   template when the messages carry them, plausible stretches of the day when they
   do not, approximate where it must guess. An embedded conversation inside a
   message is written down by what was said in it, never by the act of typing.
   Nothing ever reorders the record, and a whole document sent back by mistake is
   caught in the log rather than appended twice.

   Every batch is sent with three labelled parts, because a document that is being
   continued has to be continued from the right place:

   - **The record so far** — the end of it, whole blocks only, so the model copies
     the shape instead of inventing one.
   - **The seam** — the last few already-recorded messages, marked as context and
     explicitly *not* to be written up again, so it can see exactly where the last
     pass stopped.
   - **New messages** — the only part it writes.
2. **Exclude.** Absorbed messages are marked with SillyTavern's own
   `is_system` flag — the same one its *Exclude message from prompts* button
   uses. The prompt builder drops them, the chat keeps them in full, and any
   single message can be un-hidden by hand with the eye button.
3. **Story bible.** The existing summary, the record, the live edge of the story
   and the messages this run absorbed arrive as named blocks — *new messages*,
   *the seam*, *the record*, *recent exchanges* — under an instruction that says
   what each label means. A revision that comes back a fraction of the length of the
   summary it replaces is treated as a failure: the old summary is kept, because
   a stub would throw away everything the record preserves.
4. **Lorebook.** Optional pass that extracts permanent world facts from the
   record, walked block by block.
5. **Inject.** Before the history: the emotional anchors and the archive. After
   the history: key events, who these characters are, how the relationships work,
   secrets and knowledge, and what is still in play. Everything is bounded by the
   one injection ceiling.

## Settings worth knowing

| Setting | What it does |
| --- | --- |
| Keep last N messages raw | The live tail. Never archived, never excluded, whatever the archive says. Raising it brings those messages back into the prompt immediately. This is the biggest lever on how hard the chat compresses. |
| Everything injected, hard ceiling | The one number that decides the size of every request. The durable story memory is kept first, the world facts are sacrificed first. |
| Record when N unrecorded messages accumulate | The auto-trigger for a run. |
| Messages per record request | How many new messages go into one record request. Larger batches keep the time ranges continuous; smaller ones survive a provider that refuses long requests. |
| Archived messages shown as the seam | How many already-absorbed messages are shown to both stages as the point where the last pass stopped. 6 is enough to see the join; 0 turns the seam off. |
| Exclude archived messages from the AI prompt | Uses SillyTavern's own flag. Messages stay readable in the chat. |
| My requests: max output tokens | The output limit for archival requests only. The chat's own limit is never touched. 0 sends no override. |
| Give up on one request after | Wall-clock limit for a single request. A request still running after this is cut off, reported and retried instead of hanging the run. 0 removes the limit. |
| Stream archival requests | On by default. Keeps a long generation alive behind a proxy that cuts off requests producing nothing, and shows the arriving characters so a slow run is visibly a working one. Frames are read in whatever shape the provider sends them; a provider that ignores streaming still works. |
| My requests: temperature / top p | One setting for both stages, 0.6 and 0.8 by default. Both stages restate material in a fixed format, so they sample the same way; top p 1 lets the model reach any token in the tail, which is where stray fragments come from. |
| Message headers | Auto-detect reads Date/Time/Location in either `Key: value` or markdown-table form. Turn it on if your template carries them and detection still says no. |
| Retry attempts / Delay between retries | How often a failed or empty request is retried, and how long the pause is. The status line counts the pause down. |
| View Story Bible / View Record | Both panels are hand-editable. A saved summary is what the next run revises, and it can be rolled back. |
| Reset & Re-absorb | Discards the record, the story bible and the lorebook, releases every message, and starts recording from scratch. |
| Rollback Summary | Restores the previous story bible and the record, and releases the messages recorded after it. |

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
- *the backend refused this material* — its filter stopped the request before
  any text came back. That backend will not archive this chat; point
  summarization at another endpoint.
- *the backend was temporarily unable to serve the request* — a free or relayed
  connection that could not route the call at that moment. Nothing is wrong with
  the request; it usually works on a later attempt.
- *rejected the request as too large* — lower the recent-answer or record budget,
  or the output limit.
- *the backend refused the request itself* — a connection or key problem, not a
  prompt problem.
- *answered with an error and no text* — anything else the provider reported
  inside a successful response. Its own words are always shown, and the status,
  endpoint and model are written to the console for that attempt.
- *the request did not fit* — the record and the live edge are cut to
  what the window can take after the instructions, and the stage is retried at
  half the material if that is still not enough. The status line names the
  budgets it settled on.

Archival requests use whatever connection the chat is on, unless *send archival
requests to my own endpoint* is turned on. A chat connection that is a free tier
or a relay is the usual reason a run fails for no reason the prompt can be
blamed for, so the last word of a backend error says so.

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
