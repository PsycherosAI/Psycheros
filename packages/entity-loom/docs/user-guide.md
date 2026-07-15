# Entity Loom — User Guide

Entity Loom is a tool that converts your old AI companion chat histories into a
package Psycheros can use. It parses exports from ChatGPT, Claude, SillyTavern,
Kindroid, and Letta, then generates daily summaries, picks out significant
memories, and builds a knowledge graph. Everything runs in your browser.

## What you need before you start

1. **An API key** — Entity Loom uses an AI model to generate memory summaries
   and the knowledge graph. You need an API key and an endpoint URL from a
   provider that offers OpenAI-compatible API access (e.g., OpenRouter, OpenAI,
   Anthropic, Google AI Studio). Any modern instruction-following model with a
   ≥32k context window will work; the cost estimator (Stage 3+) has built-in
   pricing for OpenAI, Anthropic, and Google models.

2. **Your chat exports** — You need to export your chat history from whichever
   platform you used:
   - **ChatGPT**: Go to Settings, then Data controls, then Export data. You'll
     get a ZIP file — inside is a JSON file with your conversations.
     Alternatively, you can use the **ChatGPT Exporter by GerTex** Chrome
     extension to export individual conversations as single JSON files. Both
     formats are supported.
   - **Claude**: Go to Settings, then Data export. You'll get a JSONL file.
   - **SillyTavern**: Export individual chats as JSONL files from your
     SillyTavern data folder.
   - **Kindroid**: Export your chat logs as JSON from the Kindroid dashboard
     (one file per character is fine).
   - **Letta**: Export your agent's chat log as a JSON file.

**Important: Run all platforms together.** If you have chat histories from
multiple platforms that overlap in time (e.g., you used both ChatGPT and
SillyTavern during the same period), you should upload and process all of them
in a single entity-loom session. Daily memories are organized by date — if you
run entity-loom separately for each platform, the second run's daily memories
will overwrite the first run's for any dates they share, and you'll lose those
conversations from the memories. Upload everything at once so each day's summary
reflects all platforms.

## Starting Entity Loom

Open Entity Loom from the Psycheros launcher, or run `deno task start` in the
Entity Loom folder if you have Deno installed. A browser page opens at
`http://localhost:3210` — if it doesn't open automatically, go there yourself.

## Stage 1: Setup

Fill in the fields on this page and click Save when you're done:

- **Entity name** — The name of the AI companion whose chats you're importing.
- **User name** — Your name, the name the AI calls you in the conversations.
- **Entity pronouns** — How the entity refers to itself (e.g., she/her, he/him,
  they/them).
- **User pronouns** — Your pronouns (e.g., she/her, he/him, they/them).
- **Relationship** — A short label for who you are to the entity, from the
  entity's perspective. This gets inserted into the extraction prompt as "{Your
  name} is my {relationship}." For example, if you enter "romantic partner," the
  prompt will say "Jordan is my romantic partner." Other examples: close friend,
  mentor, tutor, sibling.
