# Issue tracker: Local Markdown

Issues and specs for this repository live as Markdown files under `.scratch/`.

## Conventions

- Store one feature per directory: `.scratch/<feature-slug>/`.
- Store its specification at `.scratch/<feature-slug>/spec.md`.
- Store implementation issues individually at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Record workflow state as a `Status:` line near the top of an artifact when a workflow requires one.
- Append discussion history under a `## Comments` heading.

## Publishing

When a skill says to publish to the issue tracker, create the appropriate Markdown file under `.scratch/<feature-slug>/`, creating the feature directory when needed.

## Fetching

When a skill says to fetch a ticket, read the referenced local Markdown file. The user should normally provide its path or issue number.

## Wayfinding operations

- Store the map at `.scratch/<effort>/map.md`.
- Store each child ticket at `.scratch/<effort>/issues/NN-<slug>.md`.
- Record ticket type with `Type:` and state with `Status:`.
- Record dependencies with `Blocked by: NN, NN`.
- Select the lowest-numbered open, unblocked, and unclaimed ticket as the frontier.
- Claim a ticket by setting `Status: claimed` before working on it.
- Resolve a ticket by appending an `## Answer`, setting `Status: resolved`, and adding a context pointer to the map.