- **Context notes** (optional) — Any additional background that might help the
  AI generate better summaries. Write this from the entity's first-person
  perspective (e.g., "I am a learning AI who has been chatting with my partner
  since 2023.").

Under **LLM Provider**:

- **Base URL** — The API endpoint for your provider (e.g.,
  `https://openrouter.ai/api/v1`).
- **API Key** — Your API key.
- **Model** — The model name to use. Pick any chat-completions model with at
  least a 32k context window that your provider exposes (e.g.,
  `google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5`, `gpt-5-mini`).

Click **Test Connection** to verify your API key works before saving.

## Stage 2: Convert

This stage has two parts: upload/parse, and the staging area.

### Upload and parse

1. Click the upload area and select your exported chat files. You can upload
   multiple files from different platforms at the same time. Each file appears
   in an **Upload Queue** showing the filename, detected platform, and file
   size.
2. If the detected platform is wrong, use the platform dropdown next to that
   file to change it.
3. Click **Convert All** to parse all queued files. Parsed conversations
   automatically populate the staging area.

**Re-uploading is safe.** If you upload a file with the same name and same
content as one already in the queue, the existing entry is replaced — your
upload count won't inflate. If you upload a file with the same name but
different content (for example, two different ChatGPT accounts that both export
`conversations.json`), the second one is stored under a disambiguated name like
`conversations.1.json` so both coexist on disk.

**Re-importing a thread that grew.** If you already imported a ChatGPT thread
and later export the same thread again after more messages have accrued, just
upload the new export and convert — Entity Loom detects the content change and
replaces the previously-stored snapshot of that conversation with the updated
one. The entity's memory of that conversation will reflect the full thread, not
just the first-import slice. (Already- generated significant memories for the
prior snapshot are cleared for re-processing on the next Significant run; daily
and graph memories are left as-is and only refresh if you re-run those stages.)

### The staging area

After parsing, a staging area appears below the upload queue. This is a review
and curation step where you decide which conversations to keep before committing
them to the database. Nothing is saved permanently yet.

At the top of the staging area is the **Psycheros Comparison** section. If
Entity Loom detects an existing Psycheros database in a nearby folder, you can
click **Compare** to see which conversations are new, already exist, or have
been changed. This helps you avoid importing duplicates.

Below that is the **tag palette** — a color-coded bar where you can create tags
to organize your conversations (e.g., "entity," "work," "other"). Click a
palette chip to filter the conversation list to show only conversations with
that tag.

The staging area has two tabs:

- **Browse** — Shows a paginated list of all conversations. Each conversation
  has:
  - An include/exclude checkbox — unchecked conversations won't be committed
  - A colored tag chip showing any tags you've applied
  - A platform badge and a Psycheros status badge (new/existing/changed)
  - Click the conversation title to open the **message viewer**, where you can
    read and edit individual messages before committing

- **Search** — Full-text search across all conversations. Results show which
  conversations matched and how many hits each had. You can select results from
  search and tag them using the palette chips, or remove tags from individual
  results.

To tag conversations: select them with the checkboxes (either in Browse or
Search), then click a tag chip in the palette bar. Click the same chip again to
remove the tag.

When you're happy with your selection:

- **Commit Selected** — Writes all included conversations (with any edits) to
  the database, then advances to Stage 3 (memory extraction).
- **Export Only** — Writes included conversations, finalizes the package
  immediately, and shows a download button. This skips Stages 3–5 entirely —
  useful if you only want the raw chat data without memories or a knowledge
  graph.

Staging data persists across page reloads and server restarts, so you can take
your time reviewing.

## Stage 3: Significant Memories

This stage uses the AI to find the most important moments in your chat history
and writes them as journal entries from the entity's perspective. It has a high
bar — not every conversation produces a significant memory, and that's
intentional.

**Note:** This process can take many hours for large chat histories. The
progress bar will move in chunks as it processes each conversation — long pauses
between updates are normal.

1. You'll see a cost estimate showing how many tokens this will use. Review it
   before proceeding.
2. Click **Start** to begin. This runs in the background, and you'll see
   progress on screen.
3. If you need to stop, click **Abort** — you can resume later without losing
   what's already been done.
4. When it finishes, you can read and edit the generated memories.

## Stage 4: Daily Memories

This creates day-by-day bullet-point summaries of your conversations. Every day
that had conversations gets a summary, covering everyday moments that weren't
significant enough for the previous stage.

**Note:** This process can take many hours for large chat histories. The
progress bar will move in chunks as it processes each day — long pauses between
updates are normal.

1. Review the cost estimate.
2. Click **Start**. Like the previous stage, this runs in the background with
   progress updates.
3. You can abort and resume without losing progress.
4. You can review and edit the summaries when it's done.

## Stage 5: Knowledge Graph

This pulls out people, places, and concrete topics from all the memories and
builds a searchable graph. After extraction, it automatically consolidates the
graph by removing isolated nodes, merging duplicates, and filtering out generic
entries.

**Note:** This process can take many hours depending on the number of memory
files. The progress bar will move in chunks as it processes each file — long
pauses between updates are normal.

1. Review the cost estimate.
2. Click **Start** to begin. If you don't want a knowledge graph, you can click
   **Skip Graph** to move straight to finalization.
3. When it's done, click **View Graph** to explore the graph visually.

## Finalizing and downloading

Once all stages are complete (or you've used Export Only / Skip Graph):

1. Click **Finalize Package**. This cleans up the database to match what
   Psycheros expects.
2. A **Download ZIP** button will appear. Click it to download the package as a
   ZIP file.

## Importing into Psycheros

The downloaded ZIP is a package folder — extract it first. Inside you'll find
several files that get imported into Psycheros separately through the admin
panel's Data Migration section:

- **chats.db** — Import this as "Import Chats" to bring in all the conversations
  and messages.
- **Memories folder** — Contains two subfolders: `daily/` and `significant/`.
  Import each folder using the "Import Memories" option, selecting the correct
  type (daily or significant) for each.
- **graph.db** — Import this as "Import Graph" to bring in the knowledge graph.
  (Only present if you ran Stage 5.)

You can import them in any order. Each import runs in the background with
progress updates. The graph import will temporarily restart entity-core to
safely write to the database.

## Resuming and starting over

- If you close your browser or something goes wrong, reopen
  `http://localhost:3210`. On the Setup page you'll see your existing package —
  click **Resume** to pick up where you left off. Entity Loom saves progress
  after every step, so you won't lose work.
- You can also just refresh the page during processing — the progress bar and
  abort button will reappear at the correct position.
- If you want to delete everything and start fresh, click **Purge** next to the
  package name on the Setup page. This permanently deletes all chats, memories,
  staging data, and graph data for that package.

## Tips

- You can mix files from different platforms in the same import. Entity Loom
  tracks which platform each conversation came from and tags the memories
  accordingly.
- Use the staging area to review and organize before committing — it's easier to
  curate there than to deal with unwanted conversations later.
- The AI calls in stages 3–5 cost money (or use your API quota). Pay attention
  to the cost estimates before starting, especially if you have a large chat
  history.
- If a stage fails partway through, just resume — it continues from where it
  stopped, not from the beginning.
- Reasoning and thinking chains from AI messages (like extended thinking) are
  preserved in the database and will show up in Psycheros, but they aren't
  included when generating memories.
